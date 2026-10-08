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
 * By default a column belongs to its table's scope, so the name is resolved from the
 * table and an explicit `scope` override must match it.
 *
 * CROSS-SCOPE COLUMNS (`crossScope: true`). ServiceNow lets one app add a column to
 * another app's table — Studio with app = Journey adding a field to an Automate table
 * — and prefixes the element with the OWNING scope: `x_cadso_journey_instance_step`
 * on `x_cadso_automate_email_batch`, dictionary row owned by x_cadso_journey. This is
 * the column-ownership rule for Tenon's layered apps, so it is supported here as an
 * explicit opt-in: `scope` names the column's scope, `crossScope: true` acknowledges it
 * differs from the table's. The insert runs through the same scope-aware op switched
 * to the COLUMN's scope, so the dictionary row and its update-set capture both land
 * in the column's scope. Guards, run on dry-run and live alike: the override scope
 * must exist; the table must allow new fields from other scopes
 * (`sys_db_object.alter_access`); the update set must belong to the column's scope and
 * be in progress.
 * The element is sent already prefixed (`<scope>_<name>`; an already-prefixed name
 * is accepted as-is) and the element ServiceNow actually stored is read back and
 * reported, together with a `sys_scope` assertion on the read-back row.
 *
 * DESIGN ACCESS. Since the Zurich bw40 hotfix the platform UI also requires a
 * `sys_scope_design_access` record (source = the column's scope, target = the table's)
 * before one app may author in another's tables. The headless insert here does not hit
 * that check, so a missing record does not block the column — but it is FLAGGED on every
 * cross-scope result (`designAccess`), because the next UI edit of the column, and the
 * target instance, will. `ensureDesignAccess: true` creates it first, in the same update
 * set (see ./designAccess.ts).
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
import { ensureDesignAccess, findDesignAccess } from "./designAccess";
import {
  closedUpdateSetMessage,
  isUpdateSetOpen,
  readUpdateSet,
} from "./updateSetGuard";

var SYS_ID = /^[0-9a-f]{32}$/i;

/** Patch dependent_on_field on a sys_dictionary row, captured in the given update set. */
async function setDependentOnField(
  client: ServiceNowClient,
  columnSysId: string,
  updateSetSysId: string,
  dependentOnField: string,
): Promise<void> {
  await client.claude.pushWithUpdateSet({
    update_set_sys_id: updateSetSysId,
    table: "sys_dictionary",
    record_sys_id: columnSysId,
    fields: { dependent_on_field: dependentOnField },
  });
}

/** The sys_dictionary columns every read-back asks for. */
var READ_BACK_FIELDS = [
  "sys_id",
  "element",
  "internal_type",
  "max_length",
  "dependent_on_field",
  "sys_scope",
];

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
  /**
   * Scope name or sys_scope sys_id. Must match the table's own scope (a column lives
   * there) — unless `crossScope` is true, in which case it names the scope that will OWN
   * the column (e.g. "x_cadso_journey" for a Journey column on an Automate table).
   */
  scope?: string;
  /**
   * Explicit opt-in to a column owned by a different scope than its table. Requires
   * `scope`. The element is prefixed with the owning scope (`x_cadso_journey_<name>`),
   * the table must allow new fields from other scopes (sys_db_object.alter_access),
   * and the update set must belong to the column's scope and be in progress.
   */
  crossScope?: boolean;
  /**
   * Cross-scope only: create the sys_scope_design_access record (column scope -> table
   * scope) when it is missing, captured in the same update set, BEFORE the column insert.
   * Without it a missing record is only flagged on the result.
   */
  ensureDesignAccess?: boolean;
  /** Update set sys_id to capture the insert into. REQUIRED on the live path (dry-run doesn't need it). */
  updateSetSysId?: string;
  /** Emit diagnostic detail in the result note. */
  debug?: boolean;
  /** Plan only — no writes. Pure + deterministic. */
  dryRun?: boolean;
}

