/**
 * Add ONE column to an EXISTING ServiceNow table — headless, the faithful way.
 * Creating a column is inserting a `sys_dictionary` record; a REST / Dovetail
 * createRecord insert into sys_dictionary reliably 500s for a scoped-app column
 * (scope-policy + the dictionary engine being wired to the form transaction, not
 * the REST insert). The faithful path is the one the Studio UI drives: a single
 * `POST /sys_db_object.do` against the EXISTING table record whose body embeds the
 * new column as the same list-edit XML blob create-table uses.
 *
 * This REUSES the create-table machinery wholesale (buildColumnXml, formSession,
 * the list-edit key + type normalization) and differs in exactly two ways:
 *   1. It GETs the EXISTING table form (sys_id=<tableSysId>), which renders the
 *      "Columns" related list — so the real listEditKey is harvested, not faked.
 *   2. It overlays ONLY the column XML + the save machinery, preserving every
 *      existing table field from the harvest (name/label/scope/ACLs untouched).
 * Then it READS THE COLUMN BACK from sys_dictionary to prove it landed — a write
 * that 302s but didn't create the field is reported as failed, never "created".
 *
 * The live POST path is NOT yet validated end-to-end (see the create-table caveat);
 * prefer dryRun until a live run on a sandbox confirms it. ES6 only, no optional
 * chaining, no `any`.
 */

import * as crypto from "crypto";
import type { ServiceNowClient } from "../client";
import { buildColumnXml, NormalizedColumn } from "./buildColumnXml";
import { ColumnSpec, normalizeColumns, listEditKey } from "./buildTableSave";
import { resolveFormAuth, openFormSession, setCurrentApplication, getRecordForm, postForm } from "./formSession";
import { DEFAULT_SAVE_ACTION, DEFAULT_COLUMNS_REL_ID, parseSysIdFromLocation } from "./createTable";

var SYS_ID = /^[0-9a-f]{32}$/i;

export interface AddColumnParams {
  /** REST client for table/scope resolution + the read-back verify. */
  client: ServiceNowClient;
  /** Existing table — its name ("x_cadso_journey") OR its sys_db_object sys_id. */
  table: string;
  /** The single column to add. `name` (the element) is optional; derived from label when omitted. */
  column: ColumnSpec;
  /** Scope name or sys_scope sys_id to run the form session in. Defaults to the table's own scope. */
  scope?: string;
  /** Update set sys_id to pin the writes to. Strongly recommended. */
  updateSetSysId?: string;
  /** Override the Save UI-action sys_id (defaults to the well-known global Save). */
  saveActionSysId?: string;
  /** Override the "Table Columns" relationship sys_id (fallback only — the existing form normally yields it). */
  columnsRelId?: string;
  /** Emit diagnostic detail in the result note. */
  debug?: boolean;
  /** Instance/creds for the form session (default: env, same precedence as the client). */
  instance?: string;
  user?: string;
  password?: string;
  /** Plan only — no session, no writes. Pure + deterministic. */
  dryRun?: boolean;
}

export interface AddColumnResult {
  status: "created" | "dry-run" | "failed";
  /** The table's name (resolved; echoes the input on dry-run). */
  table: string;
  /** sys_db_object sys_id ("" on dry-run / when unresolved). */
  tableSysId: string;
  /** The dictionary element (column name) — derived from label or the explicit `name`. */
  element: string;
  /** The column's display label. */
  label: string;
  /** Resolved ServiceNow internal_type (friendly -> internal). */
  internalType: string;
  /** Client-generated sys_id sent for the new sys_dictionary row. */
  columnSysId: string;
  /** Update set the write was pinned to ("" if none). */
  updateSetSysId: string;
  httpStatus: number;
  /** 302 Location on a successful POST. */
  location: string;
  /** The embedded column XML (always populated — it is pure). */
  columnXml: string;
  /** True only when the column was READ BACK from sys_dictionary after the POST. */
  verified: boolean;
  /** Human-readable note (success summary, the read-back result, or the failure body). */
  note: string;
}

