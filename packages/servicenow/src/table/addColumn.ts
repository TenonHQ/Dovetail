/**
 * Add ONE column to an EXISTING ServiceNow table — headless, via the server-side
 * scope-aware `createRecord` op. Creating a column is a `sys_dictionary` insert;
 * the Dovetail core `createRecord` Scripted REST op switches the executing user's
 * app scope AND update set server-side, inserts, and restores both — so the column
 * is owned by the right app and the insert is captured in the right update set,
 * WITHOUT logging into the instance and replaying a Studio form.
 *
 * History: this replaced a `sys_db_object.do` form-login replay. That workaround
 * existed because a *Table API* insert into sys_dictionary 500s for a scoped column
 * (wrong session scope on a scoped table). The scope-aware `createRecord` op does
 * NOT 500 — it creates the scoped column cleanly. Validated live 2026-07-08 on
 * tenonworkshed: physical column materialised, correct scope, `mandatory` +
 * `default` set, and Dictionary + Field Label `sys_update_xml` rows captured in the
 * update set.
 *
 * The scope arg passed to `createRecord` is the scope NAME (e.g. "x_cadso_core"),
 * not the sys_scope sys_id — the server-side changeScope matches on the scope name.
 * A column always belongs to its table's scope, so the name is resolved from the
 * table; an explicit `scope` override must match it.
 *
 * SIZING THE PHYSICAL COLUMN. A max_length carried on the INSERT sets the dictionary
 * row but NOT the column ServiceNow actually builds — it materialises at the platform
 * default regardless. An insert declaring string(4000) therefore leaves a varchar(255)
 * behind a row that claims 4000, and every value over 255 chars is SILENTLY TRUNCATED.
 * Only an UPDATE to max_length fires the physical ALTER. So the column is inserted
 * WITHOUT max_length — the row then reports the default, which genuinely matches the
 * column that was built — and then updated to the requested length, a real transition
 * that fires the ALTER and leaves the column the size it claims. Requesting the default
 * needs no update at all: row and column already agree. Verified live 2026-07-14 on
 * tenonworkshed by round-tripping an over-length value, not by reading metadata back.
 *
 * After the insert it READS THE COLUMN BACK from sys_dictionary BY THE RETURNED
 * sys_id (not by element — ServiceNow can normalise the element server-side) to
 * prove THIS insert landed, and asserts max_length matches what was asked for — a
 * read-back that omits max_length cannot tell a correctly-sized column from a lying
 * one. A pre-check skips a column that already exists so a re-run never inserts a
 * duplicate dictionary row. ES6 only, no optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";
import { ColumnSpec, normalizeColumns } from "./buildTableSave";

var SYS_ID = /^[0-9a-f]{32}$/i;

/** Patch max_length on a sys_dictionary row, captured in the given update set. */
async function setMaxLength(
  client: ServiceNowClient,
  columnSysId: string,
  updateSetSysId: string,
  length: string,
): Promise<void> {
  await client.claude.pushWithUpdateSet({
    update_set_sys_id: updateSetSysId,
    table: "sys_dictionary",
    record_sys_id: columnSysId,
    fields: { max_length: length },
  });
}

export interface AddColumnParams {
  /** REST client for table/scope resolution, the insert op, and the read-back verify. */
  client: ServiceNowClient;
  /** Existing table — its name ("x_cadso_journey") OR its sys_db_object sys_id. */
  table: string;
  /** The single column to add. `name` (the element) is optional; derived from label when omitted. */
  column: ColumnSpec;
  /** Scope name or sys_scope sys_id. Must match the table's own scope (a column lives there). */
  scope?: string;
  /** Update set sys_id to capture the insert into. REQUIRED on the live path (dry-run doesn't need it). */
  updateSetSysId?: string;
  /** Emit diagnostic detail in the result note. */
  debug?: boolean;
  /** Plan only — no writes. Pure + deterministic. */
  dryRun?: boolean;
}

