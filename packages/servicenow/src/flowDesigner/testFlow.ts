/**
 * Test / run a Flow Designer flow, subflow, or action — headless.
 *
 * Two modes:
 *
 *   mode="validate" (DEFAULT, no execution, zero risk):
 *     Reads the compiled model and checks the artifact is runnable — published,
 *     readable — and that the inputs you supplied match its declared variables
 *     (flags unknown inputs). This is the safe pre-flight you can run anytime;
 *     it never triggers the flow.
 *
 *   mode="execute" (actually runs it):
 *     POSTs to the Dovetail Core `runFlow` Scripted REST op
 *     (/api/cadso/dovetail_core/runFlow), which ships with the Dovetail app and
 *     calls sn_fd.FlowAPI.getRunner().flow|subflow|action(name).inForeground()
 *     .withInputs(inputs).run() — see resources/runFlow.md. The UI "Test" button
 *     has no guessable native REST route, so this server-side runner is the
 *     supported, uniform path across flow | subflow | action.
 *     Execution is GUARDED: you must pass mode="execute" AND confirm=true.
 *
 * Path resolution mirrors the client's Dovetail core → legacy fallback: the
 * Dovetail Core path is tried first; a route-level 404 (the op itself is not
 * installed) falls back ONCE to the legacy global path /api/cadso/dovetail/runFlow.
 * An explicit `runnerPath` always wins and never falls back.
 *
 * Executing a flow can cause real side effects (the example subflow sends an
 * SMS). Prefer mode="validate"; gate mode="execute" behind a sandbox flow.
 */

import {
  DOVETAIL_CORE_API_BASE,
  DOVETAIL_LEGACY_API_BASE,
} from "../client";
import type { NowInvokeResponse, ServiceNowClient } from "../client";
import { readFlow } from "./readFlow";
import { readActionType } from "./readActionType";

/** Default runner endpoint — the Dovetail Core runFlow op (ships with the Dovetail app). */
export var DEFAULT_RUN_FLOW_PATH = DOVETAIL_CORE_API_BASE + "runFlow";

/** Legacy global-scope runner path, tried once when the default path 404s. */
export var LEGACY_RUN_FLOW_PATH = DOVETAIL_LEGACY_API_BASE + "runFlow";

/** What `sysId` points at: a sys_hub_flow (flow or subflow) or a sys_hub_action_type_definition. */
export type TestFlowTarget = "flow" | "action";

export interface TestFlowParams {
  client: ServiceNowClient;
  /**
   * sys_id of the artifact to test: a sys_hub_flow (flow or subflow) when
   * target="flow" (default), or a sys_hub_action_type_definition when
   * target="action".
   */
  sysId: string;
  /** "flow" (default — sys_hub_flow, sent as flowSysId) or "action" (sent as actionSysId). */
  target?: TestFlowTarget;
  /** "validate" (default — no execution) or "execute" (runs it; requires confirm). */
  mode?: "validate" | "execute";
  /** Inputs passed to the flow/action. Keys should match declared input names. */
  inputs?: Record<string, unknown>;
  /** Required to be true for mode="execute" — a deliberate run-this-for-real gate. */
  confirm?: boolean;
  /**
   * Override the runner endpoint path. When set it is used as-is with NO
   * fallback; when omitted, DEFAULT_RUN_FLOW_PATH is tried, then
   * LEGACY_RUN_FLOW_PATH once on a route-level 404.
   */
  runnerPath?: string;
}

export interface TestFlowResult {
  mode: "validate" | "execute";
  /** Whether the artifact is runnable / the run succeeded. */
  ok: boolean;
  /** Human-readable findings (validation notes, run status). */
  notes: Array<string>;
  /** For execute mode: the run context sys_id, when the runner returns one. */
  contextSysId?: string;
  /** For execute mode: the HTTP status the runner answered with. */
  httpStatus?: number;
  /** For execute mode: the runner path that answered. */
  runnerPath?: string;
  /** For execute mode: the raw (unwrapped) runner response. */
  run?: unknown;
}

var SYS_ID_RE = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** ServiceNow wraps a Scripted REST op's return value in { result: ... }. */
function unwrap(data: unknown): unknown {
  if (isRecord(data) && isRecord(data.result)) {
    return data.result;
  }
  return data;
}

