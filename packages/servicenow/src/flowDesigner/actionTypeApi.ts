/**
 * Shared processflow helpers for Custom Action Type authoring — the path
 * builder, the `{ result: ... }` envelope unwrap, and the `/step_instances`
 * read that editActionType and cloneActionType both depend on.
 *
 *   GET /api/now/processflow/action/action_types/{id}/step_instances?sysparm_transaction_scope={scope}
 *     -> { steps: [...] }   (bare or under `result`)
 *
 * The action-type model GET returns `steps: null`; this is where the Designer
 * (and we) get the real step graph.
 */

import type { ServiceNowClient } from "../client";
import type { StepRecord } from "./stepOps";

/** Build `/api/now/processflow/action/action_types/{sysId}{suffix}?sysparm_transaction_scope={scope}`. */
export function actionTypePath(sysId: string, scopeSysId: string, suffix: string): string {
  return "/api/now/processflow/action/action_types/" + encodeURIComponent(sysId)
    + suffix
    + "?sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}

/** Normalize the `{ result: ... }` envelope the processflow endpoints sometimes use. */
export function unwrapProcessflow(data: unknown): unknown {
  if (data && typeof data === "object") {
    var rec = data as Record<string, unknown>;
    if (rec.result && typeof rec.result === "object") {
      return rec.result;
    }
  }
  return data;
}

/**
 * GET an action type's step graph from `/step_instances` and unwrap `{ steps }`.
 * Returns [] when the response carries no steps array — callers decide whether
 * an empty graph is an error.
 */
export async function fetchActionSteps(
  client: ServiceNowClient,
  sysId: string,
  scopeSysId: string
): Promise<Array<StepRecord>> {
  var resp = unwrapProcessflow(await client.now.get<unknown>(actionTypePath(sysId, scopeSysId, "/step_instances")));
  if (resp && typeof resp === "object") {
    var steps = (resp as Record<string, unknown>).steps;
    if (Array.isArray(steps)) {
      return steps as Array<StepRecord>;
    }
  }
  return [];
}
