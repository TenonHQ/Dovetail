/**
 * Pure transforms for the table-save form POST: normalize a friendly column spec
 * into ServiceNow internal types, and overlay the capability's values onto the
 * fields harvested from the live new-record form.
 *
 * The transport (GET the new-record form, harvest fields, POST) lives in
 * createTable.ts; everything here is deterministic and unit-tested. ES6 only.
 */

import { NormalizedColumn } from "./buildColumnXml";

/** Friendly input column (what a caller / MCP tool passes). */
export interface ColumnSpec {
  name?: string;
  label: string;
  type: string;
  max_length?: string | number;
  reference?: string;
}

/**
 * Friendly column type -> ServiceNow internal_type. Studio's default for a
 * "String" is `string_full_utf8`, NOT plain `string` (confirmed in the HAR), so
 * a caller saying "string" gets the type the platform actually writes.
 */
export var TYPE_MAP: Record<string, string> = {
  string: "string_full_utf8",
  text: "string_full_utf8",
  str: "string_full_utf8",
  int: "integer",
  integer: "integer",
  bool: "boolean",
  boolean: "boolean",
  datetime: "glide_date_time",
  date: "glide_date",
  reference: "reference",
  choice: "choice",
  decimal: "decimal",
  url: "url",
  email: "email",
  html: "html",
  journal: "journal"
};

/** Internal types that are valid as-is (a caller may pass the SN type directly). */
var KNOWN_INTERNAL: Record<string, boolean> = {
  string_full_utf8: true, string: true, integer: true, decimal: true, boolean: true,
  glide_date_time: true, glide_date: true, due_date: true, glide_duration: true,
  reference: true, choice: true, translated_text: true, html: true, url: true,
  email: true, journal: true, journal_input: true, currency: true, price: true,
  percent_complete: true, sys_class_name: true, document_id: true, field_name: true,
  table_name: true, json: true, script: true
};

/** Resolve a friendly-or-internal type string to the internal_type to write. */
export function resolveType(type: string): string {
  var t = String(type || "").trim().toLowerCase();
  if (!t) throw new Error("column type is required");
  if (Object.prototype.hasOwnProperty.call(TYPE_MAP, t)) return TYPE_MAP[t];
  if (KNOWN_INTERNAL[t] === true) return t;
  throw new Error("unknown column type '" + type + "'");
}

/** Validate + normalize the friendly column list. Throws on the broken cases. */
export function normalizeColumns(cols: Array<ColumnSpec>): Array<NormalizedColumn> {
  if (!Array.isArray(cols) || cols.length === 0) {
    throw new Error("createTable: at least one column is required.");
  }
  var out: Array<NormalizedColumn> = [];
  var seen: Record<string, boolean> = {};
  for (var i = 0; i < cols.length; i += 1) {
    var c = cols[i] || ({} as ColumnSpec);
    var label = typeof c.label === "string" ? c.label.trim() : "";
    if (!label) throw new Error("createTable: column #" + (i + 1) + " is missing a label.");
    var key = label.toLowerCase();
    if (seen[key]) throw new Error("createTable: duplicate column label '" + label + "'.");
    seen[key] = true;
    var internal = resolveType(c.type);
    var reference = typeof c.reference === "string" ? c.reference.trim() : "";
    if (internal === "reference" && !reference) {
      throw new Error("createTable: reference column '" + label + "' needs a reference target table.");
    }
    var maxLength = c.max_length === undefined || c.max_length === null ? "" : String(c.max_length).trim();
    // date/time types carry no max_length in Studio's payload.
    if (internal === "glide_date_time" || internal === "glide_date") maxLength = "";
    out.push({ label: label, type: internal, maxLength: maxLength, reference: reference });
  }
  return out;
}

/** Per-operation access flags; all default true (matches Studio's create defaults). */
export interface AccessFlags {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  ws: boolean;
  configuration: boolean;
  alter: boolean;
  actions: boolean;
  client_scripts: boolean;
}

export function defaultAccessFlags(): AccessFlags {
  return {
    read: true, create: true, update: true, delete: true, ws: true,
    configuration: true, alter: true, actions: true, client_scripts: true
  };
}

