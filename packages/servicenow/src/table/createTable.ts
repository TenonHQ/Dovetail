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
 *   1b. switch the form session's current application to the target scope, so the
 *       new table is scoped correctly (the session app governs scope, NOT a field)
 *   2. resolve sys_ids via the REST client (parent table, scope, role, app)
 *   3. GET the new-record form, harvest its fields (ck, encoded_record)
 *   4. overlay the table + column values (columns ride a constant "Table Columns"
 *      relId — the new-record form doesn't render related lists to harvest one from)
 *   5. POST -> expect 302 to sys_db_object.do?sys_id=<assigned>; parse that sys_id
 *
 * VALIDATED LIVE 2026-06-13 (tenonworkstudio): a 6-column create landed the table,
 * all columns, ACLs + role, the nav module, and 25 sys_update_xml rows in the pinned
 * update set; a scoped insert round-tripped (physical table, not an orphan). The
 * earlier defects (wrong scope, 0 columns, fabricated sys_id) are fixed here.
 * ES6 only, no optional chaining, no `any`.
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
  OverlaySpec,
  listEditKey
} from "./buildTableSave";
import { fieldToString } from "../setField";
import { encodeQueryValue } from "../choices";
import { mergeAttributes, missingAttributes, parseAttributes } from "./dictionaryAttributes";
import { resolveFormAuth, openFormSession, setCurrentApplication, getNewRecordForm, postForm } from "./formSession";

/** Default parent for a custom scoped table — what Studio picks for "extends nothing". */
export var DEFAULT_SUPER_CLASS = "sys_metadata";

/**
 * The "Table Columns" sys_relationship sys_id — the related list that carries the
 * column XML in the `sys_db_object.REL:<relId>` list-edit key. It is a shipped OOB
 * relationship (stable across instances), so we use it as a constant: the new-record
 * (sys_id=-1) form does NOT render related lists, so the relId can't be harvested
 * from it — relying on harvest discovery silently dropped every column. Override via
 * params.columnsRelId only if an instance customized it.
 */
export var DEFAULT_COLUMNS_REL_ID = "4344f6f5bf1320001875647fcf0739ad";

/** Pull the assigned record sys_id out of a `...do?sys_id=<id>&...` 302 Location. */
export function parseSysIdFromLocation(location: string): string {
  if (!location) return "";
  var m = String(location).match(/[?&]sys_id=([0-9a-f]{32})\b/i);
  return m ? m[1] : "";
}

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
  /** Override the "Table Columns" relationship sys_id (defaults to the OOB constant). */
  columnsRelId?: string;
  /** Emit diagnostic detail (harvested key, scope fields, response snippet) in the result note. */
  debug?: boolean;
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
  /** Resolved internal types (friendly -> internal), with the attributes each must carry. */
  resolvedColumns: Array<{ label: string; type: string; maxLength: string; attributes: string }>;
  /**
   * Live path only: the read-back of every column that must carry attributes (a
   * reference column carries readonly_clickthrough=true by default). A column whose
   * attributes did not land is merge-patched once into the update set, then re-read;
   * any still missing fails the create.
   */
  columnAttributes?: Array<ColumnAttributeCheck>;
  graph: TableGraph;
  httpStatus: number;
  /** 302 Location on success. */
  location: string;
  /** The embedded column XML (always populated — it is pure). */
  columnXml: string;
  /** Human-readable note (e.g. the live-validation caveat). */
  note: string;
}

/** One column's attribute read-back after a live create. */
export interface ColumnAttributeCheck {
  label: string;
  /** "" when the column could not be found by label on read-back. */
  element: string;
  columnSysId: string;
  /** What the column must carry. */
  wanted: string;
  /** sys_dictionary.attributes as finally read back. */
  attributes: string;
  /** True when it was patched after the form save dropped it. */
  patched: boolean;
  verified: boolean;
  note: string;
}

/**
 * After the form save: read every column that must carry attributes back from
 * sys_dictionary (matched by column_label — unique per normalizeColumns), and merge-patch
 * any that did not land through Studio's list-edit XML. Never throws — the table already
 * exists, so every outcome is reported per column.
 */
