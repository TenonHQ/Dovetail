/**
 * Read a Flow Designer flow or subflow — the compiled model, headless.
 *
 * The Designer's own model endpoint returns the entire compiled flow for the
 * integration user with plain basic auth:
 *
 *   GET /api/now/processflow/flow/{flowSysId}
 *     -> 200, { result: { data: { actionInstances[], flowLogicInstances[],
 *                                 flowVariables[], label_cache[], isPublished,
 *                                 userCanRead, status, scope, ... } } }
 *
 * This is the READ counterpart of publishActionType's POST. It is what makes
 * the raw sys_hub_flow_snapshot Table API 404 a non-issue: that 404 is a
 * row-level restriction on the working `latest_snapshot` row, not a table
 * block — the processflow model serves the full step graph regardless.
 *
 * We merge actionInstances + flowLogicInstances, drop deleted rows, sort by
 * numeric `order`, and indent each row one level under its `parent` (the
 * parent's uiUniqueIdentifier). The human label is the instance's `name`
 * ("If: No Phone Home", "Process Inputs / Outputs"); `displayText` is usually
 * empty. Pass `raw: true` to also get the unmodified model back (e.g. for
 * round-trip diffing into git, or to feed publishFlow).
 *
 * Full write-up: docs/documenting-servicenow-flows.md in the Craftsman repo.
 */

import type { ServiceNowClient } from "../client";

export interface ReadFlowParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_flow (flow or subflow) to read. */
  sysId: string;
  /** When true, include the unmodified processflow model on the result as `raw`. */
  raw?: boolean;
}

export interface FlowStep {
  /** "action" = sys_hub_action_instance; "logic" = sys_hub_flow_logic_instance. */
  kind: "action" | "logic";
  /** Numeric execution order within the flow. */
  order: number;
  /** Human label (the instance `name`), e.g. "If: No Phone Home". */
  label: string;
  /** uiUniqueIdentifier of this instance (stable id used by `parent` links). */
  uiId: string;
  /** uiUniqueIdentifier of the containing block, or "" at the top level. */
  parent: string;
  /** Nesting depth derived from the parent chain (top level = 0). */
  depth: number;
}

export interface FlowVariable {
  name: string;
  label: string;
  type: string;
}

export interface ReadFlowResult {
  sysId: string;
  name: string;
  internalName: string;
  /** "Flow" | "SubFlow" (as the model reports it). */
  type: string;
  /** Owning application scope sys_id. */
  scopeSysId: string;
  published: boolean;
  userCanRead: boolean;
  status: string;
  /** Ordered, nesting-aware step graph (action + logic instances merged). */
  steps: Array<FlowStep>;
  variables: Array<FlowVariable>;
  counts: { action: number; logic: number; total: number };
  /** The unmodified processflow model — present only when params.raw is true. */
  raw?: any;
}

function flowPath(sysId: string): string {
  return "/api/now/processflow/flow/" + encodeURIComponent(sysId);
}

/** Normalize ServiceNow's `{ result: { data } }` / `{ data }` / bare envelopes to the model. */
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

/** Read either { value } objects or bare scalars without optional chaining. */
function val(field: any): string {
  if (field === null || field === undefined) {
    return "";
  }
  if (typeof field === "object") {
    return field.value !== undefined && field.value !== null ? String(field.value) : "";
  }
  return String(field);
}

/** Human label for an instance: name -> displayText -> internalName. */
function instanceLabel(inst: any): string {
  var name = val(inst.name);
  if (name) {
    return name.trim();
  }
  var dtxt = val(inst.displayText);
  if (dtxt) {
    return dtxt;
  }
  var internal = val(inst.internalName);
  if (internal) {
    return internal;
  }
  return "(no label)";
}

function isDeleted(inst: any): boolean {
  return inst.deleted === true || val(inst.deleted) === "true";
}

export async function readFlow(params: ReadFlowParams): Promise<ReadFlowResult> {
  var client = params.client;
  var sysId = params.sysId;

  if (!sysId) {
    throw new Error("readFlow: sysId is required.");
  }

  var resp = await client.now.get<any>(flowPath(sysId));
  var model = unwrapModel(resp);
  if (!model || typeof model !== "object") {
    throw new Error(
      "readFlow: unexpected response for flow " + sysId
        + " — expected a model object, got: " + JSON.stringify(resp).substring(0, 300)
    );
  }

  var actions: Array<any> = Array.isArray(model.actionInstances) ? model.actionInstances : [];
  var logic: Array<any> = Array.isArray(model.flowLogicInstances) ? model.flowLogicInstances : [];
  var variables: Array<any> = Array.isArray(model.flowVariables) ? model.flowVariables : [];

  // Merge, drop deleted, sort by numeric order.
  var merged: Array<{ kind: "action" | "logic"; inst: any }> = [];
  var i: number;
  for (i = 0; i < actions.length; i += 1) {
    if (!isDeleted(actions[i])) {
      merged.push({ kind: "action", inst: actions[i] });
    }
  }
  for (i = 0; i < logic.length; i += 1) {
    if (!isDeleted(logic[i])) {
      merged.push({ kind: "logic", inst: logic[i] });
    }
  }
  merged.sort(function (a, b) {
    return parseFloat(val(a.inst.order)) - parseFloat(val(b.inst.order));
  });

  // Walk in order assigning depth: a row's depth is its parent's depth + 1.
  var depthByUiId: Record<string, number> = {};
  var steps: Array<FlowStep> = [];
  for (i = 0; i < merged.length; i += 1) {
    var inst = merged[i].inst;
    var uiId = val(inst.uiUniqueIdentifier);
    var parent = val(inst.parent);
    var depth = 0;
    if (parent && Object.prototype.hasOwnProperty.call(depthByUiId, parent)) {
      depth = depthByUiId[parent] + 1;
    }
    if (uiId) {
      depthByUiId[uiId] = depth;
    }
    steps.push({
      kind: merged[i].kind,
      order: parseFloat(val(inst.order)),
      label: instanceLabel(inst),
      uiId: uiId,
      parent: parent,
      depth: depth
    });
  }

  var vars: Array<FlowVariable> = [];
  for (i = 0; i < variables.length; i += 1) {
    var v = variables[i];
    vars.push({
      name: val(v.name),
      label: val(v.label) || val(v.name),
      type: val(v.type_label) || val(v.type)
    });
  }

  var result: ReadFlowResult = {
    sysId: val(model.id) || sysId,
    name: val(model.name),
    internalName: val(model.internalName),
    type: val(model.type),
    scopeSysId: val(model.scope),
    published: model.isPublished === true || val(model.isPublished) === "true",
    userCanRead: model.userCanRead === true || val(model.userCanRead) === "true",
    status: val(model.status),
    steps: steps,
    variables: vars,
    counts: { action: actions.length, logic: logic.length, total: actions.length + logic.length }
  };

  if (params.raw) {
    result.raw = model;
  }

  return result;
}