export interface AddColumnResult {
  status: "created" | "dry-run" | "failed" | "skipped";
  /** The table's name (resolved; echoes the input on dry-run). */
  table: string;
  /** sys_db_object sys_id ("" on dry-run / when unresolved). */
  tableSysId: string;
  /** The dictionary element (column name) — as stored on the read-back row when live. */
  element: string;
  /** The column's display label. */
  label: string;
  /** Resolved ServiceNow internal_type (friendly -> internal). */
  internalType: string;
  /** sys_id of the sys_dictionary row (the insert's, or the existing row's on "skipped"). */
  columnSysId: string;
  /** Update set the write was captured into ("" on dry-run). */
  updateSetSysId: string;
  /** True only when the column was READ BACK from sys_dictionary (created), or already present (skipped). */
  verified: boolean;
  /** Human-readable note (success summary, the read-back result, or the failure body). */
  note: string;
}

/**
 * Derive the dictionary element (column name) from a label the way Studio does for
 * a scoped table: lower-case, every run of non-alphanumerics -> a single
 * underscore, trimmed. Scoped custom columns are NOT u_-prefixed, so "URL" -> "url".
 * Pass `column.name` explicitly for anything non-trivial.
 */
export function deriveElement(label: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  // Single linear pass: lower-case, collapse each run of non-alphanumerics to one
  // underscore, then trim leading/trailing underscores. Deliberately NOT a regex —
  // an anchored-quantifier trim (/^_+|_+$/) is a polynomial-ReDoS on attacker-shaped
  // input (CodeQL js/polynomial-redos); a char scan is O(n).
  var lower = String(label || "").toLowerCase();
  var collapsed = "";
  var prevUnderscore = false;
  for (var i = 0; i < lower.length; i += 1) {
    var ch = lower.charAt(i);
    var isAlnum = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (isAlnum) {
      collapsed += ch;
      prevUnderscore = false;
    } else if (!prevUnderscore) {
      collapsed += "_";
      prevUnderscore = true;
    }
  }
  var start = 0;
  var end = collapsed.length;
  while (start < end && collapsed.charAt(start) === "_") start += 1;
  while (end > start && collapsed.charAt(end - 1) === "_") end -= 1;
  var e = collapsed.slice(start, end);
  if (!e)
    throw new Error(
      "add-column: cannot derive a column name from label '" +
        label +
        "' — pass column.name.",
    );
  return e;
}

function validate(params: AddColumnParams): void {
  if (!params || typeof params !== "object")
    throw new Error("add-column: params object required.");
  if (!params.client) throw new Error("add-column: client is required.");
  if (!params.table || !String(params.table).trim())
    throw new Error("add-column: table is required.");
  if (!params.column || typeof params.column !== "object")
    throw new Error("add-column: column is required.");
}

/** Resolve the table by name or sys_id; returns its name, sys_id, and sys_scope sys_id. */
async function resolveTable(
  client: ServiceNowClient,
  table: string,
): Promise<{ name: string; sysId: string; scopeSysId: string }> {
  var query = SYS_ID.test(table) ? "sys_id=" + table : "name=" + table;
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_db_object",
    query,
    { limit: 1, fields: ["sys_id", "name", "sys_scope"] },
  );
  if (rows.length === 0) {
    throw new Error(
      "add-column: table '" + table + "' not found in sys_db_object.",
    );
  }
  return {
    name: fieldToString(rows[0].name) || table,
    sysId: fieldToString(rows[0].sys_id),
    scopeSysId: fieldToString(rows[0].sys_scope),
  };
}

/** Resolve a sys_scope sys_id to its scope NAME (e.g. "x_cadso_core"). */
async function resolveScopeName(
  client: ServiceNowClient,
  scopeSysId: string,
): Promise<string> {
  if (!scopeSysId) return "";
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_scope",
    "sys_id=" + scopeSysId,
    { limit: 1, fields: ["scope"] },
  );
  return rows.length > 0 ? fieldToString(rows[0].scope) : "";
}