export async function verifyColumnAttributes(
  client: ServiceNowClient,
  tableName: string,
  columns: Array<NormalizedColumn>,
  updateSetSysId: string,
): Promise<Array<ColumnAttributeCheck>> {
  var out: Array<ColumnAttributeCheck> = [];
  var wanted = columns.filter(function (c) { return Boolean(c.attributes); });
  if (wanted.length === 0) return out;
  var rows: Array<Record<string, unknown>> = [];
  var readError = "";
  try {
    rows = await client.table.query<Record<string, unknown>>(
      "sys_dictionary",
      "name=" + encodeQueryValue(tableName) + "^internal_type!=collection",
      { limit: 1000, fields: ["sys_id", "element", "column_label", "attributes"] },
    );
  } catch (e) {
    readError = e instanceof Error ? e.message : String(e);
  }
  for (var i = 0; i < wanted.length; i += 1) {
    var col = wanted[i];
    var want = parseAttributes(String(col.attributes));
    var check: ColumnAttributeCheck = {
      label: col.label, element: "", columnSysId: "", wanted: String(col.attributes),
      attributes: "", patched: false, verified: false, note: "",
    };
    out.push(check);
    if (readError) {
      check.note = "could not read sys_dictionary back: " + readError;
      continue;
    }
    var row: Record<string, unknown> | undefined;
    for (var r = 0; r < rows.length; r += 1) {
      if (fieldToString(rows[r].column_label) === col.label) { row = rows[r]; break; }
    }
    if (!row) {
      check.note = "no sys_dictionary row labelled '" + col.label + "' on " + tableName + " — the column may not have been created.";
      continue;
    }
    check.element = fieldToString(row.element);
    check.columnSysId = fieldToString(row.sys_id);
    check.attributes = fieldToString(row.attributes);
    if (missingAttributes(check.attributes, want).length === 0) {
      check.verified = true;
      continue;
    }
    if (!updateSetSysId) {
      check.note = "attributes did not land via the form save, and no update set was given to capture a patch into — set them with set-column --attributes.";
      continue;
    }
    try {
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: updateSetSysId,
        table: "sys_dictionary",
        record_sys_id: check.columnSysId,
        fields: { attributes: mergeAttributes(check.attributes, want) },
      });
      check.patched = true;
      var after = await client.table.query<Record<string, unknown>>(
        "sys_dictionary",
        "sys_id=" + encodeQueryValue(check.columnSysId),
        { limit: 1, fields: ["sys_id", "attributes"] },
      );
      check.attributes = after.length > 0 ? fieldToString(after[0].attributes) : "";
    } catch (e) {
      check.note = "patching attributes failed: " + (e instanceof Error ? e.message : String(e));
      continue;
    }
    var still = missingAttributes(check.attributes, want);
    check.verified = still.length === 0;
    if (!check.verified) {
      check.note = "attributes still missing " + still.join(", ") + " after a patch — set them on the instance.";
    }
  }
  return out;
}

/** The well-known global "Save" UI action (sys_ui_action). Override per-instance if needed. */
export var DEFAULT_SAVE_ACTION = "3dc6c898c3201100dcc2addbdfba8fe7";

