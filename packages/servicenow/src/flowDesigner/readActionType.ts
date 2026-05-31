/**
 * Read a Custom Action Type — the compiled action model, headless.
 *
 * The READ counterpart of publishActionType's GET. Same endpoint the publisher
 * fetches before grafting `steps`:
 *
 *   GET /api/now/processflow/action/action_types/{sysId}?sysparm_transaction_scope={scope}
 *     -> 200, the full action-type model: { displayName, internalName, inputs[],
 *              outputs[], description, type, label_cache[], ... , steps: null }
 *
 * `steps` comes back null even for a published action — the Designer assembles
 * it client-side from the step records — so this reader surfaces identity,
 * inputs, and outputs (the action's contract). Pass `raw: true` for the full
 * model (e.g. to feed publishActionType or for round-trip diffing).
 */

import type { ServiceNowClient } from "../client";

export interface ReadActionTypeParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_action_type_definition to read. */
  sysId: string;
  /** Application scope sys_id, passed as sysparm_transaction_scope. */
  scopeSysId: string;
  /** When true, include the unmodified model on the result as `raw`. */
  raw?: boolean;
}

export interface ActionIo {
  name: string;
  label: string;
  type: string;
}

export interface ReadActionTypeResult {
  sysId: string;
  name: string;
  internalName: string;
  description: string;
  inputs: Array<ActionIo>;
  outputs: Array<ActionIo>;
  counts: { inputs: number; outputs: number };
  /** The unmodified model — present only when params.raw is true. */
  raw?: any;
}

function actionTypePath(sysId: string, scopeSysId: string): string {
  return "/api/now/processflow/action/action_types/" + encodeURIComponent(sysId)
    + "?sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}

function unwrap(data: any): any {
  if (data && typeof data === "object" && data.result && typeof data.result === "object") {
    return data.result;
  }
  return data;
}

function val(field: any): string {
  if (field === null || field === undefined) {
    return "";
  }
  if (typeof field === "object") {
    return field.value !== undefined && field.value !== null ? String(field.value) : "";
  }
  return String(field);
}

function mapIo(arr: any): Array<ActionIo> {
  var out: Array<ActionIo> = [];
  if (!Array.isArray(arr)) {
    return out;
  }
  for (var i = 0; i < arr.length; i += 1) {
    var io = arr[i];
    out.push({
      name: val(io.name),
      label: val(io.label) || val(io.name),
      type: val(io.type_label) || val(io.type)
    });
  }
  return out;
}

export async function readActionType(params: ReadActionTypeParams): Promise<ReadActionTypeResult> {
  var client = params.client;
  var sysId = params.sysId;
  var scopeSysId = params.scopeSysId;

  if (!sysId) {
    throw new Error("readActionType: sysId is required.");
  }
  if (!scopeSysId) {
    throw new Error("readActionType: scopeSysId is required (sysparm_transaction_scope).");
  }

  var resp = await client.now.get<any>(actionTypePath(sysId, scopeSysId));
  var model = unwrap(resp);
  if (!model || typeof model !== "object") {
    throw new Error(
      "readActionType: unexpected response for action type " + sysId
        + " — expected a model object, got: " + JSON.stringify(resp).substring(0, 300)
    );
  }

  var inputs = mapIo(model.inputs);
  var outputs = mapIo(model.outputs);

  var result: ReadActionTypeResult = {
    sysId: val(model.sys_id) || sysId,
    name: val(model.displayName) || val(model.name),
    internalName: val(model.internal_name) || val(model.internalName),
    description: val(model.description),
    inputs: inputs,
    outputs: outputs,
    counts: { inputs: inputs.length, outputs: outputs.length }
  };

  if (params.raw) {
    result.raw = model;
  }

  return result;
}