/**
 * True when a response body is the runFlow op's own { ok, ... } contract. Used
 * to tell "the op answered 404 because the sys_id is unknown" (no fallback)
 * from "the route itself does not exist" (fall back / not deployed).
 */
function isRunnerContract(body: unknown): boolean {
  var data = unwrap(body);
  return isRecord(data) && typeof data.ok === "boolean";
}

function bodySnippet(body: unknown): string {
  if (body === undefined || body === null) return "";
  var text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 400 ? text.substring(0, 400) + "…" : text;
}

/** Table API reference fields come back as a sys_id string or { value }. */
function refValue(field: unknown): string {
  if (typeof field === "string") return field;
  if (isRecord(field) && typeof field.value === "string") return field.value;
  return "";
}

function checkInputs(
  inputs: Record<string, unknown>,
  declaredNames: Array<string>,
  noun: string,
  notes: Array<string>,
): void {
  var declared: Record<string, boolean> = {};
  for (var v = 0; v < declaredNames.length; v += 1) {
    declared[declaredNames[v]] = true;
  }
  var keys = Object.keys(inputs);
  for (var i = 0; i < keys.length; i += 1) {
    if (!declared[keys[i]]) {
      notes.push("warning: input '" + keys[i] + "' does not match any declared " + noun + ".");
    }
  }
  notes.push(keys.length + " input(s) supplied; " + declaredNames.length + " " + noun + "(s) declared.");
}

/** Validate-mode pre-flight for a flow/subflow: published? readable? inputs recognized? */
async function validateFlow(params: TestFlowParams, sysId: string): Promise<TestFlowResult> {
  var notes: Array<string> = [];
  var ok = true;

  var read = await readFlow({ client: params.client, sysId: sysId });
  notes.push("flow: " + read.name + " (" + read.type + ")");

  if (!read.published) {
    ok = false;
    notes.push("NOT PUBLISHED — publish it before it can run.");
  } else {
    notes.push("published: yes");
  }
  if (!read.userCanRead) {
    notes.push("warning: userCanRead is false for the integration user.");
  }

  var names: Array<string> = [];
  for (var v = 0; v < read.variables.length; v += 1) {
    names.push(read.variables[v].name);
  }
  checkInputs(params.inputs || {}, names, "flow variable", notes);

  return { mode: "validate", ok: ok, notes: notes };
}

/**
 * Validate-mode pre-flight for an action: the record exists and has the
 * internal_name the runner addresses it by, and the supplied inputs match the
 * action's declared inputs.
 */
async function validateAction(params: TestFlowParams, sysId: string): Promise<TestFlowResult> {
  var notes: Array<string> = [];
  var rows = await params.client.table.query<Record<string, unknown>>(
    "sys_hub_action_type_definition",
    "sys_id=" + sysId,
    { limit: 1, fields: ["sys_id", "name", "internal_name", "sys_scope"] },
  );
  var row = rows && rows.length > 0 ? rows[0] : undefined;
  if (!row) {
    notes.push("action not found: sys_hub_action_type_definition " + sysId);
    return { mode: "validate", ok: false, notes: notes };
  }
  var name = typeof row.name === "string" ? row.name : "";
  var internalName = typeof row.internal_name === "string" ? row.internal_name : "";
  notes.push("action: " + (name || sysId));
  var ok = true;
  if (!internalName) {
    ok = false;
    notes.push("NO internal_name — the runner addresses actions by <scope>.<internal_name>, so it cannot run.");
  }

  var scopeSysId = refValue(row.sys_scope);
  if (!scopeSysId) {
    notes.push("warning: could not resolve the action's scope; inputs were not checked.");
    return { mode: "validate", ok: ok, notes: notes };
  }
  var read = await readActionType({ client: params.client, sysId: sysId, scopeSysId: scopeSysId });
  var names: Array<string> = [];
  for (var i = 0; i < read.inputs.length; i += 1) {
    names.push(read.inputs[i].name);
  }
  checkInputs(params.inputs || {}, names, "action input", notes);
  notes.push("note: publish state is not checked for actions.");
  return { mode: "validate", ok: ok, notes: notes };
}

