/**
 * Create a whole Flow Designer FLOW (sys_hub_flow, type=flow) from scratch and
 * publish it — headless, basic auth. The missing peer of copyFlow / publishFlow:
 * copyFlow duplicates an existing flow; createFlow mints a NEW flow whose trigger
 * + action graph is grafted from a template, then compiled.
 *
 * === CANONICAL SEQUENCE (reverse-engineered from Workflow Studio HARs, 2026-06-02) ===
 * The Designer SPA holds the entire flow graph client-side and persists + compiles
 * it in ONE shot at publish. There are NO incremental add-trigger / add-action REST
 * calls — only version bookmarks. The proven, validated sequence is:
 *
 *   1. CREATE  POST /api/now/processflow/flow?param_only_properties=true&sysparm_transaction_scope={scope}
 *        body = a small properties envelope. -> 200, result.data = a FULLY INITIALISED
 *        empty model (server-minted id, internalName, flowCatalogVariableModelId,
 *        version, authoredOnReleaseVersion). This initialisation is the piece a
 *        Dovetail createRecord / Table API insert never produces — and without it the
 *        snapshot POST silently no-ops (flow stays draft, no snapshot).
 *   2. GRAFT   GET /api/now/processflow/flow/{template}?sysparm_transaction_scope={scope}
 *        -> result.data carries the template's triggerInstances / actionInstances /
 *        flowLogicInstances. Build the publish model = the NEW envelope with those arrays
 *        grafted in, ids remapped (flowSysId -> new id; fresh id + uiUniqueIdentifier),
 *        and values patched (trigger table/condition, action message inputs).
 *   3. VERSION POST /api/now/processflow/versioning/create_version?...
 *        body { item_sys_id: newFlow, type: "Activate/Publish", annotation: "", favorite: false }
 *   4. PUBLISH POST /api/now/processflow/flow/{newFlow}/snapshot?...  body = the FLAT model
 *        -> result.data.status="published", isPublished=true, latestSnapshot=<sys_id>.
 *
 * Validated live 2026-06-02 on tenonworkstudio (x_cadso_automate): flow
 * aceb8e683395cb147b18bc534d5c7b5e published with a compiled snapshot
 * (7ceb02a83395cb147b18bc534d5c7b03), 1 trigger in sys_hub_trigger_instance_v2,
 * 1 action in sys_hub_action_instance_v2 — zero UI clicks.
 *
 * The clone inherits the template's trigger + action SHAPE; author a different
 * shape by building that flow once in the Designer and pointing templateSysId at it.
 */

import * as crypto from "crypto";
import type { ServiceNowClient } from "../client";

export interface CreateFlowParams {
  client: ServiceNowClient;
  /** Name for the new flow. */
  name: string;
  /**
   * sys_id of an existing published sys_hub_flow whose trigger + action graph is
   * grafted onto the new flow. Required — the trigger/action shape comes from here.
   */
  templateSysId: string;
  /** Target application scope sys_id (sysparm_transaction_scope). Required. */
  scopeSysId: string;
  /** internal_name; defaults to a slug of name. */
  internalName?: string;
  /** description on the new flow. */
  description?: string;
  /** Patch the trigger's `table` input (e.g. "customer_contact"). */
  triggerTable?: string;
  /** Patch the trigger's `condition` input (encoded query). Pass "" to clear. */
  triggerCondition?: string;
  /** Patch the action's `message` input (Log message) / short_description data. */
  logMessage?: string;
  /**
   * When true, do everything up to but not including the writes and return the
   * planned new name / internalName / template-graph counts. No network writes.
   */
  dryRun?: boolean;
}

export interface CreateFlowResult {
  status: "published" | "dry-run" | "not-published";
  /** sys_id of the new flow (empty on dry-run). */
  sysId: string;
  name: string;
  internalName: string;
  scopeSysId: string;
  /** sys_id of the compiled snapshot, when published. */
  snapshotSysId?: string;
  /** Counts grafted from the template. */
  graph: { triggers: number; actions: number; logic: number };
  /**
   * Whether the published flow is ACTIVE (will fire on its trigger). Read back
   * from the snapshot response when it reports it; `undefined` when the response
   * doesn't carry an active flag (dry-run, or a server payload that omits it).
   * Don't assume inactive on `undefined` — confirm against the flow record.
   */
  active?: boolean;
  /** HTTP status of the snapshot POST (0 on dry-run). */
  httpStatus: number;
}