export async function addColumn(
  params: AddColumnParams,
): Promise<AddColumnResult> {
  validate(params);
  var client = params.client;

  // Normalize the single column (validates label, resolves the friendly type to an
  // internal type, requires a target for a reference column). mandatory/default are
  // read straight off the raw ColumnSpec below — they pass through untransformed.
  // normalizeColumns is shared with create-table and prefixes its errors "createTable:",
  // which reads as the wrong command when it surfaces from add-column — re-prefix it.
  var normalized;
  try {
    normalized = normalizeColumns([params.column]);
  } catch (e) {
    var reason = e && (e as Error).message ? (e as Error).message : String(e);
    throw new Error("add-column: " + reason.replace(/^createTable:\s*/, ""));
  }
  var col = normalized[0];
  var element = deriveElement(col.label, params.column.name);

  if (params.dryRun) {
    return {
      status: "dry-run",
      table: params.table,
      tableSysId: SYS_ID.test(params.table) ? params.table : "",
      element: element,
      label: col.label,
      internalType: col.type,
      columnSysId: "",
      updateSetSysId: params.updateSetSysId ? params.updateSetSysId : "",
      verified: false,
      note:
        "dry-run: no write. Would add column '" +
        element +
        "' (" +
        col.type +
        ") to '" +
        params.table +
        "' via a scope-aware sys_dictionary insert, captured into update set " +
        (params.updateSetSysId ? params.updateSetSysId : "(none provided)") +
        ", then read it back.",
    };
  }

  // ---- LIVE PATH ------------------------------------------------------------
  // Require an explicit update set so the schema change is captured in a KNOWN
  // set (the AC), matching the create-record contract. dry-run does not need one.
  if (!params.updateSetSysId || !params.updateSetSysId.trim()) {
    throw new Error(
      "add-column: updateSetSysId is required on the live path so the sys_dictionary " +
        "insert is captured in a known update set (dry-run does not need one).",
    );
  }

  var resolved = await resolveTable(client, params.table);
  var scopeName = await resolveScopeName(client, resolved.scopeSysId);
  if (!scopeName) {
    throw new Error(
      "add-column: could not resolve the scope name for table '" +
        resolved.name +
        "' (sys_scope " +
        (resolved.scopeSysId || "(none)") +
        ") — needed to scope the insert correctly.",
    );
  }
  // A column lives in its table's scope. An explicit override must match it (by name
  // or sys_id); we never write a column into a scope other than its table's.
  if (params.scope && params.scope.trim()) {
    var override = params.scope.trim();
    if (override !== scopeName && override !== resolved.scopeSysId) {
      throw new Error(
        "add-column: --scope '" +
          override +
          "' does not match table '" +
          resolved.name +
          "' scope '" +
          scopeName +
          "' — a column must live in its table's scope. Omit --scope or set it to '" +
          scopeName +
          "'.",
      );
    }
  }

  // max_length is deliberately NOT sent on the insert — see the sizing step below.
  // Reference (and date) columns carry no max_length at all.
  var wantLength = col.type === "reference" ? "" : col.maxLength;

  // Idempotency: if the column already exists, skip the insert (never duplicate a
  // dictionary row on a re-run). Matched by name+element — the element IS the column's
  // identity; a label is not unique, so matching on one would silently skip a genuinely
  // different column.
  var existing = await client.table.query<Record<string, unknown>>(
    "sys_dictionary",
    "name=" + resolved.name + "^element=" + element,
    { limit: 1, fields: ["sys_id", "element", "internal_type", "max_length"] },
  );
  if (existing.length > 0) {
    var existingSysId = fieldToString(existing[0].sys_id);
    var existingElement = fieldToString(existing[0].element) || element;
    var existingType = fieldToString(existing[0].internal_type);
    var existingLength = fieldToString(existing[0].max_length);
    // "Already there" is not the same as "already what you asked for". Report the column
    // that EXISTS, not the one that was requested, and refuse to call a mismatched column
    // verified — silently green-lighting a column of the wrong type or size is the same
    // failure as shipping one that lies about its length.
    var drift: Array<string> = [];
    if (existingType && existingType !== col.type) {
      drift.push(
        "type is '" + existingType + "', not the requested '" + col.type + "'",
      );
    }
    if (wantLength && existingLength && existingLength !== wantLength) {
      drift.push(
        "max_length is " + existingLength + ", not the requested " + wantLength,
      );
    }
    return {
      status: "skipped",
      table: resolved.name,
      tableSysId: resolved.sysId,
      element: existingElement,
      label: col.label,
      internalType: existingType || col.type,
      columnSysId: existingSysId,
      updateSetSysId: params.updateSetSysId,
      verified: drift.length === 0,
      note:
        drift.length === 0
          ? "Column '" +
            existingElement +
            "' already exists on " +
            resolved.name +
            " (sys_dictionary " +
            existingSysId +
            ") and matches the requested spec — nothing to do."
          : "Column '" +
            existingElement +
            "' already exists on " +
            resolved.name +
            " (sys_dictionary " +
            existingSysId +
            ") but DOES NOT match what was requested: " +
            drift.join("; ") +
            ". Nothing was written. Reconcile the column on the instance — add-column " +
            "will not alter an existing column.",
    };
  }

  var fields: Record<string, string> = {
    name: resolved.name,
    column_label: col.label,
    element: element,
    internal_type: col.type,
    mandatory: params.column.mandatory === true ? "true" : "false",
    default_value:
      typeof params.column.default === "string" ? params.column.default : "",
    active: "true",
    sys_scope: resolved.scopeSysId,
  };
  // Reference columns carry the target table NAME (not a sys_id) in `reference`.
  if (col.reference) fields.reference = col.reference;

  var created: { sys_id: string; [k: string]: unknown } | undefined;
  try {
    created = await client.claude.createRecord({
      table: "sys_dictionary",
      fields: fields,
      scope: scopeName,
      update_set_sys_id: params.updateSetSysId,
    });
  } catch (e) {
    return failure(
      resolved,
      col,
      element,
      params.updateSetSysId,
      "sys_dictionary insert failed: " +
        (e && (e as Error).message ? (e as Error).message : String(e)),
    );
  }
  var columnSysId = fieldToString(created && created.sys_id);
  if (!columnSysId) {
    return failure(
      resolved,
      col,
      element,
      params.updateSetSysId,
      "createRecord returned no sys_id — the insert may not have landed; check the instance.",
    );
  }

  // SIZE THE PHYSICAL COLUMN. A max_length carried on the INSERT sets the dictionary
  // row but NOT the column ServiceNow actually builds — it materialises at the platform
  // default regardless, so an insert declaring 4000 leaves a varchar(255) behind a row
  // that claims 4000, and every value over 255 chars is silently truncated. Only an
  // UPDATE to max_length fires the physical ALTER. Hence: insert WITHOUT max_length (the
  // row then reports the default, which does match the column that was built), then
  // update to the requested length — a real transition, so the ALTER fires and the
  // column ends up the size it claims. When the requested length IS the default there is
  // nothing to change and nothing to fix: row and column already agree.
  // Verified live 2026-07-14 on tenonworkshed by round-tripping an over-length value.
  //
  // The column now EXISTS on the instance, so from here on a thrown error would leave the
  // caller with no idea what landed. Every step below reports through the same structured
  // `failed` result as the insert path — never a bare throw — so the CLI's exit code and
  // the returned columnSysId still tell you exactly what state the instance is in.
  var rows: Array<Record<string, unknown>>;
  try {
    rows = await client.table.query<Record<string, unknown>>(
      "sys_dictionary",
      "sys_id=" + columnSysId,
      {
        limit: 1,
        fields: ["sys_id", "element", "internal_type", "max_length"],
      },
    );
    if (rows.length > 0 && wantLength) {
      var builtLength = fieldToString(rows[0].max_length);
      if (builtLength !== wantLength) {
        await setMaxLength(
          client,
          columnSysId,
          params.updateSetSysId,
          wantLength,
        );
        rows = await client.table.query<Record<string, unknown>>(
          "sys_dictionary",
          "sys_id=" + columnSysId,
          {
            limit: 1,
            fields: ["sys_id", "element", "internal_type", "max_length"],
          },
        );
      }
    }
  } catch (e) {
    return failure(
      resolved,
      col,
      element,
      params.updateSetSysId,
      "column " +
        columnSysId +
        " was created, but sizing/verifying it failed: " +
        (e && (e as Error).message ? (e as Error).message : String(e)) +
        " — the column EXISTS but may not be the size it was declared, so treat it as " +
        "unsafe to write to until it is checked on the instance.",
      columnSysId,
    );
  }

  // The read-back proves THIS insert landed (by sys_id, not element — ServiceNow can
  // normalise the element server-side) AND that the column is the size it was asked to
  // be. A read-back that omits max_length cannot tell a correctly-sized column from one
  // that will silently eat data, which is exactly how that bug survived.
  var verified = rows.length > 0;
  var actualElement = verified ? fieldToString(rows[0].element) : element;
  var readBackType = verified ? fieldToString(rows[0].internal_type) : "";
  var readBackLength = verified ? fieldToString(rows[0].max_length) : "";

  if (verified && wantLength && readBackLength !== wantLength) {
    return failure(
      resolved,
      col,
      element,
      params.updateSetSysId,
      "column '" +
        actualElement +
        "' materialised but max_length read back as '" +
        readBackLength +
        "', not the requested '" +
        wantLength +
        "' — the physical column is NOT the size it was declared, so values over the " +
        "real limit would be silently truncated. Fix the column on the instance before " +
        "writing to it.",
      columnSysId,
    );
  }

  if (!verified) {
    return failure(
      resolved,
      col,
      element,
      params.updateSetSysId,
      "createRecord returned sys_id " +
        columnSysId +
        " but no sys_dictionary row was found on read-back — the column may not have " +
        "materialised; check the instance.",
      columnSysId,
    );
  }

  var note =
    "Added column '" +
    actualElement +
    "' (" +
    col.type +
    ") to " +
    resolved.name +
    " — verified present in sys_dictionary, captured into update set " +
    params.updateSetSysId +
    (actualElement !== element
      ? " (NOTE: ServiceNow stored element '" +
        actualElement +
        "', not the requested '" +
        element +
        "')"
      : "") +
    (readBackType && readBackType !== col.type
      ? " (NOTE: internal_type read back as '" + readBackType + "')"
      : "") +
    ".";
  if (params.debug) {
    note +=
      " [debug: columnSysId=" +
      columnSysId +
      " scopeName=" +
      scopeName +
      " sys_scope=" +
      resolved.scopeSysId +
      " readBackType=" +
      (readBackType || "(none)") +
      "]";
  }

  return {
    status: "created",
    table: resolved.name,
    tableSysId: resolved.sysId,
    element: actualElement,
    label: col.label,
    internalType: col.type,
    columnSysId: columnSysId,
    updateSetSysId: params.updateSetSysId,
    verified: true,
    note: note,
  };
}

/** Build a `failed` result (shared by the insert-threw and read-back-empty paths). */
function failure(
  resolved: { name: string; sysId: string },
  col: { label: string; type: string },
  element: string,
  updateSetSysId: string,
  note: string,
  columnSysId?: string,
): AddColumnResult {
  return {
    status: "failed",
    table: resolved.name,
    tableSysId: resolved.sysId,
    element: element,
    label: col.label,
    internalType: col.type,
    columnSysId: columnSysId ? columnSysId : "",
    updateSetSysId: updateSetSysId,
    verified: false,
    note: note,
  };
}