function newSysId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Project the record graph a real create emits (the documented 36-record shape for
 * 12 cols + ACLs + role + menu). NOTE: a live create with Show-in-menu also re-emits
 * the parent Application-Navigator menu into the update set, so the pinned set holds
 * one MORE row than `total` (verified 2026-06-13: 6 cols → graph total 24, 25 rows
 * captured). The extra row is the existing menu being touched, not a new record.
 */
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
    return { label: c.label, type: c.type, maxLength: c.maxLength, attributes: c.attributes ? c.attributes : "" };
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
  // Resolve the app ALWAYS — it scopes the form session (setCurrentApplication),
  // not just the optional nav module. scope may be a name or a sys_scope sys_id.
  var appSysId = "";
  var showInMenu = params.showInMenu === false ? false : true;
  var appQuery = SYS_ID.test(params.scope) ? "sys_id=" + params.scope : "scope=" + params.scope;
  var apps = await client.table.query<Record<string, string>>("sys_app", appQuery, 1);
  if (apps.length > 0) appSysId = String(apps[0].sys_id);
  var saveAction = params.saveActionSysId && params.saveActionSysId.trim() ? params.saveActionSysId.trim() : DEFAULT_SAVE_ACTION;

  // 1: open the form session.
  var auth = resolveFormAuth({ instance: params.instance, user: params.user, password: params.password });
  var session = await openFormSession(auth);

  // 1b: put the form session IN the target app so the new table is scoped correctly.
  // Without this the table lands in the session user's default app (the #1 live defect).
  var appSwitch = { ok: false, status: 0, body: "no app resolved" };
  if (appSysId) {
    appSwitch = await setCurrentApplication(auth, session, appSysId);
  }

  if (params.updateSetSysId) {
    // Pin the REST session's update set; the form session inherits the user pref.
    try { await client.claude.changeUpdateSet({ sysId: params.updateSetSysId }); } catch (e) { /* best-effort */ }
  }

  // 3: harvest the new-record form.
  var harvest = await getNewRecordForm(auth, session);
  var tableSysId = newSysId();
  // The new-record (sys_id=-1) form doesn't render related lists, so harvest.listEditKey
  // is normally empty — fall back to the constant "Table Columns" relId so the columns
  // always ride the POST. Relying on the harvest alone silently produced column-less tables.
  var relId = params.columnsRelId && params.columnsRelId.trim() ? params.columnsRelId.trim() : DEFAULT_COLUMNS_REL_ID;
  var colKey = harvest.listEditKey ? harvest.listEditKey : listEditKey(relId);
  var overlay: OverlaySpec = {
    name: params.name,
    label: params.label,
    tableSysId: tableSysId,
    saveActionSysId: saveAction,
    superClassSysId: superClass.sysId,
    superClassLabel: superClass.label,
    scopeSysId: scopeRef.sysId,
    scopeLabel: scopeRef.label,
    // Left empty on purpose — the form-session app switch (1b) scopes the table.
    // Setting these triggers a cross-scope interstitial that bounces to welcome.do.
    transactionScopeSysId: "",
    numberPrefix: params.numberPrefix ? params.numberPrefix : "",
    userRoleSysId: roleSysId,
    userRoleLabel: roleLabel,
    createAccessControls: createAcls,
    access: params.access ? params.access : "public",
    accessFlags: params.accessFlags ? params.accessFlags : defaultAccessFlags(),
    selectedApplicationSysId: showInMenu ? appSysId : "",
    menuName: params.label,
    listEditKey: colKey,
    columnXml: columnXml
  };
  var fields = applyTableSaveOverlay(harvest.fields, overlay);

  // 4: POST the save.
  var resp = await postForm(auth, session, "/sys_db_object.do", fields);
  var ok = resp.status >= 300 && resp.status < 400; // 302 on success
  // The form assigns its own sys_id for a new record — the 302 Location is the truth,
  // not the sys_uniqueValue we sent. Prefer the parsed id; fall back to what we sent.
  var assignedSysId = parseSysIdFromLocation(resp.location);
  var finalSysId = ok ? (assignedSysId || tableSysId) : "";

  // The form's list-edit XML carries the attributes, but whether Studio honours them
  // there is not trusted on a 302 alone — read every such column back, patch once.
  var attrChecks: Array<ColumnAttributeCheck> = [];
  if (ok) {
    attrChecks = await verifyColumnAttributes(
      client,
      params.name,
      columns,
      params.updateSetSysId ? params.updateSetSysId : "",
    );
  }
  var attrFailures = attrChecks.filter(function (c) { return !c.verified; });

  var note: string;
  if (ok) {
    note = "Created via form save. Verify the " + graph.total
      + " records landed in scope " + scopeRef.sysId + " and the pinned update set.";
  } else {
    note = "save POST returned " + resp.status + " (expected 302). " + resp.body.slice(0, 200);
  }
  if (attrChecks.length > 0) {
    note += attrFailures.length === 0
      ? " Column attributes verified on " + attrChecks.length + " column(s)."
      : " COLUMN ATTRIBUTES NOT VERIFIED: " + attrFailures.map(function (c) {
          return "'" + c.label + "' — " + c.note;
        }).join("; ");
  }
  if (params.debug) {
    note += " [debug: appSwitch=" + appSwitch.status + (appSwitch.ok ? "/ok" : "/FAIL:" + appSwitch.body)
      + " appSysId=" + (appSysId || "(none)")
      + " harvestedListEditKey=" + (harvest.listEditKey ? "yes" : "no")
      + " colKey=" + colKey
      + " fieldCount=" + Object.keys(fields).length
      + " location=" + resp.location
      + " sentSysId=" + tableSysId
      + " assignedSysId=" + (assignedSysId || "(unparsed)") + "]";
  }

  return {
    status: ok && attrFailures.length === 0 ? "created" : "failed",
    tableSysId: finalSysId,
    name: params.name,
    label: params.label,
    scopeSysId: scopeRef.sysId,
    columns: columns.length,
    resolvedColumns: resolvedColumns,
    graph: graph,
    httpStatus: resp.status,
    location: resp.location,
    columnXml: columnXml,
    columnAttributes: attrChecks,
    note: note
  };
}