/** Everything the overlay needs that the new-record form can't supply. */
export interface OverlaySpec {
  name: string;
  label: string;
  tableSysId: string;
  saveActionSysId: string;
  superClassSysId: string;
  superClassLabel: string;
  scopeSysId: string;
  scopeLabel: string;
  numberPrefix: string;
  userRoleSysId: string;
  userRoleLabel: string;
  createAccessControls: boolean;
  access: string;
  accessFlags: AccessFlags;
  /** Application sys_id for the nav module; "" disables Show-in-menu. */
  selectedApplicationSysId: string;
  menuName: string;
  /** The discovered `ni.java...ListEditFormatterAction[sys_db_object.REL:<relId>]` key. */
  listEditKey: string;
  columnXml: string;
}

/** Build the `...ShowInMenuFormatterAction[<part>]` form key. */
export function showInMenuKey(part: string): string {
  return "ni.java.com.snc.apps.ShowInMenuFormatterAction[" + part + "]";
}

/** Build the `...ListEditFormatterAction[sys_db_object.REL:<relId>]` form key. */
export function listEditKey(relId: string): string {
  return "ni.java.com.glide.ui_list_edit.ListEditFormatterAction[sys_db_object.REL:" + relId + "]";
}

function flag(b: boolean): string { return b === true ? "true" : "false"; }

/**
 * Overlay the capability's values onto the base field map harvested from the live
 * new-record form. Returns a NEW object (base is not mutated). Sets exactly the
 * keys Studio mutates for a table create; everything else (sysparm_ck,
 * sysparm_encoded_record, the dynamic `<sysid>_text` field, all sys_original.*
 * defaults) is preserved from the harvested form.
 */
export function applyTableSaveOverlay(
  base: Record<string, string>,
  o: OverlaySpec
): Record<string, string> {
  var f: Record<string, string> = Object.assign({}, base);

  f["sys_target"] = "sys_db_object";
  f["sys_uniqueName"] = "sys_id";
  f["sys_uniqueValue"] = o.tableSysId;
  f["sys_row"] = "-1";
  f["sys_action"] = o.saveActionSysId;
  f["isFormPage"] = "true";
  f["sysparm_modify_check"] = "true";
  f["personalizer_sys_db_object"] = "true";

  f["sys_db_object.name"] = o.name;
  f["sys_db_object.label"] = o.label;

  f["sys_db_object.super_class"] = o.superClassSysId;
  f["sys_display.sys_db_object.super_class"] = o.superClassLabel;

  f["sys_original.sys_db_object.sys_scope"] = o.scopeSysId;
  f["sys_db_object.sys_scope"] = o.scopeSysId;
  f["sys_db_object.sys_scope_label"] = o.scopeLabel;
  f["sys_display.sys_db_object.sys_scope"] = o.scopeLabel;
  f["sys_display.original.sys_db_object.sys_scope"] = o.scopeLabel;

  f["sys_db_object.number_ref.prefix"] = o.numberPrefix;

  f["sys_db_object.create_access_controls"] = flag(o.createAccessControls);
  f["ni.sys_db_object.create_access_controls"] = flag(o.createAccessControls);

  f["sys_db_object.user_role"] = o.userRoleSysId;
  f["sys_display.sys_db_object.user_role"] = o.userRoleLabel;
  f["sys_display.original.sys_db_object.user_role"] = o.userRoleLabel;

  f["sys_db_object.access"] = o.access;
  setAccess(f, "read_access", o.accessFlags.read);
  setAccess(f, "create_access", o.accessFlags.create);
  setAccess(f, "update_access", o.accessFlags.update);
  setAccess(f, "delete_access", o.accessFlags.delete);
  setAccess(f, "ws_access", o.accessFlags.ws);
  setAccess(f, "configuration_access", o.accessFlags.configuration);
  setAccess(f, "alter_access", o.accessFlags.alter);
  setAccess(f, "actions_access", o.accessFlags.actions);
  setAccess(f, "client_scripts_access", o.accessFlags.client_scripts);

  // Show-in-menu nav module (optional).
  if (o.selectedApplicationSysId) {
    f[showInMenuKey("show_in_menu")] = "on";
    f[showInMenuKey("selected_application")] = o.selectedApplicationSysId;
    f[showInMenuKey("new_menu_name")] = o.menuName || o.label;
  }

  // The columns.
  if (o.listEditKey) {
    f[o.listEditKey] = o.columnXml;
  }

  return f;
}

function setAccess(f: Record<string, string>, key: string, on: boolean): void {
  f["sys_db_object." + key] = flag(on);
  f["ni.sys_db_object." + key] = flag(on);
}
