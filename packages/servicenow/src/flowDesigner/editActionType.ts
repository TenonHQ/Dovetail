/**
 * Edit a published Custom Action Type's script and/or output variables, then
 * republish — entirely headless, basic auth, no Designer UI.
 *
 * Reuses the validated publish contract (see publishActionType):
 *   GET  /api/now/processflow/action/action_types/{id}                -> model (outputs[], steps:null)
 *   GET  /api/now/processflow/action/action_types/{id}/step_instances -> { steps:[...] } (carries the script)
 *   POST /api/now/processflow/action/action_types/{id}/snapshot       -> 201; compiles the snapshot AND
 *                                                                        persists step input values back to
 *                                                                        sys_variable_value
 *
 * The GET model returns `steps: null` (the Designer assembles them client-side),
 * so we fetch them from `/step_instances`, patch the script input there,
 * optionally merge output-variable definitions into `model.outputs`, graft the
 * steps back onto the model, and POST `/snapshot`. Because the snapshot POST
 * persists step input values, the patched script lands without a separate write.
 *
 * Why route through `/snapshot` rather than the Designer's model PUT: the PUT
 * applies a client-side model transform (it strips ~14 step fields and reshapes
 * inputs) that is unsafe to hand-reconstruct and risks corrupting the action.
 * The snapshot POST is the path publishActionType already proved end to end.
 *
 * Full write-up: docs/servicenow-flow-designer-headless-authoring.md.
 */

import type { ServiceNowClient } from "../client";

export interface EditActionTypeOps {
  /** Replace every occurrence of `find` with `replace` inside the script step value. */
  patchScript?: { find: string; replace: string };
  /** Replace the script step value outright (wins over patchScript). */
  setScript?: string;
  /**
   * Output-variable definition objects to merge into `model.outputs`, matched by
   * `name` (replaced in place, else appended). Supply the modeled output JSON —
   * e.g. an `array.object` with `children` — typically lifted from a Designer
   * capture of the same shape.
   */
  mergeOutputs?: Array<Record<string, any>>;
  /**
   * The input `name` holding the script. Defaults to auto-detect: the first step
   * input whose value reads like an action script.
   */
  scriptInputName?: string;
}

export interface EditActionTypeParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_action_type_definition to edit. */
  sysId: string;
  /** Application scope sys_id, passed as sysparm_transaction_scope. */
  scopeSysId: string;
  ops: EditActionTypeOps;
  /** When true, republish. When false/omitted, dry-run (no write). */
  apply?: boolean;
  /** Update set to capture the publish into (pins the REST session's active set first). */
  updateSetSysId?: string;
}

export interface EditActionTypeResult {
  status: "preview" | "published";
  changes: Array<string>;
  warnings: Array<string>;
  scriptBefore?: string;
  scriptAfter?: string;
  outputsMerged: Array<string>;
  /** HTTP status of the snapshot POST (201 on success); only set when applied. */
  httpStatus?: number;
  snapshotSysId?: string;
}