/** Design Access state for a cross-scope column (absent on a same-scope add). */
export interface DesignAccessFlag {
  /** Always true when reported: a cross-scope column needs the record for UI/Studio work. */
  required: true;
  /** true = record exists (or was created); false = missing; null = could not be read. */
  present: boolean | null;
  /** sys_scope_design_access sys_id ("" when missing / unknown). */
  sysId: string;
  /** Authoring scope (the column's owner). */
  sourceScope: string;
  /** Table-owning scope. */
  targetScope: string;
  /** True when THIS run created the record. */
  created: boolean;
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
  /**
   * Scope NAME that owns the column ("" on a network-free dry-run). Equals the table's
   * scope unless `crossScope` was used, in which case it is the override scope.
   */
  scope: string;
  /** sys_id of the sys_dictionary row (the insert's, or the existing row's on "skipped"). */
  columnSysId: string;
  /** Update set the write was captured into ("" on dry-run). */
  updateSetSysId: string;
  /** True only when the column was READ BACK from sys_dictionary (created), or already present (skipped). */
  verified: boolean;
  /** Human-readable note (success summary, the read-back result, or the failure body). */
  note: string;
  /** Cross-scope only: whether the Design Access record the platform UI requires exists. */
  designAccess?: DesignAccessFlag;
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

interface ResolvedTable {
  name: string;
  sysId: string;
  scopeSysId: string;
  /** sys_db_object.alter_access ("Allow new fields") — gates cross-scope columns. */
  alterAccess: string;
}

/** Resolve the table by name or sys_id; returns its name, sys_id, scope, and alter_access. */
async function resolveTable(
  client: ServiceNowClient,
  table: string,
): Promise<ResolvedTable> {
  var query = SYS_ID.test(table) ? "sys_id=" + table : "name=" + table;
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_db_object",
    query,
    { limit: 1, fields: ["sys_id", "name", "sys_scope", "alter_access"] },
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
    alterAccess: fieldToString(rows[0].alter_access),
  };
}

/** Resolve a scope by NAME or sys_id to both; empty strings when not found. */
async function resolveScope(
  client: ServiceNowClient,
  scope: string,
): Promise<{ name: string; sysId: string }> {
  var query = SYS_ID.test(scope) ? "sys_id=" + scope : "scope=" + scope;
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_scope",
    query,
    { limit: 1, fields: ["sys_id", "scope"] },
  );
  if (rows.length === 0) return { name: "", sysId: "" };
  return {
    name: fieldToString(rows[0].scope),
    sysId: fieldToString(rows[0].sys_id),
  };
}

/** Where the column will live: its owning scope, and the element it will be stored under. */
interface ColumnPlan {
  resolved: ResolvedTable;
  /** Scope NAME the insert is switched to (the column's owner). */
  scopeName: string;
  /** sys_scope sys_id stamped on the dictionary row. */
  scopeSysId: string;
  /** True when the owner differs from the table's scope. */
  crossScope: boolean;
  /** The element to insert and pre-check — scope-prefixed on a cross-scope column. */
  element: string;
  /** Cross-scope only: the Design Access state found while planning. */
  designAccess?: DesignAccessFlag;
}

/**
 * Resolve the table + decide which scope owns the column, running every scope guard.
 * Shared by the dry-run and live paths so a request that would fail live fails the
 * dry-run the same way — a dry-run that skips the guards is worse than none.
 */
