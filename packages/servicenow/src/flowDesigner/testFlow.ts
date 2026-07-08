/**
 * Test / run a Flow Designer flow, subflow, or action — headless.
 *
 * Two modes:
 *
 *   mode="validate" (DEFAULT, no execution, zero risk):
 *     Reads the compiled model and checks the artifact is runnable — published,
 *     readable — and that the inputs you supplied match the flow's declared
 *     variables (flags unknown inputs). This is the safe pre-flight you can run
 *     anytime; it never triggers the flow.
 *
 *   mode="execute" (actually runs it):
 *     POSTs to the server-side FlowAPI runner endpoint (a Dovetail scoped
 *     Scripted REST resource that calls sn_fd.FlowAPI.getRunner(...).run() /
 *     .startAsync() — see resources/runFlow.md for the deployable source). The
 *     UI "Test" button has no guessable native REST route, so this server-side
 *     runner is the supported, uniform path across flow | subflow | action.
 *     Execution is GUARDED: you must pass mode="execute" AND confirm=true.
 *
 * Executing a flow can cause real side effects (the example subflow sends an
 * SMS). Prefer mode="validate"; gate mode="execute" behind a sandbox flow.
 */

import type { ServiceNowClient } from "../client";
import { readFlow } from "./readFlow";

/** Default runner endpoint — a Dovetail scoped Scripted REST resource. */
export var DEFAULT_RUN_FLOW_PATH = "/api/cadso/dovetail/runFlow";

export interface TestFlowParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_flow (flow or subflow). */
  sysId: string;
  /** "validate" (default — no execution) or "execute" (runs it; requires confirm). */
  mode?: "validate" | "execute";
  /** Inputs passed to the flow. Keys should match declared flow-variable names. */
  inputs?: Record<string, any>;
  /** Required to be true for mode="execute" — a deliberate run-this-for-real gate. */
  confirm?: boolean;
  /** Override the runner endpoint path (defaults to DEFAULT_RUN_FLOW_PATH). */
  runnerPath?: string;
}

export interface TestFlowResult {
  mode: "validate" | "execute";
  /** Whether the artifact is runnable / the run was accepted. */
  ok: boolean;
  /** Human-readable findings (validation notes, run status). */
  notes: Array<string>;
  /** For execute mode: the run context sys_id, when the runner returns one. */
  contextSysId?: string;
  /** For execute mode: the raw runner response. */
  run?: any;
}

function unwrap(data: any): any {
  if (
    data &&
    typeof data === "object" &&
    data.result &&
    typeof data.result === "object"
  ) {
    return data.result;
  }
  return data;
}

/** Validate-mode pre-flight: published? readable? inputs recognized? */
async function validate(params: TestFlowParams): Promise<TestFlowResult> {
  var notes: Array<string> = [];
  var ok = true;

  var read = await readFlow({ client: params.client, sysId: params.sysId });
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

  var inputs = params.inputs || {};
  var declared: Record<string, boolean> = {};
  for (var v = 0; v < read.variables.length; v += 1) {
    declared[read.variables[v].name] = true;
  }
  var keys = Object.keys(inputs);
  for (var i = 0; i < keys.length; i += 1) {
    if (!declared[keys[i]]) {
      notes.push(
        "warning: input '" +
          keys[i] +
          "' does not match any declared flow variable.",
      );
    }
  }
  notes.push(
    keys.length +
      " input(s) supplied; " +
      read.variables.length +
      " variable(s) declared.",
  );

  return { mode: "validate", ok: ok, notes: notes };
}

/** Execute-mode: POST the runner endpoint. Requires confirm=true. */
async function execute(params: TestFlowParams): Promise<TestFlowResult> {
  if (params.confirm !== true) {
    throw new Error(
      "testFlow: mode='execute' requires confirm=true — running a flow can cause real " +
        "side effects (e.g. sending an SMS). Pass confirm:true to proceed.",
    );
  }

  var path = params.runnerPath || DEFAULT_RUN_FLOW_PATH;
  var body = {
    flowSysId: params.sysId,
    inputs: params.inputs || {},
  };

  var resp: any;
  try {
    resp = await params.client.now.post<any>(path, body);
  } catch (err: any) {
    var msg = err && err.message ? String(err.message) : String(err);
    if (msg.indexOf("404") >= 0) {
      throw new Error(
        "testFlow: the runner endpoint " +
          path +
          " is not deployed. Deploy the FlowAPI " +
          "Scripted REST resource (see resources/runFlow.md) or pass runnerPath to an " +
          "existing one.",
      );
    }
    throw err;
  }

  var data = unwrap(resp);
  var contextSysId: string | undefined;
  if (data && typeof data === "object") {
    contextSysId =
      typeof data.contextId === "string"
        ? data.contextId
        : typeof data.context_sys_id === "string"
        ? data.context_sys_id
        : undefined;
  }

  return {
    mode: "execute",
    ok: true,
    notes: ["run accepted via " + path],
    contextSysId: contextSysId,
    run: data,
  };
}

export async function testFlow(
  params: TestFlowParams,
): Promise<TestFlowResult> {
  if (!params.sysId) {
    throw new Error("testFlow: sysId is required.");
  }
  var mode = params.mode || "validate";
  if (mode === "execute") {
    return execute(params);
  }
  return validate(params);
}
