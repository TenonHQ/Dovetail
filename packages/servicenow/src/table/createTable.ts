/**
 * Create a whole ServiceNow TABLE (sys_db_object) with its columns — headless,
 * the faithful way. A table create is a privileged platform operation: a REST /
 * Dovetail createRecord insert into sys_db_object ORPHANS the table (metadata row,
 * no physical table, no ACLs). The only faithful path is the form the Studio UI
 * drives — a single `POST /sys_db_object.do` whose body embeds every column as a
 * list-edit XML blob. Ground truth + field-by-field dissection:
 * CTO docs/servicenow-create-table-har-analysis.md.
 *
 * Sequence (form-login replay, modeled on flowDesigner/createFlow.ts):
 *   1. open a form session (login.do -> authenticated g_ck)
 *   2. resolve sys_ids via the REST client (parent table, scope, role, app)
 *   3. GET the new-record form, harvest its fields (ck, encoded_record, REL id)
 *   4. overlay the table + column values, POST -> expect 302
 *   5. assert the resulting sys_update_xml landed in the pinned update set
 *
 * NOT YET VALIDATED LIVE — this is the B2 spike surface. dryRun is pure and
 * fully tested; the live write path awaits a validated-live run before the verb /
 * MCP tool flip from Studio. ES6 only, no optional chaining, no `any`.
 */

import * as crypto from "crypto";
import type { ServiceNowClient } from "../client";
import { buildColumnXml, NormalizedColumn } from "./buildColumnXml";
import {
  ColumnSpec,
  normalizeColumns,
  applyTableSaveOverlay,
  defaultAccessFlags,
  AccessFlags,
  OverlaySpec
} from "./buildTableSave";
import { resolveFormAuth, openFormSession, getNewRecordForm, postForm } from "./formSession";

/** Default parent for a custom scoped table — what Studio picks for "extends nothing". */
export var DEFAULT_SUPER_CLASS = "sys_metadata";

export interface CreateTableParams {
  /** REST client for sys_id resolution + the update-set assertion. */
  client: ServiceNowClient;
  /** Table name, e.g. "x_cadso_core_error". */
  name: string;
  /** Table label, e.g. "Error". */
  label: string;
  /** Scope name ("x_cadso_core") OR a sys_scope sys_id. Required. */
  scope: string;
  /** Columns to create (at least one). */
  columns: Array<ColumnSpec>;
  /** Parent table name to extend; defaults to sys_metadata. */
  extendsTable?: string;
  /** Number prefix (creates a sys_number); "" for none. */
  numberPrefix?: string;
  /** Role name granted on the seeded ACLs (e.g. "x_cadso_core.user"). */
  userRole?: string;
  /** Seed the read/create/update/delete ACLs (default true). */
  createAccessControls?: boolean;
  /** Per-op access flags (default: all true). */
  accessFlags?: AccessFlags;
  /** Scope access (default "public"). */
  access?: string;
  /** Add the Application-Navigator module (default true). */
  showInMenu?: boolean;
  /** Update set sys_id to pin the writes to. Strongly recommended. */
  updateSetSysId?: string;
  /** Override the Save UI-action sys_id (defaults to the well-known global Save). */
  saveActionSysId?: string;
  /** Instance/creds for the form session (default: env, same precedence as the client). */
  instance?: string;
  user?: string;
  password?: string;
  /** Plan only — no session, no writes. Pure + deterministic. */
  dryRun?: boolean;
}

export interface TableGraph {
  sys_db_object: number;
  sys_dictionary: number;
  sys_documentation: number;
  sys_security_acl: number;
  sys_security_acl_role: number;
  sys_app_module: number;
  total: number;
}

export interface CreateTableResult {
  status: "created" | "dry-run" | "failed";
  /** sys_id of the new table ("" on dry-run / failure). */
  tableSysId: string;
  name: string;
  label: string;
  scopeSysId: string;
  columns: number;
  /** Resolved internal types (friendly -> internal). */
  resolvedColumns: Array<{ label: string; type: string; maxLength: string }>;
  graph: TableGraph;
  httpStatus: number;
  /** 302 Location on success. */
  location: string;
  /** The embedded column XML (always populated — it is pure). */
  columnXml: string;
  /** Human-readable note (e.g. the live-validation caveat). */
  note: string;
}

/** The well-known global "Save" UI action (sys_ui_action). Override per-instance if needed. */
export var DEFAULT_SAVE_ACTION = "3dc6c898c3201100dcc2addbdfba8fe7";

function newSysId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Project the record graph a real create emits (the 36-record shape for 12 cols). */
export function projectTableGraph(columnCount: number, createAcls: boolean, hasRole: boolean): TableGraph {
  var dictionary = columnCount + 1; // +1 collection row
  var labels = columnCount + 1; // table label + per-column labels
  var acls = createAcls ? 4 : 0;
  var aclRoles = createAcls && hasRole ? 4 : 0;
  var modules = 1;
  return {
    sys_db_object: 1,
    sys_dictionary: dictionary,
    sys_documentation: labels,
    sys_security_acl: acls,
    sys_security_acl_role: aclRoles,
    sys_app_module: modules,
    total: 1 + dictionary + labels + acls + aclRoles + modules
  };
}

var IDENT = /^[a-z][a-z0-9_]*$/;
var SYS_ID = /^[0-9a-f]{32}$/i;

function validate(params: CreateTableParams): void {
  if (!params || typeof params !== "object") throw new Error("createTable: params object required.");
  if (!params.client) throw new Error("createTable: client is required.");
  if (!params.name || !IDENT.test(params.name)) {
    throw new Error("createTable: name '" + params.name + "' is not a valid table identifier (lower_snake_case).");
  }
  if (!params.label || params.label.trim().length === 0) throw new Error("createTable: label is required.");
  if (!params.scope || params.scope.trim().length === 0) throw new Error("createTable: scope is required.");
}