function postRunner(
  client: ServiceNowClient,
  path: string,
  body: Record<string, unknown>,
): Promise<NowInvokeResponse> {
  return client.now.invoke({ method: "POST", path: path, body: body });
}

/** Execute-mode: POST the runner endpoint. Requires confirm=true. */
async function execute(params: TestFlowParams, sysId: string): Promise<TestFlowResult> {
  if (params.confirm !== true) {
    throw new Error(
      "testFlow: mode='execute' requires confirm=true — running a flow can cause real "
        + "side effects (e.g. sending an SMS). Pass confirm:true to proceed."
    );
  }

  var body: Record<string, unknown> = { inputs: params.inputs || {} };
  if (params.target === "action") {
    body.actionSysId = sysId;
  } else {
    body.flowSysId = sysId;
  }

  var isExplicit = typeof params.runnerPath === "string" && params.runnerPath.length > 0;
  var path = isExplicit ? String(params.runnerPath) : DEFAULT_RUN_FLOW_PATH;
  var tried: Array<string> = [path];
  var resp = await postRunner(params.client, path, body);

  if (!isExplicit && resp.status === 404 && !isRunnerContract(resp.body)) {
    // Same core → legacy fallback the client uses for every Dovetail op.
    // eslint-disable-next-line no-console
    console.warn(
      "[deprecation] " + DEFAULT_RUN_FLOW_PATH + " returned 404. Falling back to legacy "
        + LEGACY_RUN_FLOW_PATH + ". Install the Dovetail application to silence this warning.",
    );
    path = LEGACY_RUN_FLOW_PATH;
    tried.push(path);
    resp = await postRunner(params.client, path, body);
  }

  var status = resp.status;
  var isContract = isRunnerContract(resp.body);

  if (status === 404 && !isContract) {
    throw new Error(
      "testFlow: no runFlow endpoint found (tried " + tried.join(", ") + "). The runFlow op "
        + "ships with the Dovetail app under Dovetail Core — install or upgrade the Dovetail "
        + "app on this instance, or pass runnerPath to an existing runner."
    );
  }
  if ((status < 200 || status >= 300) && !isContract) {
    var hint = status === 401 || status === 403
      ? " — check the integration user's credentials and that it holds the admin or dovetail_user role."
      : "";
    throw new Error(
      "testFlow: runner " + path + " returned HTTP " + status + hint
        + (bodySnippet(resp.body) ? ": " + bodySnippet(resp.body) : "")
    );
  }

  var data = unwrap(resp.body);
  var record = isRecord(data) ? data : {};
  var contextSysId: string | undefined;
  if (typeof record.contextId === "string" && record.contextId) {
    contextSysId = record.contextId;
  } else if (typeof record.context_sys_id === "string" && record.context_sys_id) {
    contextSysId = record.context_sys_id;
  }

  var ok = status >= 200 && status < 300 && record.ok !== false;
  var notes: Array<string> = [];
  if (ok) {
    notes.push("run completed via " + path
      + (typeof record.name === "string" && record.name ? " (" + record.name + ")" : ""));
  } else {
    var reason = typeof record.error === "string" && record.error ? record.error : "no error message";
    var roleHint = status === 403 ? " (the caller needs the admin or dovetail_user role)" : "";
    notes.push("run rejected by " + path + " (HTTP " + status + ")" + roleHint + ": " + reason);
  }

  return {
    mode: "execute",
    ok: ok,
    notes: notes,
    contextSysId: contextSysId,
    httpStatus: status,
    runnerPath: path,
    run: data
  };
}

export async function testFlow(params: TestFlowParams): Promise<TestFlowResult> {
  if (!params || !params.sysId) {
    throw new Error("testFlow: sysId is required.");
  }
  var sysId = String(params.sysId).trim().toLowerCase();
  if (!SYS_ID_RE.test(sysId)) {
    throw new Error("testFlow: sysId must be a 32-character hex sys_id (got '" + params.sysId + "').");
  }
  if (params.target !== undefined && params.target !== "flow" && params.target !== "action") {
    throw new Error("testFlow: target must be 'flow' or 'action'.");
  }
  var mode = params.mode || "validate";
  if (mode === "execute") {
    return execute(params, sysId);
  }
  if (params.target === "action") {
    return validateAction(params, sysId);
  }
  return validateFlow(params, sysId);
}
