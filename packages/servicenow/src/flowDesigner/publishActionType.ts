/**
 * Publish a Custom Action Type — the real Flow Designer snapshot compiler.
 *
 * This is the working path that supersedes the degraded `triggerPublication`
 * (which only set status="published" and polled, with a comment admitting the
 * real snapshot trigger was an unknown "Phase 0 spike"). The Designer's
 * **Publish** button is a plain REST call that works with basic auth — no
 * session token, CSRF, or sn_build_agent role:
 *
 *   GET  /api/now/processflow/action/action_types/{sysId}?sysparm_transaction_scope={scope}
 *          -> 200, the full action-type model EXCEPT `steps` (which comes back null)
 *   POST /api/now/processflow/action/action_types/{sysId}/snapshot?sysparm_transaction_scope={scope}
 *          body = the model with a `steps` array grafted in
 *          -> 201 Created (compiles sys_hub_flow_snapshot; sets latest/master_snapshot;
 *             also persists step input values back to sys_variable_value)
 *
 * STEPS-FIXTURE CAVEAT: the GET returns `steps: null` even for a published
 * action — the Designer assembles `steps` client-side from the step records.
 * So a `steps` fixture is required to publish. Supply it via `params.steps`
 * (each step's `action` is remapped to `sysId`). If the model already carries
 * a non-empty `steps` array, that is used instead. If neither is available,
 * this throws — the caller must provide a steps fixture.
 *
 * Full write-up: docs/servicenow-flow-designer-headless-authoring.md.
 */

import type { ServiceNowClient } from "../client";

export interface PublishActionTypeParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_action_type_definition to publish. */
  sysId: string;
  /** Application scope sys_id, passed as sysparm_transaction_scope. */
  scopeSysId: string;
  /**
   * The `steps` array to graft onto the model. Required when the GET returns
   * `steps: null` (the normal case). Each step's `action` is remapped to `sysId`.
   * Omit only when the fetched model already carries a non-empty `steps` array.
   */
  steps?: Array<Record<string, any>>;
}

export interface PublishActionTypeResult {
  status: "published";
  /** HTTP status of the snapshot POST (201 on success). */
  httpStatus: number;
  /** sys_id of the compiled snapshot, when the response surfaces it. */
  snapshotSysId?: string;
}

function actionTypePath(sysId: string, scopeSysId: string, suffix: string): string {
  return "/api/now/processflow/action/action_types/" + encodeURIComponent(sysId)
    + suffix
    + "?sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}

/**
 * Unwrap the various response envelopes ServiceNow uses. The processflow
 * endpoints have been observed returning the model both bare and under
 * `result`; normalize to the model object.
 */
function unwrap(data: any): any {
  if (data && typeof data === "object" && data.result && typeof data.result === "object") {
    return data.result;
  }
  return data;
}

export async function publishActionType(params: PublishActionTypeParams): Promise<PublishActionTypeResult> {
  var client = params.client;
  var sysId = params.sysId;
  var scopeSysId = params.scopeSysId;

  if (!sysId) {
    throw new Error("publishActionType: sysId is required.");
  }
  if (!scopeSysId) {
    throw new Error("publishActionType: scopeSysId is required (sysparm_transaction_scope).");
  }

  // 1. GET the model. Returns everything except `steps` (always null).
  var getResp = await client.now.get<any>(actionTypePath(sysId, scopeSysId, ""));
  var model = unwrap(getResp);
  if (!model || typeof model !== "object") {
    throw new Error(
      "publishActionType: unexpected GET response for action type " + sysId
        + " — expected a model object, got: " + JSON.stringify(getResp).substring(0, 300)
    );
  }

  // 2. Resolve the steps to graft. Caller-supplied steps win; otherwise reuse
  //    a non-empty steps array already on the model. The GET returns steps:null,
  //    so in practice a steps fixture must be supplied — fail loudly if absent.
  var steps: Array<Record<string, any>> | null = null;
  if (params.steps && params.steps.length > 0) {
    steps = params.steps.map(function (step) {
      var copy: Record<string, any> = {};
      for (var key in step) {
        if (Object.prototype.hasOwnProperty.call(step, key)) {
          copy[key] = step[key];
        }
      }
      copy.action = sysId;
      return copy;
    });
  } else if (model.steps && Array.isArray(model.steps) && model.steps.length > 0) {
    steps = model.steps;
  }

  if (!steps || steps.length === 0) {
    throw new Error(
      "publishActionType: no steps to publish for action type " + sysId + ". "
        + "The GET returns steps:null, so you must supply a steps fixture via params.steps. "
        + "See docs/servicenow-flow-designer-headless-authoring.md."
    );
  }

  model.steps = steps;

  // 3. POST the grafted model to /snapshot — compiles the snapshot (201).
  var snapResp = await client.now.post<any>(actionTypePath(sysId, scopeSysId, "/snapshot"), model);
  var snapBody = unwrap(snapResp);

  // request() throws on any non-2xx, so reaching here means a 2xx (201 in practice).
  var snapshotSysId: string | undefined;
  if (snapBody && typeof snapBody === "object") {
    // The snapshot ref is surfaced under different keys and as either a bare
    // sys_id string or a record object — coerce whichever is present to a string.
    var snap = snapBody.latest_snapshot || snapBody.master_snapshot || snapBody.snapshot;
    if (snap && typeof snap === "object") {
      snapshotSysId = typeof snap.sys_id === "string" ? snap.sys_id : undefined;
    } else if (typeof snap === "string") {
      snapshotSysId = snap;
    }
  }

  return {
    status: "published",
    httpStatus: 201,
    snapshotSysId: snapshotSysId
  };
}
