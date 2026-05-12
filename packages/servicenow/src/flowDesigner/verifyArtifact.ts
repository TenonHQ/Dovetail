/**
 * Read-back verification for a Flow Designer artifact (Action Type or Subflow)
 * just written via /sn-build-flow. Implements L1 (structural row presence) and
 * L4 (snapshot generation) layers. L2 (FK integrity) and L3 (schema compliance)
 * are deferred — they require getTableSchema introspection that varies by
 * table; will be added once the encode side has shipped a working flow.
 *
 * All reads go through client.buildAgent.runQuery — falls back to plain Table
 * API on 403/404, so the verifier works on instances without sn_build_agent.
 */

import type { ServiceNowClient } from "../client";
import type { FlowKind } from "./listTemplates";

export interface VerifyExpect {
  inputCount?: number;
  outputCount?: number;
  /** For subflows: total step count (sys_hub_action_instance_v2 + sys_hub_flow_logic_instance_v2). */
  stepCount?: number;
  /** L4: a sys_hub_flow_snapshot row exists referencing this artifact. */
  publishedSnapshotPresent?: boolean;
}

export interface VerifyFound {
  parent: boolean;
  inputCount: number;
  outputCount: number;
  stepCount: number;
  snapshotPresent: boolean;
}

export interface VerifyFailure {
  layer: "L1" | "L4";
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface VerifyReport {
  ok: boolean;
  kind: FlowKind;
  sysId: string;
  found: VerifyFound;
  failures: Array<VerifyFailure>;
}

export interface VerifyArtifactParams {
  client: ServiceNowClient;
  sysId: string;
  kind: FlowKind;
  expected?: VerifyExpect;
}

const RX_SYS_ID = /^[0-9a-f]{32}$/;

interface ChildTableSpec {
  /** The SN table to query. */
  table: string;
  /** The FK column on that table that points back at the parent artifact. */
  fkColumn: string;
  /** What this child contributes to the VerifyFound shape. */
  contributes: "inputCount" | "outputCount" | "stepCount";
}

function childTablesFor(kind: FlowKind): Array<ChildTableSpec> {
  if (kind === "actionType") {
    return [
      { table: "sys_hub_action_input", fkColumn: "model_id", contributes: "inputCount" },
      { table: "sys_hub_action_output", fkColumn: "model_id", contributes: "outputCount" },
      { table: "sys_hub_step_instance", fkColumn: "model_id", contributes: "stepCount" },
    ];
  }
  // subflow
  return [
    { table: "sys_hub_flow_input", fkColumn: "flow", contributes: "inputCount" },
    { table: "sys_hub_flow_output", fkColumn: "flow", contributes: "outputCount" },
    { table: "sys_hub_action_instance_v2", fkColumn: "flow", contributes: "stepCount" },
    { table: "sys_hub_flow_logic_instance_v2", fkColumn: "flow", contributes: "stepCount" },
  ];
}

async function countRows(client: ServiceNowClient, table: string, query: string): Promise<number> {
  // Cap the read at 500 — we just need a count, not the bodies. If a flow has
  // >500 child rows of any one type, something has gone very wrong upstream.
  var rows = await client.buildAgent.runQuery<{ sys_id: string }>({
    table: table,
    query: query,
    limit: 500,
  });
  return rows.length;
}

export async function verifyArtifact(params: VerifyArtifactParams): Promise<VerifyReport> {
  if (!RX_SYS_ID.test(params.sysId)) {
    throw new Error("verifyArtifact: sysId must be a 32-char ServiceNow sys_id, got '" + params.sysId + "'");
  }
  var parentTable = params.kind === "actionType" ? "sys_hub_action_type_definition" : "sys_hub_flow";

  // L1.a — parent row exists.
  var parentRows = await params.client.buildAgent.runQuery<{ sys_id: string; type?: string }>({
    table: parentTable,
    query: "sys_id=" + params.sysId,
    limit: 1,
  });
  var parent = parentRows.length === 1;

  // L1.b — child row counts.
  var counts: Record<"inputCount" | "outputCount" | "stepCount", number> = {
    inputCount: 0,
    outputCount: 0,
    stepCount: 0,
  };
  if (parent) {
    var specs = childTablesFor(params.kind);
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var n = await countRows(params.client, spec.table, spec.fkColumn + "=" + params.sysId);
      counts[spec.contributes] = counts[spec.contributes] + n;
    }
  }

  // L4 — snapshot presence. sys_hub_flow_snapshot.flow points at the parent for
  // both subflows and action types (the snapshot is the compiled artifact, and
  // action types are also surfaced through a flow row internally).
  var snapshotPresent = false;
  if (parent) {
    var snapRows = await params.client.buildAgent.runQuery<{ sys_id: string }>({
      table: "sys_hub_flow_snapshot",
      query: "flow=" + params.sysId,
      limit: 1,
    });
    snapshotPresent = snapRows.length > 0;
  }

  var found: VerifyFound = {
    parent: parent,
    inputCount: counts.inputCount,
    outputCount: counts.outputCount,
    stepCount: counts.stepCount,
    snapshotPresent: snapshotPresent,
  };

  var failures: Array<VerifyFailure> = [];
  if (!parent) {
    failures.push({ layer: "L1", field: "parent", expected: true, actual: false });
  }
  var expected = params.expected || {};
  if (expected.inputCount != null && expected.inputCount !== counts.inputCount) {
    failures.push({ layer: "L1", field: "inputCount", expected: expected.inputCount, actual: counts.inputCount });
  }
  if (expected.outputCount != null && expected.outputCount !== counts.outputCount) {
    failures.push({ layer: "L1", field: "outputCount", expected: expected.outputCount, actual: counts.outputCount });
  }
  if (expected.stepCount != null && expected.stepCount !== counts.stepCount) {
    failures.push({ layer: "L1", field: "stepCount", expected: expected.stepCount, actual: counts.stepCount });
  }
  if (expected.publishedSnapshotPresent === true && !snapshotPresent) {
    failures.push({ layer: "L4", field: "publishedSnapshotPresent", expected: true, actual: false });
  }

  return {
    ok: failures.length === 0,
    kind: params.kind,
    sysId: params.sysId,
    found: found,
    failures: failures,
  };
}
