/**
 * Clone a Subflow — pull the full record graph for a source sys_hub_flow,
 * generate fresh sys_ids for every row, swap scope, rename, then write the
 * whole graph through claude.createRecord pinned to the caller's update set.
 *
 * Phase 1.C MVP scope:
 *   - Tables cloned: sys_hub_flow + sys_hub_flow_input + sys_hub_flow_output
 *     + sys_hub_flow_variable + sys_hub_action_instance_v2 +
 *     sys_hub_flow_logic_instance_v2
 *   - All FK references that point at the source flow's sys_id are rewritten
 *     to point at the new flow's sys_id, using the (sourceSysId → newSysId)
 *     map built before the first write. This is the "pre-generate everything,
 *     write linearly" pattern.
 *   - References to action_type sys_ids inside sys_hub_action_instance_v2 are
 *     preserved AS-IS — the assumption is that custom action types referenced
 *     by the source subflow exist (or have been independently cloned) in the
 *     destination scope. Cross-scope clone where action types are private is
 *     a Phase 1.C.2 concern.
 *   - V2 `values` blobs are not rewritten. They reference upstream steps by
 *     display name, not by sys_id, so a name-preserving clone leaves them
 *     valid. If a future caller wants to rename steps mid-clone, that work
 *     belongs in encodeV2Values + a remap step inside cloneSubflow.
 *   - Idempotency: if a sys_hub_flow with `(name, sys_scope)=(newName, newScope)`
 *     already exists, return its sys_id with action="unchanged" and skip writes.
 *     Children are NOT diffed in MVP — re-running clone with mutated
 *     modifications against an already-cloned target won't catch up, it just
 *     short-circuits. Treat that as a known limitation; full diff-and-update
 *     belongs in Phase 1.C.2.
 */

import type { ServiceNowClient } from "../client";
import {
  generateSysId,
  stripSystemFields,
  applyScope,
  assertSysId,
} from "./shape";
import type { WriteOp, WriteOpResult } from "./writeOrder";
import { executeWritePlan } from "./writeOrder";

export interface CloneSubflowParams {
  client: ServiceNowClient;
  sourceSysId: string;
  newName: string;
  newScope: string;
  updateSetSysId: string;
  /** Optional: shallow field overrides applied to the parent sys_hub_flow row. */
  modifications?: {
    description?: string;
    /** Free-form patch applied last on top of the cloned + scoped record. */
    fieldPatch?: Record<string, unknown>;
  };
  dryRun?: boolean;
}

export interface CloneSubflowResult {
  sysId: string;
  action: "created" | "unchanged";
  written: Array<WriteOpResult>;
  /** Plan that WOULD run when dryRun=true; empty when dryRun=false (writes ran). */
  plan?: Array<WriteOp>;
}

interface ChildPullSpec {
  table: string;
  fkColumn: "flow";
  /** Plan-local id prefix (used in WriteOp.id). */
  prefix: string;
}

const CHILD_TABLES: ReadonlyArray<ChildPullSpec> = [
  { table: "sys_hub_flow_input", fkColumn: "flow", prefix: "input" },
  { table: "sys_hub_flow_output", fkColumn: "flow", prefix: "output" },
  { table: "sys_hub_flow_variable", fkColumn: "flow", prefix: "variable" },
  { table: "sys_hub_action_instance_v2", fkColumn: "flow", prefix: "action" },
  { table: "sys_hub_flow_logic_instance_v2", fkColumn: "flow", prefix: "logic" },
];

async function fetchSourceParent(client: ServiceNowClient, sourceSysId: string): Promise<Record<string, any>> {
  var rows = await client.buildAgent.runQuery<any>({
    table: "sys_hub_flow",
    query: "sys_id=" + sourceSysId,
    limit: 1,
  });
  if (!rows.length) {
    throw new Error("cloneSubflow: source sys_hub_flow not found: " + sourceSysId);
  }
  if (rows[0].type && rows[0].type !== "subflow") {
    throw new Error("cloneSubflow: source sys_id " + sourceSysId + " is not a subflow (type=" + rows[0].type + ")");
  }
  return rows[0];
}

