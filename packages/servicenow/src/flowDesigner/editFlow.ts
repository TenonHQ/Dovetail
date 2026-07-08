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
  /** When true, persist the edits. When false/omitted, dry-run (no write). */
  apply?: boolean;
  /** Override sysparm_transaction_scope for the publish; defaults to the model's scope. */
  scopeSysId?: string;
  /**
   * Update set sys_id that captures top-level field writes (rename/description).
   * REQUIRED when apply=true and the ops include rename or description — those
   * fields are written to sys_hub_flow through the update-set-aware Dovetail API
   * (the snapshot POST does NOT persist them). Not needed for patchStepInputs-only
   * edits (those ride the snapshot POST).
   */
  updateSetSysId?: string;
}

export interface EditFlowResult {
  /**
   * "dry-run"  — computed, nothing written;
   * "applied"  — edits persisted (record fields written; snapshot recompiled iff
   *              a step input changed).
   */
  status: "dry-run" | "applied";
  /** Human-readable list of changes that were applied to the model. */
  changes: Array<string>;
  /** Requested edits that could not be matched (e.g. unknown step or input). */
  warnings: Array<string>;
  /** Present when status="published". */
  snapshotSysId?: string;
}

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
      if (
        inst &&
        (inst.uiUniqueIdentifier === ref ||
          inst.name === ref ||
          inst.internalName === ref)
      ) {
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

export async function editFlow(
  params: EditFlowParams,
): Promise<EditFlowResult> {
  var client = params.client;
  var sysId = params.sysId;
  var ops = params.ops || {};

  if (!sysId) {
    throw new Error("editFlow: sysId is required.");
  }

  // Read the full model — we need the raw instance graph to patch step inputs
  // and to resolve the flow's scope for the update-set-aware record write.
  var read = await readFlow({ client: client, sysId: sysId, raw: true });
  var model = read.raw;
  if (!model || typeof model !== "object") {
    var resp = await client.now.get<any>(
      "/api/now/processflow/flow/" + encodeURIComponent(sysId),
    );
    model = unwrapModel(resp);
  }
  var scopeSysId =
    params.scopeSysId || (typeof model.scope === "string" ? model.scope : "");

  var changes: Array<string> = [];
  var warnings: Array<string> = [];

  // Top-level sys_hub_flow columns. These are NOT persisted by the snapshot POST
  // (that only writes step input values), so they go through a direct,
  // update-set-aware record write — see recordFields below.
  var recordFields: Record<string, any> = {};
  if (ops.rename) {
    if (ops.rename.name) {
      recordFields.name = ops.rename.name;
      changes.push("name -> " + ops.rename.name);
    }
    if (ops.rename.internalName) {
      recordFields.internal_name = ops.rename.internalName;
      changes.push("internalName -> " + ops.rename.internalName);
    }
  }
  if (typeof ops.description === "string") {
    recordFields.description = ops.description;
    changes.push("description updated");
  }

  // Step input values ride the snapshot POST — the publish is documented to
  // persist step input values back to the design records (verified for action
  // types). For FLOWS this is best-effort: we apply, republish, then read back
  // and confirm each value actually took (see the verify pass after publish), so
  // a non-persist surfaces as a warning instead of a silent false success.
  var stepInputsChanged = false;
  var verifyTargets: Array<{ step: string; input: string; value: any }> = [];
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
        stepInputsChanged = true;
        verifyTargets.push({
          step: patch.step,
          input: patch.input,
          value: patch.value,
        });
        changes.push(
          "step '" +
            (step.name || patch.step) +
            "' input '" +
            patch.input +
            "' updated",
        );
      } else {
        warnings.push(
          "input not found: " + patch.input + " on step " + patch.step,
        );
      }
    }
  }

  if (!params.apply || changes.length === 0) {
    // Dry-run, or nothing matched — never write/publish a no-op.
    return { status: "dry-run", changes: changes, warnings: warnings };
  }

  // 1. Persist top-level field edits via the Dovetail write API, pinned to the
  //    caller-supplied update set so the change is captured for promotion.
  if (Object.keys(recordFields).length > 0) {
    if (!params.updateSetSysId) {
      throw new Error(
        "editFlow: updateSetSysId is required to apply rename/description edits " +
          "(they write sys_hub_flow through the update-set-aware API). Pass an " +
          "in-progress update set sys_id, or limit ops to patchStepInputs.",
      );
    }
    await client.claude.pushWithUpdateSet({
      update_set_sys_id: params.updateSetSysId,
      table: "sys_hub_flow",
      record_sys_id: sysId,
      fields: recordFields,
    });
  }

  // 2. Republish only when step inputs changed (recompiles the snapshot AND
  //    persists the step values). Metadata-only edits need no recompile.
  var snapshotSysId: string | undefined;
  if (stepInputsChanged) {
    var pub = await publishFlow({
      client: client,
      sysId: sysId,
      model: model,
      scopeSysId: scopeSysId || undefined,
    });
    snapshotSysId = pub.snapshotSysId;

    // 3. Verify the step-input changes actually persisted. The snapshot POST is
    //    only documented to persist step values for action types; for flows it
    //    can no-op. Read the model back and confirm each value took — a miss is
    //    surfaced as a warning rather than a silent false "applied".
    var afterResp = await client.now.get<any>(
      "/api/now/processflow/flow/" + encodeURIComponent(sysId),
    );
    var afterModel = unwrapModel(afterResp);
    for (var v = 0; v < verifyTargets.length; v += 1) {
      var t = verifyTargets[v];
      var liveStep = afterModel ? findStep(afterModel, t.step) : null;
      var persisted = false;
      if (liveStep && Array.isArray(liveStep.inputs)) {
        for (var k = 0; k < liveStep.inputs.length; k += 1) {
          if (liveStep.inputs[k] && liveStep.inputs[k].name === t.input) {
            persisted = String(liveStep.inputs[k].value) === String(t.value);
            break;
          }
        }
      }
      if (!persisted) {
        warnings.push(
          "step input '" +
            t.input +
            "' on '" +
            t.step +
            "' did not persist via the snapshot POST " +
            "— verify in the Designer (flow step-input persistence is best-effort).",
        );
      }
    }
  }

  return {
    status: "applied",
    changes: changes,
    warnings: warnings,
    snapshotSysId: snapshotSysId,
  };
}