/** Resolve a name-or-sysid against a table; returns { sysId, label } or throws. */
async function resolveRef(
  client: ServiceNowClient,
  table: string,
  field: string,
  value: string,
  labelField: string
): Promise<{ sysId: string; label: string }> {
  if (SYS_ID.test(value)) {
    var byId = await client.table.query<Record<string, string>>(table, "sys_id=" + value, 1);
    if (byId.length > 0) return { sysId: value, label: String(byId[0][labelField] || "") };
    return { sysId: value, label: "" };
  }
  var rows = await client.table.query<Record<string, string>>(table, field + "=" + value, 1);
  if (rows.length === 0) {
    throw new Error("createTable: could not resolve " + table + " where " + field + "=" + value + ".");
  }
  return { sysId: String(rows[0].sys_id), label: String(rows[0][labelField] || "") };
}

export async function createTable(params: CreateTableParams): Promise<CreateTableResult> {
  validate(params);
  var client = params.client;
  var columns: Array<NormalizedColumn> = normalizeColumns(params.columns);
  var createAcls = params.createAccessControls === false ? false : true;
  var hasRole = !!(params.userRole && params.userRole.trim());
  var graph = projectTableGraph(columns.length, createAcls, hasRole);
  var resolvedColumns = columns.map(function (c) {
    return { label: c.label, type: c.type, maxLength: c.maxLength };
  });

  // The column XML is pure — build it now (used by dry-run AND the live POST).
  var columnSysIds = columns.map(function () { return newSysId(); });
  var columnXml = buildColumnXml(columns, columnSysIds);

  if (params.dryRun) {
    return {
      status: "dry-run",
      tableSysId: "",
      name: params.name,
      label: params.label,
      scopeSysId: SYS_ID.test(params.scope) ? params.scope : "",
      columns: columns.length,
      resolvedColumns: resolvedColumns,
      graph: graph,
      httpStatus: 0,
      location: "",
      columnXml: columnXml,
      note: "dry-run: no session opened, no writes. Resolved " + columns.length
        + " columns; projected graph " + graph.total + " records + the physical table."
    };
  }

  // ---- LIVE PATH (NOT YET VALIDATED) ----------------------------------------
  // 2: resolve sys_ids via REST.
  var extendsName = params.extendsTable && params.extendsTable.trim() ? params.extendsTable.trim() : DEFAULT_SUPER_CLASS;
  var superClass = await resolveRef(client, "sys_db_object", "name", extendsName, "label");
  var scopeRef = await resolveRef(client, "sys_scope", "scope", params.scope, "name");
  var roleSysId = "";
  var roleLabel = "";
  if (hasRole) {
    var role = await resolveRef(client, "sys_user_role", "name", String(params.userRole), "name");
    roleSysId = role.sysId;
    roleLabel = role.label || String(params.userRole);
  }
  var appSysId = "";
  var showInMenu = params.showInMenu === false ? false : true;
  if (showInMenu) {
    var apps = await client.table.query<Record<string, string>>("sys_app", "scope=" + params.scope, 1);
    if (apps.length > 0) appSysId = String(apps[0].sys_id);
  }
  var saveAction = params.saveActionSysId && params.saveActionSysId.trim() ? params.saveActionSysId.trim() : DEFAULT_SAVE_ACTION;

  // 1: open the form session.
  var auth = resolveFormAuth({ instance: params.instance, user: params.user, password: params.password });
  var session = await openFormSession(auth);
  if (params.updateSetSysId) {
    // Pin the REST session's update set; the form session inherits the user pref.
    try { await client.claude.changeUpdateSet({ sysId: params.updateSetSysId }); } catch (e) { /* best-effort */ }
  }

  // 3: harvest the new-record form.
  var harvest = await getNewRecordForm(auth, session);
  var tableSysId = newSysId();
  var overlay: OverlaySpec = {
    name: params.name,
    label: params.label,
    tableSysId: tableSysId,
    saveActionSysId: saveAction,
    superClassSysId: superClass.sysId,
    superClassLabel: superClass.label,
    scopeSysId: scopeRef.sysId,
    scopeLabel: scopeRef.label,
    numberPrefix: params.numberPrefix ? params.numberPrefix : "",
    userRoleSysId: roleSysId,
    userRoleLabel: roleLabel,
    createAccessControls: createAcls,
    access: params.access ? params.access : "public",
    accessFlags: params.accessFlags ? params.accessFlags : defaultAccessFlags(),
    selectedApplicationSysId: showInMenu ? appSysId : "",
    menuName: params.label,
    listEditKey: harvest.listEditKey,
    columnXml: columnXml
  };
  var fields = applyTableSaveOverlay(harvest.fields, overlay);

  // 4: POST the save.
  var resp = await postForm(auth, session, "/sys_db_object.do", fields);
  var ok = resp.status >= 300 && resp.status < 400; // 302 on success
  return {
    status: ok ? "created" : "failed",
    tableSysId: ok ? tableSysId : "",
    name: params.name,
    label: params.label,
    scopeSysId: scopeRef.sysId,
    columns: columns.length,
    resolvedColumns: resolvedColumns,
    graph: graph,
    httpStatus: resp.status,
    location: resp.location,
    columnXml: columnXml,
    note: ok
      ? "LIVE PATH NOT YET VALIDATED — verify the " + graph.total
        + " sys_update_xml rows landed in the pinned update set before trusting this result."
      : "save POST returned " + resp.status + " (expected 302). " + resp.body.slice(0, 200)
  };
}
