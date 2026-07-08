/**
 * Shared helpers for the form / list / view layout reconcilers.
 *
 * Every layout function follows the addChoicesToField contract: resolve the
 * view and scope, assert the update set is in progress, query existing
 * sys_ui_* rows, diff against the desired spec, and write only the delta
 * through the Dovetail REST API. These helpers carry the cross-cutting parts.
 */

import type { ServiceNowClient } from "../client";
import type { LayoutAction } from "../types";

/**
 * ServiceNow encoded-query values treat comma, caret and equals as delimiters.
 * Table / column / view names never legitimately contain them, so surface such
 * input loudly rather than building a silently broken query.
 */
export function encodeQueryValue(value: string): string {
  if (/[,^=]/.test(value)) {
    throw new Error(
      "Invalid character in query value: " + JSON.stringify(value),
    );
  }
  return value;
}

/**
 * The Table API echoes an empty UI-view reference (the Default view) as the
 * literal string "Default view". Normalize that and a genuine empty value to
 * "" so Default-view records compare equal.
 */
export function normalizeViewValue(raw: any): string {
  var v = raw && typeof raw === "object" ? raw.value : raw;
  if (!v || v === "Default view") {
    return "";
  }
  return String(v);
}

/** Extract the plain value of a field that may be a { value, link } reference. */
function plain(raw: any): string {
  if (raw && typeof raw === "object") {
    return raw.value !== undefined ? raw.value : "";
  }
  return raw === undefined || raw === null ? "" : String(raw);
}

export interface UpdateSetRef {
  sysId: string;
  name: string;
}

/**
 * Fetch the update set and confirm it can capture changes. Mirrors the guard
 * in addChoicesToField — writes to a non-"in progress" set are silently lost.
 */
export async function assertUpdateSet(
  client: ServiceNowClient,
  updateSetSysId: string,
): Promise<UpdateSetRef> {
  if (!updateSetSysId) {
    throw new Error(
      "updateSetSysId is required — every layout write must be captured in a named update set.",
    );
  }
  var rows = await client.table.query<any>(
    "sys_update_set",
    "sys_id=" + encodeQueryValue(updateSetSysId),
    1,
  );
  if (rows.length === 0) {
    throw new Error(
      "Update set " +
        updateSetSysId +
        " not found — verify the sys_id and your access.",
    );
  }
  var state = plain(rows[0].state);
  if (state && state !== "in progress" && state !== "in_progress") {
    throw new Error(
      "Update set " +
        (plain(rows[0].name) || updateSetSysId) +
        " is in state '" +
        state +
        "' — only 'in progress' update sets can capture new changes.",
    );
  }
  return { sysId: updateSetSysId, name: plain(rows[0].name) || updateSetSysId };
}

/**
 * Resolve the application-scope namespace for a table's layout records.
 * An explicit scope wins; otherwise it is read from sys_db_object.sys_scope.
 * Falls back to "global" for unscoped / base tables.
 */
export async function resolveScope(
  client: ServiceNowClient,
  table: string,
  explicitScope?: string,
): Promise<string> {
  if (explicitScope) {
    return explicitScope;
  }
  var dbo = await client.table.query<any>(
    "sys_db_object",
    "name=" + encodeQueryValue(table),
    1,
  );
  if (dbo.length === 0) {
    throw new Error(
      "Table '" +
        table +
        "' not found in sys_db_object — verify the table name.",
    );
  }
  var scopeSysId = plain(dbo[0].sys_scope);
  if (!scopeSysId) {
    return "global";
  }
  var scopeRows = await client.table.query<any>(
    "sys_scope",
    "sys_id=" + encodeQueryValue(scopeSysId),
    1,
  );
  if (scopeRows.length === 0) {
    return "global";
  }
  return plain(scopeRows[0].scope) || plain(scopeRows[0].name) || "global";
}

export interface ResolvedView {
  /** sys_id of the sys_ui_view row; "" for the Default view. */
  sysId: string;
  /** View name; "" for the Default view. */
  name: string;
  /** Whether the view already existed or was created by this call. */
  action: LayoutAction;
}