function actionTypePath(sysId: string, scopeSysId: string, suffix: string): string {
  return "/api/now/processflow/action/action_types/" + encodeURIComponent(sysId)
    + suffix
    + "?sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}

/** Normalize the `{ result: ... }` envelope the processflow endpoints sometimes use. */
function unwrap(data: any): any {
  if (data && typeof data === "object" && data.result && typeof data.result === "object") {
    return data.result;
  }
  return data;
}

var SCRIPT_SIGNATURE = /function execute|inputs\.|outputs\.|new\s+[A-Za-z_$]/;

/** Locate the step input holding the action script (by name, else by signature). */
function findScriptInput(steps: Array<any>, inputName?: string): { input: any } | null {
  for (var s = 0; s < steps.length; s += 1) {
    var inputs = (steps[s] && steps[s].inputs) || [];
    for (var i = 0; i < inputs.length; i += 1) {
      var inp = inputs[i];
      if (!inp) {
        continue;
      }
      if (inputName) {
        if (inp.name === inputName) {
          return { input: inp };
        }
      } else if (typeof inp.value === "string" && inp.value.length > 30 && SCRIPT_SIGNATURE.test(inp.value)) {
        return { input: inp };
      }
    }
  }
  return null;
}

export async function editActionType(params: EditActionTypeParams): Promise<EditActionTypeResult> {
  var client = params.client;
  var sysId = params.sysId;
  var scopeSysId = params.scopeSysId;
  var ops = params.ops || {};

  if (!sysId) {
    throw new Error("editActionType: sysId is required.");
  }
  if (!scopeSysId) {
    throw new Error("editActionType: scopeSysId is required (sysparm_transaction_scope).");
  }
  if (!ops.patchScript && !ops.setScript && !(ops.mergeOutputs && ops.mergeOutputs.length > 0)) {
    throw new Error("editActionType: no ops — supply patchScript, setScript, and/or mergeOutputs.");
  }

  var changes: Array<string> = [];
  var warnings: Array<string> = [];
  var outputsMerged: Array<string> = [];

  // 1. GET the model (outputs[], steps:null).
  var model = unwrap(await client.now.get<any>(actionTypePath(sysId, scopeSysId, "")));
  if (!model || typeof model !== "object") {
    throw new Error("editActionType: unexpected GET model response for action type " + sysId);
  }

  // 2. GET the steps — the model's `steps` come back null.
  var stepsResp = unwrap(await client.now.get<any>(actionTypePath(sysId, scopeSysId, "/step_instances")));
  var steps: Array<any> = stepsResp && Array.isArray(stepsResp.steps) ? stepsResp.steps : [];
  if (steps.length === 0) {
    throw new Error("editActionType: /step_instances returned no steps for action type " + sysId);
  }

  // 3. Patch the script step input.
  var scriptBefore: string | undefined;
  var scriptAfter: string | undefined;
  if (ops.patchScript || ops.setScript) {
    var hit = findScriptInput(steps, ops.scriptInputName);
    if (!hit) {
      warnings.push("script input not found" + (ops.scriptInputName ? " (name=" + ops.scriptInputName + ")" : " (auto-detect)"));
    } else {
      scriptBefore = String(hit.input.value);
      if (ops.setScript) {
        scriptAfter = ops.setScript;
      } else if (ops.patchScript) {
        if (scriptBefore.indexOf(ops.patchScript.find) === -1) {
          warnings.push("patchScript.find not present in script: " + ops.patchScript.find);
          scriptAfter = scriptBefore;
        } else {
          scriptAfter = scriptBefore.split(ops.patchScript.find).join(ops.patchScript.replace);
        }
      }
      if (scriptAfter !== undefined && scriptAfter !== scriptBefore) {
        hit.input.value = scriptAfter;
        changes.push("script input '" + hit.input.name + "' patched");
      } else {
        warnings.push("script unchanged");
      }
    }
  }

  // 4. Merge output-variable definitions by name.
  if (ops.mergeOutputs && ops.mergeOutputs.length > 0) {
    if (!Array.isArray(model.outputs)) {
      model.outputs = [];
    }
    for (var od = 0; od < ops.mergeOutputs.length; od += 1) {
      var outDef = ops.mergeOutputs[od];
      var outName = outDef && outDef.name;
      if (!outName) {
        warnings.push("mergeOutputs entry missing name — skipped");
        continue;
      }
      var replaced = false;
      for (var m = 0; m < model.outputs.length; m += 1) {
        if (model.outputs[m] && model.outputs[m].name === outName) {
          model.outputs[m] = outDef;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        model.outputs.push(outDef);
      }
      outputsMerged.push(outName);
      changes.push("output '" + outName + "' " + (replaced ? "replaced" : "added"));
    }
  }

  // 5. Graft steps onto the model (remap each step's `action` to this sysId, per
  //    the publish contract).
  model.steps = steps.map(function (step) {
    var copy: Record<string, any> = {};
    for (var key in step) {
      if (Object.prototype.hasOwnProperty.call(step, key)) {
        copy[key] = step[key];
      }
    }
    copy.action = sysId;
    return copy;
  });

  if (!params.apply) {
    return {
      status: "preview",
      changes: changes,
      warnings: warnings,
      scriptBefore: scriptBefore,
      scriptAfter: scriptAfter,
      outputsMerged: outputsMerged
    };
  }

  // 6. Apply: optionally pin the update set, then POST /snapshot (compiles the
  //    snapshot and persists step input values).
  if (params.updateSetSysId) {
    await client.claude.changeUpdateSet({ sysId: params.updateSetSysId });
  }
  var snapResp = unwrap(await client.now.post<any>(actionTypePath(sysId, scopeSysId, "/snapshot"), model));
  var snapshotSysId: string | undefined;
  if (snapResp && typeof snapResp === "object") {
    var snap = snapResp.latest_snapshot || snapResp.master_snapshot || snapResp.snapshot;
    if (snap && typeof snap === "object") {
      snapshotSysId = typeof snap.sys_id === "string" ? snap.sys_id : undefined;
    } else if (typeof snap === "string") {
      snapshotSysId = snap;
    }
  }

  return {
    status: "published",
    changes: changes,
    warnings: warnings,
    scriptBefore: scriptBefore,
    scriptAfter: scriptAfter,
    outputsMerged: outputsMerged,
    httpStatus: 201,
    snapshotSysId: snapshotSysId
  };
}
