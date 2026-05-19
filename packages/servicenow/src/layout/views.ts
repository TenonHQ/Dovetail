/**
 * createView — find-or-create a ServiceNow named view (sys_ui_view).
 *
 * sys_ui_view is the table of ServiceNow named views, keyed by `name` with a
 * display `title`. The Default view has no record. This is a thin public
 * wrapper around layoutCommon.resolveView, which already implements the
 * find-or-create — writing the create through the Dovetail REST API so it
 * lands in the supplied update set.
 */

import type { ServiceNowClient } from "../client";
import type { CreateViewParams, CreateViewResult } from "../types";
import { assertUpdateSet, resolveView } from "./layoutCommon";

export async function createView(
  client: ServiceNowClient,
  params: CreateViewParams
): Promise<CreateViewResult> {
  if (!params.name) {
    throw new Error("name is required.");
  }
  var dryRun = params.dryRun === true;
  var updateSet = await assertUpdateSet(client, params.updateSetSysId);
  var scope = params.scope || "global";
  var resolved = await resolveView(client, {
    viewName: params.name,
    updateSetSysId: params.updateSetSysId,
    scope: scope,
    dryRun: dryRun,
    title: params.title
  });
  return {
    view: {
      sysId: resolved.sysId,
      name: resolved.name,
      title: params.title || params.name,
      action: resolved.action
    },
    updateSet: updateSet,
    dryRun: dryRun
  };
}
