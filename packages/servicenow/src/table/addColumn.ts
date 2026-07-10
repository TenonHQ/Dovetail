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
 * After the insert it READS THE COLUMN BACK from sys_dictionary BY THE RETURNED
 * sys_id (not by element — ServiceNow can normalise the element server-side) to
 * prove THIS insert landed. A pre-check skips a column that already exists so a
 * re-run never inserts a duplicate dictionary row. ES6 only, no optional chaining,
 * no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";
import { ColumnSpec, normalizeColumns } from "./buildTableSave";

var SYS_ID = /^[0-9a-f]{32}$/i;

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
  var normalized = normalizeColumns([params.column]);
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

  // Idempotency: if the column already exists, skip the insert (never duplicate a
  // dictionary row on a re-run). Best-effort by name+element (the value we send).
  var existing = await client.table.query<Record<string, unknown>>(
    "sys_dictionary",
    "name=" + resolved.name + "^element=" + element,
    { limit: 1, fields: ["sys_id", "internal_type"] },
  );
  if (existing.length > 0) {
    var existingSysId = fieldToString(existing[0].sys_id);
    return {
      status: "skipped",
      table: resolved.name,
      tableSysId: resolved.sysId,
      element: element,
      label: col.label,
      internalType: col.type,
      columnSysId: existingSysId,
      updateSetSysId: params.updateSetSysId,
      verified: true,
      note:
        "Column '" +
        element +
        "' already exists on " +
        resolved.name +
        " (sys_dictionary " +
        existingSysId +
        ") — nothing to do.",
    };
  }

  var fields: Record<string, string> = {
    name: resolved.name,
    column_label: col.label,
    element: element,
    internal_type: col.type,
    // Reference (and date) columns carry no max_length.
    max_length: col.type === "reference" ? "" : col.maxLength,
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

  // Read back BY sys_id — proves THIS insert landed (robust to server-side element
  // normalisation and to a pre-existing same-named column).
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_dictionary",
    "sys_id=" + columnSysId,
    { limit: 1, fields: ["sys_id", "element", "internal_type"] },
  );
  var verified = rows.length > 0;
  var actualElement = verified ? fieldToString(rows[0].element) : element;
  var readBackType = verified ? fieldToString(rows[0].internal_type) : "";

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