async function planColumnScope(
  client: ServiceNowClient,
  params: AddColumnParams,
  element: string,
): Promise<ColumnPlan> {
  var resolved = await resolveTable(client, params.table);
  var tableScopeName = await resolveScopeName(client, resolved.scopeSysId);
  if (!tableScopeName) {
    throw new Error(
      "add-column: could not resolve the scope name for table '" +
        resolved.name +
        "' (sys_scope " +
        (resolved.scopeSysId || "(none)") +
        ") — needed to scope the insert correctly.",
    );
  }
  var override = params.scope ? params.scope.trim() : "";
  var wantsCross = params.crossScope === true;
  if (wantsCross && !override) {
    throw new Error(
      "add-column: crossScope requires --scope naming the scope that will OWN the column " +
        "(e.g. x_cadso_journey for a Journey column on an Automate table).",
    );
  }
  var sameScope =
    !override ||
    override === tableScopeName ||
    override === resolved.scopeSysId;
  if (sameScope) {
    return {
      resolved: resolved,
      scopeName: tableScopeName,
      scopeSysId: resolved.scopeSysId,
      crossScope: false,
      element: element,
    };
  }
  // The override names a scope other than the table's. Without the explicit opt-in
  // this is the classic wrong-scope mistake, so refuse — on dry-run and live alike.
  if (!wantsCross) {
    throw new Error(
      "add-column: --scope '" +
        override +
        "' does not match table '" +
        resolved.name +
        "' scope '" +
        tableScopeName +
        "' — a column lives in its table's scope. Omit --scope or set it to '" +
        tableScopeName +
        "'. To add a column OWNED by '" +
        override +
        "' (a cross-scope field, element prefixed '" +
        override +
        "_'), pass --cross-scope.",
    );
  }
  var owner = await resolveScope(client, override);
  if (!owner.name || !owner.sysId) {
    throw new Error(
      "add-column: cross-scope owner '" +
        override +
        "' was not found in sys_scope — pass the scope name (x_cadso_journey) or its sys_id.",
    );
  }
  if (resolved.alterAccess !== "true") {
    throw new Error(
      "add-column: table '" +
        resolved.name +
        "' does not allow new fields from other scopes (sys_db_object.alter_access is '" +
        (resolved.alterAccess || "(empty)") +
        "'). Enable 'Allow new fields' on the table in its own scope, or add the column " +
        "in scope '" +
        tableScopeName +
        "' instead.",
    );
  }
  if (params.updateSetSysId && params.updateSetSysId.trim()) {
    var us = await readUpdateSet(client, params.updateSetSysId.trim());
    if (!us.found) {
      throw new Error(
        "add-column: update set '" +
          params.updateSetSysId +
          "' was not found in sys_update_set.",
      );
    }
    if (us.applicationSysId !== owner.sysId) {
      throw new Error(
        "add-column: update set '" +
          (us.name || params.updateSetSysId) +
          "' does not belong to the column's scope '" +
          owner.name +
          "' — a cross-scope column is captured in an update set of the scope that OWNS " +
          "it, not the table's. Pass an update set in '" +
          owner.name +
          "'.",
      );
    }
    // A closed set would accept the column (and any Design Access record) and capture
    // neither — refuse it here, on dry-run and live alike, before anything is written.
    if (!isUpdateSetOpen(us.state)) {
      throw new Error(closedUpdateSetMessage("add-column", us));
    }
  }
  // ServiceNow stores a cross-scope element as <owner>_<name>. Send it already
  // prefixed so the pre-check, the insert, and the read-back all agree on the one
  // element; an already-prefixed name is accepted as-is.
  var prefix = owner.name + "_";
  var prefixed = element.indexOf(prefix) === 0 ? element : prefix + element;
  // Flag — never block on — the Design Access record the platform UI requires. A read
  // failure is reported as UNKNOWN (null), not as missing: a blind check is not evidence.
  var present: boolean | null = null;
  var daSysId = "";
  try {
    daSysId = await findDesignAccess({
      client: client,
      sourceScopeSysId: owner.sysId,
      targetScopeSysId: resolved.scopeSysId,
    });
    present = daSysId !== "";
  } catch (e) {
    present = null;
  }
  return {
    resolved: resolved,
    scopeName: owner.name,
    scopeSysId: owner.sysId,
    crossScope: true,
    element: prefixed,
    designAccess: {
      required: true,
      present: present,
      sysId: daSysId,
      sourceScope: owner.name,
      targetScope: tableScopeName,
      created: false,
    },
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

/**
 * The Design Access sentence appended to a cross-scope result's note ("" when none).
 * Exported for tests.
 */
export function designAccessNote(
  da: DesignAccessFlag | undefined,
  ensureRequested: boolean,
  isDryRun: boolean,
): string {
  if (!da) return "";
  var pair = "'" + da.sourceScope + "' -> '" + da.targetScope + "'";
  if (da.created) {
    return (
      " Design Access " +
      pair +
      " was created (sys_scope_design_access " +
      da.sysId +
      ")."
    );
  }
  if (da.present === true) {
    return (
      " Design Access " +
      pair +
      " is present (sys_scope_design_access " +
      da.sysId +
      ")."
    );
  }
  var state =
    da.present === null
      ? "could NOT be read (sys_scope_design_access query failed) — check it on the instance"
      : "is MISSING";
  if (isDryRun && ensureRequested && da.present === false) {
    return (
      " DESIGN ACCESS REQUIRED: " +
      pair +
      " " +
      state +
      " — would create it first, in the same update set."
    );
  }
  return (
    " DESIGN ACCESS REQUIRED: " +
    pair +
    " " +
    state +
    ". The headless insert does not need it, but UI/Studio edits of this column and the " +
    "target instance will refuse it — re-run with --ensure-design-access (MCP: " +
    "ensureDesignAccess:true) or create it with dove-sn design-access."
  );
}

export async function addColumn(
  params: AddColumnParams,
): Promise<AddColumnResult> {
  var daOut: { value?: DesignAccessFlag } = {};
  var result = await addColumnInner(params, daOut);
  // The dry-run path attaches its own flag + note; every live return is decorated here so
  // no exit path (created / skipped / any failure) can drop the flag.
  if (!result.designAccess && daOut.value) {
    result.designAccess = daOut.value;
    result.note += designAccessNote(
      daOut.value,
      params.ensureDesignAccess === true,
      false,
    );
  }
  return result;
}

async function addColumnInner(
  params: AddColumnParams,
  daOut: { value?: DesignAccessFlag },
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
  // The sibling column this one resolves against (document_id -> its table_name
  // column). Read straight off the raw spec like mandatory/default; "" means none.
  var wantDependent =
    typeof params.column.dependent_on_field === "string"
      ? params.column.dependent_on_field.trim()
      : "";
  if (wantDependent === element) {
    throw new Error(
      "add-column: dependent_on_field '" +
        wantDependent +
        "' names the column being added — a column cannot depend on itself.",
    );
  }

  if (params.dryRun) {
    // A plain dry-run (no scope named) is pure + deterministic — no network — so it
    // can plan without an instance. Once a scope IS named, the plan depends on the
    // instance (does the table allow it? does the update set match?), so the dry-run
    // runs the SAME guards as the live path and fails the same way. It used to skip
    // them, so a cross-scope request dry-ran clean and only failed live.
    var hasScopeAsk =
      (params.scope !== undefined && params.scope.trim() !== "") ||
      params.crossScope === true;
    var planned: ColumnPlan | undefined;
    if (hasScopeAsk) planned = await planColumnScope(client, params, element);
    var planElement = planned ? planned.element : element;
    var planTable = planned ? planned.resolved.name : params.table;
    var planTableSysId = planned
      ? planned.resolved.sysId
      : SYS_ID.test(params.table)
      ? params.table
      : "";
    var dryDa = planned ? planned.designAccess : undefined;
    var dryResult: AddColumnResult = {
      status: "dry-run",
      table: planTable,
      tableSysId: planTableSysId,
      element: planElement,
      label: col.label,
      internalType: col.type,
      scope: planned ? planned.scopeName : "",
      columnSysId: "",
      updateSetSysId: params.updateSetSysId ? params.updateSetSysId : "",
      verified: false,
      note:
        "dry-run: no write. Would add column '" +
        planElement +
        "' (" +
        col.type +
        ") to '" +
        planTable +
        "'" +
        (planned && planned.crossScope
          ? " OWNED BY scope '" +
            planned.scopeName +
            "' (cross-scope: the table allows new fields and the update set is in that scope)"
          : "") +
        " via a scope-aware sys_dictionary insert, captured into update set " +
        (params.updateSetSysId ? params.updateSetSysId : "(none provided)") +
        (wantDependent
          ? ", dependent on column '" +
            wantDependent +
            "' (which must already exist on the table)"
          : "") +
        ", then read it back." +
        designAccessNote(dryDa, params.ensureDesignAccess === true, true),
    };
    if (dryDa) dryResult.designAccess = dryDa;
    return dryResult;
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

  // Resolve the table and decide which scope OWNS the column — the table's by default,
  // the override's under crossScope. Every scope guard runs inside planColumnScope, the
  // same code the dry-run ran, so nothing can pass dry-run and fail here on scope.
  var plan = await planColumnScope(client, params, element);
  var resolved = plan.resolved;
  var scopeName = plan.scopeName;
  element = plan.element;

  // max_length is deliberately NOT sent on the insert — see the sizing step below.
  // Reference (and date) columns carry no max_length at all.
  var wantLength = col.type === "reference" ? "" : col.maxLength;

  // The dependency target must EXIST on this table before the insert. ServiceNow
  // accepts any string in dependent_on_field without checking it, so a typo would
  // land silently and every document_id on the table would resolve against nothing.
  // Only the table's OWN dictionary rows are searched — a dependency on an inherited
  // column is not supported here; add it on the defining table instead.
  if (wantDependent) {
    var dependencyRows = await client.table.query<Record<string, unknown>>(
      "sys_dictionary",
      "name=" + resolved.name + "^element=" + wantDependent,
      { limit: 1, fields: ["sys_id", "element"] },
    );
    if (dependencyRows.length === 0) {
      throw new Error(
        "add-column: dependent_on_field '" +
          wantDependent +
          "' is not a column on '" +
          resolved.name +
          "' (its own sys_dictionary rows were searched; inherited columns are not " +
          "considered). Add that column first, then re-run. Nothing was written.",
      );
    }
  }

  // Create the missing Design Access record when asked — AFTER every check that can still
  // refuse the request (scope, update set, dependency), so a refusal never leaves a record
  // behind, and BEFORE the column, so nothing about the column has been written yet: a
  // failure here stops cleanly (or, if the record landed but did not verify, says so).
  var da = plan.designAccess;
  if (da && da.present !== true && params.ensureDesignAccess === true) {
    var ensured = await ensureDesignAccess({
      client: client,
      sourceScope: da.sourceScope,
      targetScope: da.targetScope,
      updateSetSysId: params.updateSetSysId,
    });
    da = {
      required: true,
      present: ensured.present,
      sysId: ensured.sysId,
      sourceScope: da.sourceScope,
      targetScope: da.targetScope,
      created: ensured.status === "created",
    };
    if (ensured.status === "failed") {
      var daFail = failure(
        resolved,
        col,
        element,
        params.updateSetSysId,
        "Design Access could not be ensured, so the column was NOT added: " +
          ensured.note,
        undefined,
        scopeName,
      );
      daFail.designAccess = da;
      return daFail;
    }
  }
  if (da) daOut.value = da;

  // Idempotency: if the column already exists, skip the insert (never duplicate a
  // dictionary row on a re-run). Matched by name+element — the element IS the column's
  // identity; a label is not unique, so matching on one would silently skip a genuinely
  // different column.
  var existing = await client.table.query<Record<string, unknown>>(
    "sys_dictionary",
    "name=" + resolved.name + "^element=" + element,
    { limit: 1, fields: READ_BACK_FIELDS },
  );
  if (existing.length > 0) {
    var existingSysId = fieldToString(existing[0].sys_id);
    var existingElement = fieldToString(existing[0].element) || element;
    var existingType = fieldToString(existing[0].internal_type);
    var existingLength = fieldToString(existing[0].max_length);
    var existingDependent = fieldToString(existing[0].dependent_on_field);
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
    if (wantLength && existingLength !== wantLength) {
      // An EMPTY existing max_length is drift too: a length was requested, and a row
      // that reports none cannot be shown to match it — refusing to verify beats
      // green-lighting a column of unknown size.
      drift.push(
        "max_length is " +
          (existingLength ? existingLength : "(empty)") +
          ", not the requested " +
          wantLength,
      );
    }
    if (wantDependent && existingDependent !== wantDependent) {
      drift.push(
        "dependent_on_field is " +
          (existingDependent ? "'" + existingDependent + "'" : "(empty)") +
          ", not the requested '" +
          wantDependent +
          "'",
      );
    }
    return {
      status: "skipped",
      table: resolved.name,
      tableSysId: resolved.sysId,
      element: existingElement,
      label: col.label,
      internalType: existingType || col.type,
      scope: scopeName,
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
    // The COLUMN's owner — the table's scope by default, the override's under
    // crossScope. The createRecord `scope` below is switched to the same owner so the
    // dictionary row and its update-set capture agree on who owns the column.
    sys_scope: plan.scopeSysId,
  };
  // Reference columns carry the target table NAME (not a sys_id) in `reference`.
  if (col.reference) fields.reference = col.reference;
  // A plain dictionary-row field (unlike max_length it has no physical side), so it
  // rides on the insert; the read-back below still proves it stuck, and patches it
  // once if the insert dropped it.
  if (wantDependent) fields.dependent_on_field = wantDependent;

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
      undefined,
      scopeName,
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
      undefined,
      scopeName,
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
      { limit: 1, fields: READ_BACK_FIELDS },
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
          { limit: 1, fields: READ_BACK_FIELDS },
        );
      }
    }
    // The dependency rode on the insert. If the row reads back without it, patch it
    // ONCE as an update (the same trust-the-read-back rule as max_length), then let
    // the final read-back decide — never assume the patch took either.
    if (rows.length > 0 && wantDependent) {
      var landedDependent = fieldToString(rows[0].dependent_on_field);
      if (landedDependent !== wantDependent) {
        await setDependentOnField(
          client,
          columnSysId,
          params.updateSetSysId,
          wantDependent,
        );
        rows = await client.table.query<Record<string, unknown>>(
          "sys_dictionary",
          "sys_id=" + columnSysId,
          { limit: 1, fields: READ_BACK_FIELDS },
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
      scopeName,
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
  var readBackDependent = verified
    ? fieldToString(rows[0].dependent_on_field)
    : "";
  var readBackScope = verified ? fieldToString(rows[0].sys_scope) : "";

  // Ownership is part of the column's identity: a cross-scope row that reads back in
  // the TABLE's scope was prefixed for nothing and will ship in the wrong update set.
  // Asserted whenever the instance reports a scope (a read-back that omits it, as in
  // older stubs, is not evidence either way).
  if (verified && readBackScope && readBackScope !== plan.scopeSysId) {
    return failure(
      resolved,
      col,
      element,
      params.updateSetSysId,
      "column '" +
        actualElement +
        "' materialised but sys_scope read back as '" +
        readBackScope +
        "', not the requested '" +
        plan.scopeSysId +
        "' (" +
        scopeName +
        ") — the column is owned by the wrong app and its capture will not promote with " +
        "the right scope. Reconcile it on the instance before writing to it.",
      columnSysId,
      scopeName,
    );
  }

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
      scopeName,
    );
  }

  if (verified && wantDependent && readBackDependent !== wantDependent) {
    return failure(
      resolved,
      col,
      element,
      params.updateSetSysId,
      "column '" +
        actualElement +
        "' materialised but dependent_on_field read back as " +
        (readBackDependent ? "'" + readBackDependent + "'" : "(empty)") +
        ", not the requested '" +
        wantDependent +
        "' — a document_id with no dependency resolves against nothing. Set it on " +
        "the instance (set-column --dependent-on-field) before writing to the column.",
      columnSysId,
      scopeName,
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
      scopeName,
    );
  }

  // Same trust-the-read-back rule as max_length: a column that reads back a different
  // internal_type than was requested is NOT the column that was asked for. Refuse to
  // call it verified — the column EXISTS (sys_id below), so report through the
  // structured failed result, not a green result with a note nobody reads.
  if (readBackType && readBackType !== col.type) {
    return failure(
      resolved,
      col,
      element,
      params.updateSetSysId,
      "column '" +
        actualElement +
        "' materialised but internal_type read back as '" +
        readBackType +
        "', not the requested '" +
        col.type +
        "' — the column that exists is not the column that was asked for. Reconcile it " +
        "on the instance before writing to it.",
      columnSysId,
      scopeName,
    );
  }

  var note =
    "Added column '" +
    actualElement +
    "' (" +
    col.type +
    ") to " +
    resolved.name +
    (wantDependent ? ", dependent on '" + wantDependent + "'" : "") +
    (plan.crossScope
      ? " owned by scope '" + scopeName + "' (cross-scope field)"
      : "") +
    " — verified present in sys_dictionary, captured into update set " +
    params.updateSetSysId +
    (actualElement !== element
      ? " (NOTE: ServiceNow stored element '" +
        actualElement +
        "', not the requested '" +
        element +
        "')"
      : "") +
    ".";
  if (params.debug) {
    note +=
      " [debug: columnSysId=" +
      columnSysId +
      " scopeName=" +
      scopeName +
      " sys_scope=" +
      plan.scopeSysId +
      " crossScope=" +
      String(plan.crossScope) +
      " readBackScope=" +
      (readBackScope || "(none)") +
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
    scope: scopeName,
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
  scope?: string,
): AddColumnResult {
  return {
    status: "failed",
    table: resolved.name,
    tableSysId: resolved.sysId,
    element: element,
    label: col.label,
    internalType: col.type,
    scope: scope ? scope : "",
    columnSysId: columnSysId ? columnSysId : "",
    updateSetSysId: updateSetSysId,
    verified: false,
    note: note,
  };
}