/**
 * Derive the dictionary element (column name) from a label the way Studio does for
 * a scoped table: lower-case, every run of non-alphanumerics -> a single
 * underscore, trimmed. Scoped custom columns are NOT u_-prefixed (that is a
 * global-scope-on-OOB-table behaviour), so "URL" -> "url". Pass `column.name`
 * explicitly for anything non-trivial.
 */
export function deriveElement(label: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  var e = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!e) throw new Error("addColumn: cannot derive a column name from label '" + label + "' — pass column.name.");
  return e;
}

/**
 * Overlay ONLY the new-column list-edit XML and the form-save machinery onto the
 * fields harvested from the EXISTING table form. Returns a NEW object; every
 * existing table field (name, label, scope, access, super_class, …) is preserved
 * from `base` untouched — an add-column must not re-stamp the table. Mirrors the
 * harvested-defaults-preserved contract of applyTableSaveOverlay.
 */
export function applyAddColumnOverlay(
  base: Record<string, string>,
  o: { tableSysId: string; saveActionSysId: string; listEditKey: string; columnXml: string }
): Record<string, string> {
  var f: Record<string, string> = Object.assign({}, base);
  f["sys_target"] = "sys_db_object";
  f["sys_uniqueName"] = "sys_id";
  f["sys_uniqueValue"] = o.tableSysId;
  f["sys_row"] = o.tableSysId;
  f["sys_action"] = o.saveActionSysId;
  f["isFormPage"] = "true";
  f["sysparm_modify_check"] = "true";
  f["personalizer_sys_db_object"] = "true";
  if (o.listEditKey) {
    f[o.listEditKey] = o.columnXml;
  }
  return f;
}

function newSysId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function validate(params: AddColumnParams): void {
  if (!params || typeof params !== "object") throw new Error("addColumn: params object required.");
  if (!params.client) throw new Error("addColumn: client is required.");
  if (!params.table || !String(params.table).trim()) throw new Error("addColumn: table is required.");
  if (!params.column || typeof params.column !== "object") throw new Error("addColumn: column is required.");
}

/** Resolve the table by name or sys_id; returns its name, sys_id, and sys_scope. */
async function resolveTable(
  client: ServiceNowClient,
  table: string
): Promise<{ name: string; sysId: string; scopeSysId: string }> {
  var query = SYS_ID.test(table) ? "sys_id=" + table : "name=" + table;
  var rows = await client.table.query<Record<string, string>>("sys_db_object", query, 1);
  if (rows.length === 0) {
    throw new Error("addColumn: table '" + table + "' not found in sys_db_object.");
  }
  return {
    name: String(rows[0].name || table),
    sysId: String(rows[0].sys_id || ""),
    scopeSysId: String(rows[0].sys_scope || "")
  };
}

/** Resolve a scope name-or-sysid to the sys_app sys_id used by setCurrentApplication. */
async function resolveAppSysId(client: ServiceNowClient, scope: string): Promise<string> {
  if (!scope) return "";
  var query = SYS_ID.test(scope) ? "sys_id=" + scope : "scope=" + scope;
  var apps = await client.table.query<Record<string, string>>("sys_app", query, 1);
  return apps.length > 0 ? String(apps[0].sys_id) : "";
}