function newId(): string {
  return crypto.randomBytes(16).toString("hex");
}
function uuid(): string {
  return crypto.randomUUID();
}
function slug(s: string): string {
  // The first replace collapses every run of non-alphanumerics to a single "_",
  // so consecutive underscores can never occur here — a single-char trim (no "+"
  // quantifier) is sufficient and avoids the polynomial-backtracking pattern.
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Normalize `{ result: { data } }` / `{ data }` / `{ result }` / bare to the model. */
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

function flowGetPath(sysId: string, scopeSysId: string): string {
  return "/api/now/processflow/flow/" + encodeURIComponent(sysId)
    + "?sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}
function flowCreatePath(scopeSysId: string): string {
  return "/api/now/processflow/flow?param_only_properties=true"
    + "&sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}
function createVersionPath(scopeSysId: string): string {
  return "/api/now/processflow/versioning/create_version"
    + "?sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}
function snapshotPath(sysId: string, scopeSysId: string): string {
  return "/api/now/processflow/flow/" + encodeURIComponent(sysId) + "/snapshot"
    + "?sysparm_transaction_scope=" + encodeURIComponent(scopeSysId);
}

function patchInputs(inst: any, kv: Record<string, any>): void {
  if (!inst || !Array.isArray(inst.inputs)) return;
  for (var i = 0; i < inst.inputs.length; i += 1) {
    var inp = inst.inputs[i];
    if (Object.prototype.hasOwnProperty.call(kv, inp.name)) {
      inp.value = kv[inp.name];
      if (Object.prototype.hasOwnProperty.call(inp, "displayValue")) {
        inp.displayValue = kv[inp.name];
      }
    }
  }
}

function remapInstances(arr: Array<any> | undefined, newFlow: string): Array<any> {
  if (!Array.isArray(arr)) return [];
  return arr.map(function (src) {
    var inst = JSON.parse(JSON.stringify(src));
    if (Object.prototype.hasOwnProperty.call(inst, "flowSysId")) inst.flowSysId = newFlow;
    if (Object.prototype.hasOwnProperty.call(inst, "id")) inst.id = newId();
    if (Object.prototype.hasOwnProperty.call(inst, "uiUniqueIdentifier")) inst.uiUniqueIdentifier = uuid();
    return inst;
  });
}

/**
 * Graft the template's graph onto the freshly-created envelope and patch values.
 * Exported for unit testing the pure transform without any network.
 */
export function buildPublishModel(
  envelope: any,
  template: any,
  newFlow: string,
  params: CreateFlowParams
): any {
  var M = JSON.parse(JSON.stringify(envelope));
  M.id = newFlow;
  M.status = "draft";
  M.active = false;
  M.latestSnapshot = "";
  M.masterSnapshot = false;
  M.masterSnapshotId = "";
  M.isPublished = false;
  M.snapshot = false;
  M.jsonSnapshot = false;
  M.deletedActions = [];
  M.deletedTriggers = [];
  M.deletedFlowLogicInstances = [];

  M.triggerInstances = remapInstances(template.triggerInstances, newFlow);
  M.actionInstances = remapInstances(template.actionInstances, newFlow);
  M.flowLogicInstances = remapInstances(template.flowLogicInstances, newFlow);
  M.subFlowInstances = remapInstances(template.subFlowInstances, newFlow);

  var ti;
  for (ti = 0; ti < M.triggerInstances.length; ti += 1) {
    var kv: Record<string, any> = {};
    if (params.triggerTable) kv.table = params.triggerTable;
    if (params.triggerCondition !== undefined) kv.condition = params.triggerCondition;
    patchInputs(M.triggerInstances[ti], kv);
  }
  var ai;
  for (ai = 0; ai < M.actionInstances.length; ai += 1) {
    var act = M.actionInstances[ai];
    if (params.logMessage) {
      patchInputs(act, { message: params.logMessage });
      if (act.data && Object.prototype.hasOwnProperty.call(act.data, "values")) {
        act.data.values = "short_description=" + params.logMessage;
      }
    }
  }
  return M;
}

function extractSnapshotSysId(body: any): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  var snap = body.latestSnapshot || body.masterSnapshot
    || body.latest_snapshot || body.master_snapshot || body.snapshot;
  if (snap && typeof snap === "object") {
    return typeof snap.sys_id === "string" ? snap.sys_id : undefined;
  }
  if (typeof snap === "string" && snap.length >= 32) return snap;
  return undefined;
}

export async function createFlow(params: CreateFlowParams): Promise<CreateFlowResult> {
  var client = params.client;
  if (!params.name || params.name.trim().length === 0) {
    throw new Error("createFlow: name is required.");
  }
  if (!params.templateSysId) {
    throw new Error("createFlow: templateSysId is required (the trigger/action shape is grafted from it).");
  }
  if (!params.scopeSysId) {
    throw new Error("createFlow: scopeSysId is required.");
  }
  var internalName = params.internalName || slug(params.name);

  // 1/2 (read): pull the template graph first — also validates the template exists.
  var template = unwrapModel(await client.now.get<any>(flowGetPath(params.templateSysId, params.scopeSysId)));
  if (!template || !Array.isArray(template.triggerInstances) || template.triggerInstances.length === 0) {
    throw new Error("createFlow: template flow " + params.templateSysId + " has no trigger to graft.");
  }
  var graph = {
    triggers: (template.triggerInstances || []).length,
    actions: (template.actionInstances || []).length,
    logic: (template.flowLogicInstances || []).length,
  };

  if (params.dryRun) {
    return {
      status: "dry-run",
      sysId: "",
      name: params.name,
      internalName: internalName,
      scopeSysId: params.scopeSysId,
      graph: graph,
      httpStatus: 0,
    };
  }

  // 1 (write): create the flow — server mints the initialised envelope.
  var props = {
    access: "public",
    description: params.description || "",
    flowPriority: "MEDIUM",
    name: params.name,
    protection: "",
    runAs: "system",
    runWithRoles: { value: "", displayValue: "" },
    type: "flow",
    active: false,
    deleted: false,
    security: { can_read: true, can_write: true },
    scope: params.scopeSysId,
    scopeName: "",
    scopeDisplayName: "",
    status: "draft",
    userHasRolesAssignedToFlow: true,
  };
  var createResp = await client.now.post<any>(flowCreatePath(params.scopeSysId), props);
  var envelope = unwrapModel(createResp);
  if (!envelope || typeof envelope.id !== "string" || envelope.id.length < 32) {
    throw new Error(
      "createFlow: create did not return an initialised flow id: "
        + JSON.stringify(createResp).substring(0, 300)
    );
  }
  var newFlow = envelope.id;
  if (envelope.internalName) internalName = envelope.internalName;

  // 2: build the publish model.
  var model = buildPublishModel(envelope, template, newFlow, params);

  // 3: version bookmark (Activate/Publish). Best-effort — publish is the gate.
  try {
    await client.now.post<any>(createVersionPath(params.scopeSysId), {
      item_sys_id: newFlow,
      type: "Activate/Publish",
      annotation: "",
      favorite: false,
    });
  } catch (err) {
    // non-fatal; the snapshot POST is what compiles.
  }

  // 4: publish (compile the snapshot). request() throws on non-2xx.
  var snapResp = await client.now.post<any>(snapshotPath(newFlow, params.scopeSysId), model);
  var snapBody = unwrapModel(snapResp);
  var publishedFlag = snapBody && (snapBody.isPublished === true || snapBody.status === "published");
  var snapshotSysId = extractSnapshotSysId(snapBody);
  var active = snapBody && typeof snapBody.active === "boolean" ? snapBody.active : undefined;

  return {
    status: publishedFlag || snapshotSysId ? "published" : "not-published",
    sysId: newFlow,
    name: params.name,
    internalName: internalName,
    scopeSysId: params.scopeSysId,
    snapshotSysId: snapshotSysId,
    graph: graph,
    active: active,
    httpStatus: 200,
  };
}
