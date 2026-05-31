/**
 * Edit a Flow Designer flow or subflow in place, headless.
 *
 * Strategy: read the compiled model (GET /processflow/flow/{id}), apply a small
 * set of declarative mutations to it, then re-publish it (POST .../snapshot via
 * publishFlow). The publish POST persists step input values back to the design
 * records — the same mechanism the Designer's Publish button uses — so a patched
 * model lands in both the running snapshot and the records the Designer reads.
 *
 * Supported edits (intentionally narrow + safe — no structural step add/remove,
 * which requires the V2 instance graph and is out of scope here):
 *   - rename:          set name / internalName on the flow
 *   - description:     set the flow description
 *   - patchStepInputs: set named input values on specific steps (by uiId or label)
 *
 * Anything unmatched is reported in `result.warnings` rather than silently
 * dropped, so a typo'd step label or input name is visible.
 *
 * By default this is a DRY RUN — it computes and returns the diff WITHOUT
 * publishing. Pass `apply: true` to actually publish the edited model (a write).
 */

import type { ServiceNowClient } from "../client";
import { readFlow } from "./readFlow";
import { publishFlow } from "./publishFlow";

export interface StepInputPatch {
  /** Identify the step by its uiUniqueIdentifier OR its label (name). */
  step: string;
  /** The input's `name` on the action instance. */
  input: string;
  /** New value to set (may be any JSON value, including the empty string). */
  value?: any;
}

export interface EditFlowOps {
  rename?: { name?: string; internalName?: string };
  description?: string;
  patchStepInputs?: Array<StepInputPatch>;
}

export interface EditFlowParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_flow (flow or subflow) to edit. */
  sysId: string;
  ops: EditFlowOps;
  /** When true, publish the edited model. When false/omitted, dry-run (no write). */
  apply?: boolean;
  /** Override sysparm_transaction_scope for the publish; defaults to the model's scope. */
  scopeSysId?: string;
}

export interface EditFlowResult {
  /** "dry-run" (computed, not published) or "published". */
  status: "dry-run" | "published";
  /** Human-readable list of changes that were applied to the model. */
  changes: Array<string>;
  /** Requested edits that could not be matched (e.g. unknown step or input). */
  warnings: Array<string>;
  /** Present when status="published". */
  snapshotSysId?: string;
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

/** Find an action instance in the model by uiUniqueIdentifier or by name (label). */
function findStep(model: any, ref: string): any {
  var arrays = [model.actionInstances, model.flowLogicInstances];
  for (var a = 0; a < arrays.length; a += 1) {
    var arr = arrays[a];
    if (!Array.isArray(arr)) {
      continue;
    }
    for (var i = 0; i < arr.length; i += 1) {
      var inst = arr[i];
      if (inst && (inst.uiUniqueIdentifier === ref || inst.name === ref || inst.internalName === ref)) {
        return inst;
      }
    }
  }
  return null;
}

/** Set an input's value on an instance by input name. Returns true if matched. */
function setInputValue(inst: any, inputName: string, value: any): boolean {
  if (!inst || !Array.isArray(inst.inputs)) {
    return false;
  }
  for (var i = 0; i < inst.inputs.length; i += 1) {
    if (inst.inputs[i] && inst.inputs[i].name === inputName) {
      inst.inputs[i].value = value;
      return true;
    }
  }
  return false;
}

export async function editFlow(params: EditFlowParams): Promise<EditFlowResult> {
  var client = params.client;
  var sysId = params.sysId;
  var ops = params.ops || {};

  if (!sysId) {
    throw new Error("editFlow: sysId is required.");
  }

  // Read the full model — we need the raw instance graph to patch it.
  var read = await readFlow({ client: client, sysId: sysId, raw: true });
  var model = read.raw;
  if (!model || typeof model !== "object") {
    // Defensive — readFlow already throws on a bad response, but the raw model
    // could in theory be absent.
    var resp = await client.now.get<any>("/api/now/processflow/flow/" + encodeURIComponent(sysId));
    model = unwrapModel(resp);
  }

  var changes: Array<string> = [];
  var warnings: Array<string> = [];

  if (ops.rename) {
    if (ops.rename.name) {
      model.name = ops.rename.name;
      changes.push("name -> " + ops.rename.name);
    }
    if (ops.rename.internalName) {
      model.internalName = ops.rename.internalName;
      changes.push("internalName -> " + ops.rename.internalName);
    }
  }

  if (typeof ops.description === "string") {
    model.description = ops.description;
    changes.push("description updated");
  }

  if (ops.patchStepInputs && ops.patchStepInputs.length > 0) {
    for (var i = 0; i < ops.patchStepInputs.length; i += 1) {
      var patch = ops.patchStepInputs[i];
      var step = findStep(model, patch.step);
      if (!step) {
        warnings.push("step not found: " + patch.step);
        continue;
      }
      var ok = setInputValue(step, patch.input, patch.value);
      if (ok) {
        changes.push("step '" + (step.name || patch.step) + "' input '" + patch.input + "' updated");
      } else {
        warnings.push("input not found: " + patch.input + " on step " + patch.step);
      }
    }
  }

  if (!params.apply) {
    return { status: "dry-run", changes: changes, warnings: warnings };
  }

  if (changes.length === 0) {
    // Nothing matched — don't publish a no-op (which would still recompile).
    return { status: "dry-run", changes: changes, warnings: warnings };
  }

  var pub = await publishFlow({ client: client, sysId: sysId, model: model, scopeSysId: params.scopeSysId });
  return {
    status: "published",
    changes: changes,
    warnings: warnings,
    snapshotSysId: pub.snapshotSysId
  };
}
