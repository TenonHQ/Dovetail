/**
 * Clone a Custom Action Type — pulls the full record graph for a source
 * sys_hub_action_type_definition, generates fresh sys_ids, swaps scope,
 * renames, and writes the graph through claude.createRecord pinned to the
 * caller's update set.
 *
 * Phase 1.C MVP scope:
 *   - Tables cloned: sys_hub_action_type_definition + sys_hub_action_input
 *     + sys_hub_action_output + sys_hub_step_instance
 *   - Child rows are linked to the action type via the `model_id` FK column
 *     (confirmed empirically against tenonworkstudio's sys_dictionary).
 *   - sys_hub_step_ext_input / sys_hub_step_ext_output are NOT cloned in
 *     MVP — they're per-step data-pill metadata that ServiceNow regenerates
 *     when the action's snapshot is recompiled. If integration testing shows
 *     they ARE needed at write-time, add them in Phase 1.C.2 (they FK back
 *     via `model_id` to a sys_hub_step_instance).
 *   - Idempotency mirrors cloneSubflow: existing (newName, newScope) returns
 *     "unchanged" and skips writes.
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

export interface CloneActionTypeParams {
  client: ServiceNowClient;
  sourceSysId: string;
  newName: string;
  newScope: string;
  updateSetSysId: string;
  modifications?: {
    description?: string;
    fieldPatch?: Record<string, unknown>;
  };
  dryRun?: boolean;
}

export interface CloneActionTypeResult {
  sysId: string;
  action: "created" | "unchanged";
  written: Array<WriteOpResult>;
  plan?: Array<WriteOp>;
}

interface ChildPullSpec {
  table: string;
  fkColumn: "model_id";
  prefix: string;
}

const CHILD_TABLES: ReadonlyArray<ChildPullSpec> = [
  { table: "sys_hub_action_input", fkColumn: "model_id", prefix: "input" },
  { table: "sys_hub_action_output", fkColumn: "model_id", prefix: "output" },
  { table: "sys_hub_step_instance", fkColumn: "model_id", prefix: "step" },
];

async function fetchSourceParent(client: ServiceNowClient, sourceSysId: string): Promise<Record<string, any>> {
  var rows = await client.buildAgent.runQuery<any>({
    table: "sys_hub_action_type_definition",
    query: "sys_id=" + sourceSysId,
    limit: 1,
  });
  if (!rows.length) {
    throw new Error("cloneActionType: source sys_hub_action_type_definition not found: " + sourceSysId);
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

export async function cloneActionType(opts: CloneActionTypeParams): Promise<CloneActionTypeResult> {
  assertSysId(opts.sourceSysId, "sourceSysId");
  assertSysId(opts.newScope, "newScope");
  assertSysId(opts.updateSetSysId, "updateSetSysId");
  if (typeof opts.newName !== "string" || opts.newName.trim().length === 0) {
    throw new Error("cloneActionType: newName is required");
  }

  // Idempotency: existing (newName, newScope) short-circuits.
  var existing = await opts.client.buildAgent.runQuery<{ sys_id: string }>({
    table: "sys_hub_action_type_definition",
    query: "name=" + opts.newName + "^sys_scope=" + opts.newScope,
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

  var newSysId = generateSysId();

  var parentFields = stripSystemFields(sourceParent);
  parentFields = applyScope(parentFields, opts.newScope);
  delete (parentFields as Record<string, unknown>).master_snapshot;
  delete (parentFields as Record<string, unknown>).latest_snapshot;
  parentFields.sys_id = newSysId;
  parentFields.name = opts.newName;
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
      logicalName: "sys_hub_action_type_definition:" + opts.newName,
      table: "sys_hub_action_type_definition",
      fields: parentFields as Record<string, unknown>,
      dependsOn: [],
      scope: opts.newScope,
    },
  ];

  for (var c = 0; c < sourceChildren.length; c++) {
    var bucket = sourceChildren[c];
    for (var r = 0; r < bucket.rows.length; r++) {
      var src = bucket.rows[r];
      var childFields = stripSystemFields(src);
      childFields = applyScope(childFields, opts.newScope);
      childFields.sys_id = generateSysId();
      childFields[bucket.spec.fkColumn] = newSysId;
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
      sysId: newSysId,
      action: "created",
      written: [],
      plan: ops,
    };
  }

  var written = await executeWritePlan(opts.client, ops, opts.updateSetSysId);
  return {
    sysId: newSysId,
    action: "created",
    written: written,
  };
}