async function fetchChildren(
  client: ServiceNowClient,
  sourceSysId: string,
): Promise<Array<{ spec: ChildPullSpec; rows: Array<Record<string, any>> }>> {
  var out: Array<{ spec: ChildPullSpec; rows: Array<Record<string, any>> }> = [];
  for (var i = 0; i < CHILD_TABLES.length; i++) {
    var spec = CHILD_TABLES[i];
    var rows = await client.buildAgent.runQuery<any>({
      table: spec.table,
      query: spec.fkColumn + "=" + sourceSysId,
      limit: 500,
    });
    out.push({ spec: spec, rows: rows });
  }
  return out;
}

export async function cloneSubflow(opts: CloneSubflowParams): Promise<CloneSubflowResult> {
  assertSysId(opts.sourceSysId, "sourceSysId");
  assertSysId(opts.newScope, "newScope");
  assertSysId(opts.updateSetSysId, "updateSetSysId");
  if (typeof opts.newName !== "string" || opts.newName.trim().length === 0) {
    throw new Error("cloneSubflow: newName is required");
  }

  // Idempotency guard: bail if (newName, newScope) already exists.
  var existing = await opts.client.buildAgent.runQuery<{ sys_id: string }>({
    table: "sys_hub_flow",
    query: "name=" + opts.newName + "^sys_scope=" + opts.newScope + "^type=subflow",
    limit: 1,
  });
  if (existing.length > 0) {
    return {
      sysId: existing[0].sys_id,
      action: "unchanged",
      written: [],
    };
  }

  var sourceParent = await fetchSourceParent(opts.client, opts.sourceSysId);
  var sourceChildren = await fetchChildren(opts.client, opts.sourceSysId);

  var newFlowSysId = generateSysId();

  // Build the parent WriteOp.
  var parentFields = stripSystemFields(sourceParent);
  parentFields = applyScope(parentFields, opts.newScope);
  delete (parentFields as Record<string, unknown>).master_snapshot;
  delete (parentFields as Record<string, unknown>).latest_snapshot;
  parentFields.sys_id = newFlowSysId;
  parentFields.name = opts.newName;
  // internal_name is SN's machine-stable identifier; mirror name change.
  if ("internal_name" in (parentFields as Record<string, unknown>)) {
    parentFields.internal_name = opts.newName;
  }
  if (opts.modifications) {
    if (opts.modifications.description != null) parentFields.description = opts.modifications.description;
    if (opts.modifications.fieldPatch) {
      parentFields = Object.assign({}, parentFields, opts.modifications.fieldPatch);
    }
  }

  var ops: Array<WriteOp> = [
    {
      id: "parent",
      logicalName: "sys_hub_flow:" + opts.newName,
      table: "sys_hub_flow",
      fields: parentFields as Record<string, unknown>,
      dependsOn: [],
      scope: opts.newScope,
    },
  ];

  // Each child gets a fresh sys_id and a rewritten `flow` FK.
  for (var c = 0; c < sourceChildren.length; c++) {
    var bucket = sourceChildren[c];
    for (var r = 0; r < bucket.rows.length; r++) {
      var src = bucket.rows[r];
      var childFields = stripSystemFields(src);
      childFields = applyScope(childFields, opts.newScope);
      childFields.sys_id = generateSysId();
      childFields[bucket.spec.fkColumn] = newFlowSysId;
      ops.push({
        id: bucket.spec.prefix + ":" + r,
        logicalName: bucket.spec.table + ":" + (src.name || src.sys_id),
        table: bucket.spec.table,
        fields: childFields as Record<string, unknown>,
        dependsOn: ["parent"],
        scope: opts.newScope,
      });
    }
  }

  if (opts.dryRun) {
    return {
      sysId: newFlowSysId,
      action: "created",
      written: [],
      plan: ops,
    };
  }

  var written = await executeWritePlan(opts.client, ops, opts.updateSetSysId);
  return {
    sysId: newFlowSysId,
    action: "created",
    written: written,
  };
}