export async function addColumn(params: AddColumnParams): Promise<AddColumnResult> {
  validate(params);
  var client = params.client;

  // Normalize the single column (validates type, reference target, dedup is trivial).
  var normalized: Array<NormalizedColumn> = normalizeColumns([params.column]);
  var col = normalized[0];
  var element = deriveElement(col.label, params.column.name);
  var columnSysId = newSysId();
  // The column XML is pure — build it now (used by dry-run AND the live POST).
  var columnXml = buildColumnXml(normalized, [columnSysId]);

  if (params.dryRun) {
    return {
      status: "dry-run",
      table: params.table,
      tableSysId: SYS_ID.test(params.table) ? params.table : "",
      element: element,
      label: col.label,
      internalType: col.type,
      columnSysId: columnSysId,
      updateSetSysId: params.updateSetSysId ? params.updateSetSysId : "",
      httpStatus: 0,
      location: "",
      columnXml: columnXml,
      verified: false,
      note: "dry-run: no session opened, no writes. Would add column '" + element
        + "' (" + col.type + ") to '" + params.table + "' via the table form save, then read it back from sys_dictionary."
    };
  }

  // ---- LIVE PATH (NOT YET VALIDATED END-TO-END) -----------------------------
  // Resolve the existing table + its scope.
  var resolved = await resolveTable(client, params.table);
  var scopeForApp = params.scope && params.scope.trim() ? params.scope.trim() : resolved.scopeSysId;
  var appSysId = await resolveAppSysId(client, scopeForApp);
  var saveAction = params.saveActionSysId && params.saveActionSysId.trim()
    ? params.saveActionSysId.trim()
    : DEFAULT_SAVE_ACTION;

  // Open the form session and put it in the table's scope before the save.
  var auth = resolveFormAuth({ instance: params.instance, user: params.user, password: params.password });
  var session = await openFormSession(auth);
  var appSwitch = { ok: false, status: 0, body: "no app resolved" };
  if (appSysId) {
    appSwitch = await setCurrentApplication(auth, session, appSysId);
  }
  if (params.updateSetSysId) {
    try { await client.claude.changeUpdateSet({ sysId: params.updateSetSysId }); } catch (e) { /* best-effort */ }
  }

  // Harvest the EXISTING table form — its rendered related list yields the real key.
  var harvest = await getRecordForm(auth, session, resolved.sysId);
  var relId = params.columnsRelId && params.columnsRelId.trim() ? params.columnsRelId.trim() : DEFAULT_COLUMNS_REL_ID;
  var colKey = harvest.listEditKey ? harvest.listEditKey : listEditKey(relId);
  var fields = applyAddColumnOverlay(harvest.fields, {
    tableSysId: resolved.sysId,
    saveActionSysId: saveAction,
    listEditKey: colKey,
    columnXml: columnXml
  });

  var resp = await postForm(auth, session, "/sys_db_object.do", fields);
  var posted = resp.status >= 300 && resp.status < 400; // 302 on success

  // Read the column back — the done gate. A 302 that didn't create the field is a failure.
  var verified = false;
  var readBackType = "";
  if (posted) {
    var dictRows = await client.table.query<Record<string, string>>(
      "sys_dictionary",
      "name=" + resolved.name + "^element=" + element,
      1
    );
    if (dictRows.length > 0) {
      verified = true;
      readBackType = String(dictRows[0].internal_type || "");
    }
  }

  var status: "created" | "failed" = posted && verified ? "created" : "failed";
  var note: string;
  if (status === "created") {
    note = "Added column '" + element + "' (" + col.type + ") to " + resolved.name
      + " — verified present in sys_dictionary"
      + (readBackType && readBackType !== col.type ? " (NOTE: internal_type read back as '" + readBackType + "')" : "")
      + ". Confirm a scoped insert + the sys_update_xml landed in the update set.";
  } else if (posted && !verified) {
    note = "save POST returned " + resp.status + " but column '" + element + "' was not found in sys_dictionary on "
      + resolved.name + " — the form may have rejected the column. " + resp.body.slice(0, 200);
  } else {
    note = "save POST returned " + resp.status + " (expected 302). " + resp.body.slice(0, 200);
  }
  if (params.debug) {
    note += " [debug: appSwitch=" + appSwitch.status + (appSwitch.ok ? "/ok" : "/FAIL:" + appSwitch.body)
      + " appSysId=" + (appSysId || "(none)")
      + " harvestedListEditKey=" + (harvest.listEditKey ? "yes" : "no")
      + " colKey=" + colKey
      + " fieldCount=" + Object.keys(fields).length
      + " location=" + resp.location
      + " readBackType=" + (readBackType || "(none)") + "]";
  }

  return {
    status: status,
    table: resolved.name,
    tableSysId: resolved.sysId,
    element: element,
    label: col.label,
    internalType: col.type,
    columnSysId: columnSysId,
    updateSetSysId: params.updateSetSysId ? params.updateSetSysId : "",
    httpStatus: resp.status,
    location: resp.location,
    columnXml: columnXml,
    verified: verified,
    note: note
  };
}
