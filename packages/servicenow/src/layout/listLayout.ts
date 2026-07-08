/**
 * setListLayout — declaratively reconcile a ServiceNow list layout.
 *
 * A list layout is a sys_ui_list row (keyed by table + view + parent + global
 * sys_user) plus an ordered set of sys_ui_list_element column rows. The caller
 * supplies the desired ordered columns; this upserts the list, then creates /
 * repositions / deletes column rows so the layout matches — writing only the
 * delta through the Dovetail REST API so every change lands in the update set.
 */

import type { ServiceNowClient } from "../client";
import type {
  SetListLayoutParams,
  LayoutResult,
  LayoutRecordResult,
} from "../types";
import {
  assertUpdateSet,
  resolveScope,
  resolveView,
  viewFields,
  normalizeViewValue,
  encodeQueryValue,
  diffChildren,
} from "./layoutCommon";
import type { ExistingChild } from "./layoutCommon";

/** Extract the plain value of a field that may be a { value, link } reference. */
function plain(raw: any): string {
  if (raw && typeof raw === "object") {
    return raw.value !== undefined ? raw.value : "";
  }
  return raw === undefined || raw === null ? "" : String(raw);
}

/** Dedupe an ordered list of strings, keeping first occurrence. */
function dedupe(values: Array<string>): Array<string> {
  var seen: Record<string, boolean> = {};
  var out: Array<string> = [];
  values.forEach(function (v) {
    if (!seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  });
  return out;
}

export async function setListLayout(
  client: ServiceNowClient,
  params: SetListLayoutParams,
): Promise<LayoutResult> {
  if (!params.table) {
    throw new Error("table is required.");
  }
  if (!params.columns || params.columns.length === 0) {
    throw new Error("columns must be a non-empty array.");
  }
  var prune = params.prune !== false;
  var dryRun = params.dryRun === true;
  var parent = params.parent || "";
  var columns = dedupe(params.columns);

  var updateSet = await assertUpdateSet(client, params.updateSetSysId);
  var scope = await resolveScope(client, params.table, params.scope);
  var view = await resolveView(client, {
    viewName: params.view || "",
    updateSetSysId: params.updateSetSysId,
    scope: scope,
    dryRun: dryRun,
  });

  var records: Array<LayoutRecordResult> = [];
  // A named view that does not exist yet (only possible under dryRun) cannot
  // have any existing layout records to reconcile against.
  var viewMissing = view.name !== "" && view.sysId === "";

  // 1. Resolve the sys_ui_list parent row (table + view + parent + global sys_user).
  var list: any = null;
  if (!viewMissing) {
    var listRows = await client.table.query<any>(
      "sys_ui_list",
      "name=" + encodeQueryValue(params.table),
      200,
    );
    for (var i = 0; i < listRows.length; i += 1) {
      var r = listRows[i];
      if (
        normalizeViewValue(r.view) === view.sysId &&
        plain(r.sys_user) === "" &&
        plain(r.parent) === parent
      ) {
        list = r;
        break;
      }
    }
  }
  var listSysId = list ? plain(list.sys_id) : "";

  if (list) {
    records.push({
      table: "sys_ui_list",
      sysId: listSysId,
      action: "unchanged",
      label: params.table,
    });
  } else if (dryRun) {
    records.push({
      table: "sys_ui_list",
      sysId: "",
      action: "created",
      label: params.table,
    });
  } else {
    var vf = viewFields(view);
    var createdList = await client.claude.createRecord({
      table: "sys_ui_list",
      fields: {
        name: params.table,
        view: vf.view,
        view_name: vf.view_name,
        parent: parent,
        sys_user: "",
      },
      scope: scope,
      update_set_sys_id: params.updateSetSysId,
    });
    listSysId = createdList.sys_id;
    records.push({
      table: "sys_ui_list",
      sysId: listSysId,
      action: "created",
      label: params.table,
    });
  }

  // 2. Existing column rows.
  var existing: Array<ExistingChild> = [];
  if (listSysId) {
    var elRows = await client.table.query<any>(
      "sys_ui_list_element",
      "list_id=" + encodeQueryValue(listSysId),
      500,
    );
    existing = elRows.map(function (e: any): ExistingChild {
      return {
        sysId: plain(e.sys_id),
        key: plain(e.element),
        position: Number(plain(e.position)) || 0,
      };
    });
  }

  // 3. Diff desired columns against existing rows.
  var plan = diffChildren(columns, existing, prune);

  // 4. Apply (or, under dryRun, just report the plan).
  for (var p = 0; p < plan.length; p += 1) {
    var step = plan[p];
    if (step.action === "unchanged") {
      records.push({
        table: "sys_ui_list_element",
        sysId: step.sysId,
        action: "unchanged",
        label: step.key,
      });
    }
  }
  if (dryRun) {
    for (var d = 0; d < plan.length; d += 1) {
      var ds = plan[d];
      if (ds.action === "create") {
        records.push({
          table: "sys_ui_list_element",
          sysId: "",
          action: "created",
          label: ds.key,
        });
      } else if (ds.action === "update") {
        records.push({
          table: "sys_ui_list_element",
          sysId: ds.sysId,
          action: "updated",
          label: ds.key,
        });
      } else if (ds.action === "delete") {
        records.push({
          table: "sys_ui_list_element",
          sysId: ds.sysId,
          action: "deleted",
          label: ds.key,
        });
      }
    }
    return {
      table: params.table,
      view: view.name,
      updateSet: updateSet,
      dryRun: true,
      records: records,
    };
  }

  // Creates and updates first; deletes last so a failure cannot strand a
  // half-applied layout.
  for (var c = 0; c < plan.length; c += 1) {
    if (plan[c].action !== "create") {
      continue;
    }
    var created = await client.claude.createRecord({
      table: "sys_ui_list_element",
      fields: {
        list_id: listSysId,
        element: plan[c].key,
        position: String(plan[c].position),
      },
      scope: scope,
      update_set_sys_id: params.updateSetSysId,
    });
    records.push({
      table: "sys_ui_list_element",
      sysId: created.sys_id,
      action: "created",
      label: plan[c].key,
    });
  }
  for (var u = 0; u < plan.length; u += 1) {
    if (plan[u].action !== "update") {
      continue;
    }
    await client.claude.pushWithUpdateSet({
      update_set_sys_id: params.updateSetSysId,
      table: "sys_ui_list_element",
      record_sys_id: plan[u].sysId,
      fields: { position: String(plan[u].position) },
    });
    records.push({
      table: "sys_ui_list_element",
      sysId: plan[u].sysId,
      action: "updated",
      label: plan[u].key,
    });
  }
  var deletes = plan.filter(function (s) {
    return s.action === "delete";
  });
  if (deletes.length > 0) {
    // deleteRecord has no update-set parameter — pin the REST session's active
    // update set so the deletions are captured for promotion.
    await client.claude.changeUpdateSet({ sysId: params.updateSetSysId });
    for (var x = 0; x < deletes.length; x += 1) {
      await client.claude.deleteRecord({
        table: "sys_ui_list_element",
        sys_id: deletes[x].sysId,
      });
      records.push({
        table: "sys_ui_list_element",
        sysId: deletes[x].sysId,
        action: "deleted",
        label: deletes[x].key,
      });
    }
  }
  return {
    table: params.table,
    view: view.name,
    updateSet: updateSet,
    dryRun: false,
    records: records,
  };
}
