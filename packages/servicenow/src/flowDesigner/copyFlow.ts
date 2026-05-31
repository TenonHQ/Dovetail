/**
 * Copy a Flow Designer flow or subflow — the Designer's own "Copy flow" action,
 * headless.
 *
 * The Workflow Studio "Copy flow" button calls a clean REST endpoint (captured
 * from a HAR, same family as the publish/snapshot endpoint), which works for the
 * integration user with basic auth:
 *
 *   POST /api/now/processflow/flow/{sourceSysId}/copy?sysparm_transaction_scope={scope}
 *     body: { name: "<new flow name>", scope: "<target scope sys_id>" }
 *     -> 200, { result: { data: "<new flow sys_id>" } } — the copy is a complete,
 *        faithful clone (trigger + all actions + variables + properties), created
 *        as an INACTIVE DRAFT.
 *
 * This supersedes the record-graph clone (cloneSubflow), which can't work for
 * the integration user: the design tables (sys_hub_flow_input/action_instance)
 * ignore sysparm_query on the plain Table API, and the build-agent endpoint that
 * honors the filter returns 401 without the Build Agent role — so a record-graph
 * read either 401s or scans the whole table. The platform copy endpoint sidesteps
 * all of that: ServiceNow assembles the copy server-side.
 *
 * The copy lands in `scopeSysId` (sysparm_transaction_scope) — which may differ
 * from the source's scope — as an inactive draft. Publish it with publishFlow
 * when ready. Do NOT publish + activate a copy of a triggered production flow
 * unless you intend it to fire (e.g. a Send-SMS flow would duplicate sends).
 */

import type { ServiceNowClient } from "../client";

export interface CopyFlowParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_flow (flow or subflow) to copy. */
  sourceSysId: string;
  /** Name for the new copy. */
  newName: string;
  /**
   * Target application scope sys_id (sysparm_transaction_scope) the copy is
   * created in. Optional — defaults to the source flow's own scope (read first).
   */
  scopeSysId?: string;
}

export interface CopyFlowResult {
  /** sys_id of the newly created copy. */
  sysId: string;
  /** Name of the copy (echoes newName). */
  name: string;
  /** The scope the copy was created in. */
  scopeSysId: string;
}

/**
 * Pull the new flow's sys_id from the copy response. The endpoint returns the
 * new sys_id as a bare string under `result.data`; older/alternate shapes may
 * nest it under a model object's `id`/`sys_id`.
 */
function extractCopiedSysId(resp: any): string {
  if (resp && typeof resp === "object" && resp.result && typeof resp.result === "object") {
    var d = resp.result.data;
    if (typeof d === "string" && d.length >= 32) {
      return d;
    }
    if (d && typeof d === "object") {
      if (typeof d.id === "string") return d.id;
      if (typeof d.sys_id === "string") return d.sys_id;
    }
  }
  if (resp && typeof resp === "object") {
    if (typeof resp.id === "string") return resp.id;
    if (typeof resp.sys_id === "string") return resp.sys_id;
  }
  return "";
}

function flowGetPath(sysId: string): string {
  return "/api/now/processflow/flow/" + encodeURIComponent(sysId);
}

function copyPath(sourceSysId: string, scopeSysId: string): string {
  return "/api/now/processflow/flow/" + encodeURIComponent(sourceSysId) + "/copy"
    + "?sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}

function unwrapModel(data: any): any {
  if (data && typeof data === "object" && data.result && typeof data.result === "object") {
    if (data.result.data && typeof data.result.data === "object") {
      return data.result.data;
    }
    return data.result;
  }
  if (data && typeof data === "object" && data.data && typeof data.data === "object") {
    return data.data;
  }
  return data;
}

export async function copyFlow(params: CopyFlowParams): Promise<CopyFlowResult> {
  var client = params.client;
  var sourceSysId = params.sourceSysId;

  if (!sourceSysId) {
    throw new Error("copyFlow: sourceSysId is required.");
  }
  if (typeof params.newName !== "string" || params.newName.trim().length === 0) {
    throw new Error("copyFlow: newName is required.");
  }

  // Resolve the target scope: explicit param, else the source flow's own scope.
  var scopeSysId = params.scopeSysId;
  if (!scopeSysId) {
    var src = unwrapModel(await client.now.get<any>(flowGetPath(sourceSysId)));
    if (src && typeof src.scope === "string") {
      scopeSysId = src.scope;
    }
  }
  if (!scopeSysId) {
    throw new Error(
      "copyFlow: scopeSysId is required and the source flow carried no `scope` to default from."
    );
  }

  var resp = await client.now.post<any>(
    copyPath(sourceSysId, scopeSysId),
    { name: params.newName, scope: scopeSysId }
  );
  var newSysId = extractCopiedSysId(resp);
  if (!newSysId) {
    throw new Error(
      "copyFlow: the copy succeeded but no new flow sys_id was found in the response: "
        + JSON.stringify(resp).substring(0, 300)
    );
  }

  return {
    sysId: newSysId,
    name: params.newName,
    scopeSysId: scopeSysId
  };
}