export interface ResolveViewOptions {
  /** View name; "" or omitted resolves to the Default view. */
  viewName: string;
  updateSetSysId: string;
  /** Scope namespace for a newly created view. */
  scope: string;
  /** When true, a missing view is reported as a planned create, not written. */
  dryRun: boolean;
  /** Optional display title for a newly created view. Defaults to the name. */
  title?: string;
}

/**
 * Resolve a view name to its sys_ui_view row, creating the view if it does not
 * exist. An empty name resolves to the Default view ({ sysId:"", name:"" }) —
 * the Default view has no sys_ui_view record.
 */
export async function resolveView(
  client: ServiceNowClient,
  options: ResolveViewOptions,
): Promise<ResolvedView> {
  var name = (options.viewName || "").trim();
  if (!name) {
    return { sysId: "", name: "", action: "unchanged" };
  }
  var rows = await client.table.query<any>(
    "sys_ui_view",
    "name=" + encodeQueryValue(name),
    1,
  );
  if (rows.length > 0) {
    return { sysId: plain(rows[0].sys_id), name: name, action: "unchanged" };
  }
  if (options.dryRun) {
    return { sysId: "", name: name, action: "created" };
  }
  var created = await client.claude.createRecord({
    table: "sys_ui_view",
    fields: { name: name, title: options.title || name },
    scope: options.scope || "global",
    update_set_sys_id: options.updateSetSysId,
  });
  return { sysId: created.sys_id, name: name, action: "created" };
}

/**
 * The view + view_name field pair to stamp on a sys_ui_form / sys_ui_section /
 * sys_ui_list / sys_ui_related_list record. Both are blank for the Default view.
 */
export function viewFields(view: ResolvedView): {
  view: string;
  view_name: string;
} {
  return { view: view.sysId, view_name: view.name };
}

export interface ExistingChild {
  sysId: string;
  /** Identity within the parent: element name, section caption, or related-list id. */
  key: string;
  position: number;
}

export interface ChildPlan {
  action: "create" | "update" | "delete" | "unchanged";
  key: string;
  /** sys_id of the existing row; "" for a create. */
  sysId: string;
  /** Target 0-based position; -1 for a delete. */
  position: number;
}

/**
 * Reconcile an ordered desired list against existing child rows.
 *
 * Desired keys are placed at contiguous 0-based positions. With prune, existing
 * rows whose key is not in the desired list are deleted; without prune they are
 * kept and repositioned after the desired block. Duplicate existing keys keep
 * the first row and treat the rest as extras. `desiredKeys` must be unique —
 * callers dedupe their input first.
 */
export function diffChildren(
  desiredKeys: Array<string>,
  existing: Array<ExistingChild>,
  prune: boolean,
): Array<ChildPlan> {
  var byKey: Record<string, ExistingChild> = {};
  var extras: Array<ExistingChild> = [];
  var i;
  for (i = 0; i < existing.length; i += 1) {
    var row = existing[i];
    if (Object.prototype.hasOwnProperty.call(byKey, row.key)) {
      extras.push(row);
    } else {
      byKey[row.key] = row;
    }
  }
  var used: Record<string, boolean> = {};
  var plan: Array<ChildPlan> = [];
  for (i = 0; i < desiredKeys.length; i += 1) {
    var key = desiredKeys[i];
    var match = used[key] ? undefined : byKey[key];
    if (match) {
      used[key] = true;
      plan.push({
        action: match.position === i ? "unchanged" : "update",
        key: key,
        sysId: match.sysId,
        position: i,
      });
    } else {
      plan.push({ action: "create", key: key, sysId: "", position: i });
    }
  }
  var leftover: Array<ExistingChild> = extras.slice();
  Object.keys(byKey).forEach(function (k) {
    if (!used[k]) {
      leftover.push(byKey[k]);
    }
  });
  leftover.sort(function (a, b) {
    return a.position - b.position;
  });
  if (prune) {
    for (i = 0; i < leftover.length; i += 1) {
      plan.push({
        action: "delete",
        key: leftover[i].key,
        sysId: leftover[i].sysId,
        position: -1,
      });
    }
  } else {
    var next = desiredKeys.length;
    for (i = 0; i < leftover.length; i += 1) {
      plan.push({
        action: leftover[i].position === next ? "unchanged" : "update",
        key: leftover[i].key,
        sysId: leftover[i].sysId,
        position: next,
      });
      next += 1;
    }
  }
  return plan;
}
