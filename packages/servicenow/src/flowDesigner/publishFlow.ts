/**
 * Publish a Flow Designer flow or subflow — compile its snapshot, headless.
 *
 * The flow counterpart of publishActionType. The Designer's Publish button for
 * a flow/subflow is a plain REST call that works with basic auth:
 *
 *   GET  /api/now/processflow/flow/{flowSysId}
 *          -> 200, the full compiled model { data: { actionInstances[],
 *             flowLogicInstances[], scope, ... } }
 *   POST /api/now/processflow/flow/{flowSysId}/snapshot?sysparm_transaction_scope={scope}
 *          body = that model
 *          -> 2xx (compiles sys_hub_flow_snapshot; advances latest/master_snapshot)
 *
 * Unlike action types — whose GET returns `steps: null`, forcing a steps
 * fixture — the flow GET already carries the full actionInstances /
 * flowLogicInstances graph, so we re-POST the fetched model as-is. This makes
 * publishFlow a faithful "recompile the current design" operation; callers who
 * want to publish *edited* content pass the edited model via `params.model`.
 *
 * The scope (sysparm_transaction_scope) defaults to the model's own `scope`.
 *
 * NOTE: the POST endpoint shape was validated read-only (a fake id returns
 * 400 "Flow id cannot be null or empty"); confirm one controlled live publish
 * on a throwaway flow before relying on it in automation.
 */

import type { ServiceNowClient } from "../client";

export interface PublishFlowParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_flow (flow or subflow) to publish. */
  sysId: string;
  /**
   * Application scope sys_id for sysparm_transaction_scope. Optional — defaults
   * to the `scope` on the fetched model.
   */
  scopeSysId?: string;
  /**
   * A model object to POST instead of the freshly fetched one. Use to publish
   * edited content (e.g. from readFlow({raw:true}) then mutated). When omitted,
   * the current model is fetched and re-posted (recompile-as-is).
   */
  model?: any;
}

export interface PublishFlowResult {
  status: "published";
  /** HTTP status of the snapshot POST. */
  httpStatus: number;
  /** sys_id of the compiled snapshot, when the response surfaces it. */
  snapshotSysId?: string;
}

function flowGetPath(sysId: string): string {
  return "/api/now/processflow/flow/" + encodeURIComponent(sysId);
}

function flowSnapshotPath(sysId: string, scopeSysId: string): string {
  return (
    "/api/now/processflow/flow/" +
    encodeURIComponent(sysId) +
    "/snapshot" +
    "?sysparm_transaction_scope=" +
    encodeURIComponent(scopeSysId)
  );
}

/** Normalize `{ result: { data } }` / `{ data }` / `{ result }` / bare to the model. */
function unwrapModel(data: any): any {
  if (
    data &&
    typeof data === "object" &&
    data.result &&
    typeof data.result === "object"
  ) {
    if (data.result.data && typeof data.result.data === "object") {
      return data.result.data;
    }
    return data.result;
  }
  if (
    data &&
    typeof data === "object" &&
    data.data &&
    typeof data.data === "object"
  ) {
    return data.data;
  }
  return data;
}

function extractSnapshotSysId(body: any): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  var snap =
    body.latestSnapshot ||
    body.masterSnapshot ||
    body.latest_snapshot ||
    body.master_snapshot ||
    body.snapshot;
  if (snap && typeof snap === "object") {
    return typeof snap.sys_id === "string" ? snap.sys_id : undefined;
  }
  if (typeof snap === "string") {
    return snap;
  }
  return undefined;
}

export async function publishFlow(
  params: PublishFlowParams,
): Promise<PublishFlowResult> {
  var client = params.client;
  var sysId = params.sysId;

  if (!sysId) {
    throw new Error("publishFlow: sysId is required.");
  }

  // 1. Resolve the model to publish: caller-supplied edited model, else fetch current.
  var model = params.model;
  if (!model) {
    var getResp = await client.now.get<any>(flowGetPath(sysId));
    model = unwrapModel(getResp);
  }
  if (!model || typeof model !== "object") {
    throw new Error(
      "publishFlow: could not resolve a model object for flow " +
        sysId +
        " — pass params.model or ensure the flow GET returns one.",
    );
  }

  // 2. Resolve scope: explicit param, else the model's own scope.
  var scopeSysId = params.scopeSysId;
  if (!scopeSysId && typeof model.scope === "string") {
    scopeSysId = model.scope;
  }
  if (!scopeSysId) {
    throw new Error(
      "publishFlow: scopeSysId is required and the model carried no `scope` to default from.",
    );
  }

  // 3. POST the model to /snapshot — compiles the snapshot. request() throws on
  //    non-2xx, so reaching past this is a success.
  var snapResp = await client.now.post<any>(
    flowSnapshotPath(sysId, scopeSysId),
    model,
  );
  var snapBody = unwrapModel(snapResp);

  return {
    status: "published",
    httpStatus: 200,
    snapshotSysId: extractSnapshotSysId(snapBody),
  };
}
