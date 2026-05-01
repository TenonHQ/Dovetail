/**
 * Write-order planner for flowDesigner authoring.
 *
 * A clone or create call produces a graph of WriteOps — one per record to be
 * written, with explicit dependencies (the parent flow row must be written
 * before any input/output/step row that references it via FK). topoSort
 * orders these into a deterministic write sequence; executeWritePlan runs
 * them through client.claude.createRecord while pinning every write to the
 * caller's update set.
 *
 * The id field on a WriteOp is the PLAN-LOCAL id used to wire dependencies
 * between ops. The actual ServiceNow sys_id of each row is set in
 * `fields.sys_id` ahead of time (clone/create pre-generate them so child
 * ops can reference the parent's sys_id as a literal). Decoupling the two
 * lets us topo-sort without caring about SN side at all.
 */

import type { ServiceNowClient } from "../client";

export interface WriteOp {
  /** Plan-local id, opaque to ServiceNow. Used only for dependency wiring. */
  id: string;
  /** Human-readable name persisted to the (logical_name → sys_id) ctx map. */
  logicalName: string;
  table: string;
  /** Must include `sys_id` if the caller wants to control it (clone/create do). */
  fields: Record<string, unknown>;
  /** Plan-local ids of WriteOps that must complete before this one runs. */
  dependsOn: Array<string>;
  /**
   * Optional: tells claude.createRecord which scope to write under. Defaults
   * to the scope on the record's `sys_scope` / `application` field server-side.
   */
  scope?: string;
}

export interface WriteOpResult {
  id: string;
  logicalName: string;
  table: string;
  sysId: string;
  /** Currently always "created" — claude.createRecord doesn't distinguish. */
  action: "created";
}

export class WriteOrderError extends Error {
  constructor(message: string, public readonly cycleIds?: Array<string>) {
    super(message);
    this.name = "WriteOrderError";
  }
}

/**
 * Kahn's-algorithm topological sort. Produces a deterministic order: ties are
 * broken by `id` lexicographically so the same input always yields the same
 * output (important for diagnostic stability across retries).
 *
 * Throws WriteOrderError on cycles, with the offending ids attached.
 */
export function topoSort(ops: Array<WriteOp>): Array<WriteOp> {
  var byId: Record<string, WriteOp> = {};
  var indeg: Record<string, number> = {};
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (byId[op.id]) {
      throw new WriteOrderError("duplicate WriteOp.id: " + op.id);
    }
    byId[op.id] = op;
    indeg[op.id] = 0;
  }
  // Validate dependencies exist; build reverse adjacency.
  var fwd: Record<string, Array<string>> = {};
  for (var j = 0; j < ops.length; j++) {
    var o = ops[j];
    var deps = o.dependsOn || [];
    for (var k = 0; k < deps.length; k++) {
      var dep = deps[k];
      if (!byId[dep]) {
        throw new WriteOrderError("WriteOp '" + o.id + "' depends on unknown id '" + dep + "'");
      }
      if (!fwd[dep]) fwd[dep] = [];
      fwd[dep].push(o.id);
      indeg[o.id] = indeg[o.id] + 1;
    }
  }
  // Kahn's: start with all zero-indegree nodes, sorted lex for determinism.
  var ready: Array<string> = [];
  var sortedKeys = Object.keys(indeg).sort();
  for (var s = 0; s < sortedKeys.length; s++) {
    if (indeg[sortedKeys[s]] === 0) ready.push(sortedKeys[s]);
  }
  var out: Array<WriteOp> = [];
  while (ready.length > 0) {
    ready.sort();
    var nextId = ready.shift() as string;
    out.push(byId[nextId]);
    var children = fwd[nextId] || [];
    for (var c = 0; c < children.length; c++) {
      indeg[children[c]] = indeg[children[c]] - 1;
      if (indeg[children[c]] === 0) ready.push(children[c]);
    }
  }
  if (out.length !== ops.length) {
    var unresolved: Array<string> = [];
    var allKeys = Object.keys(indeg);
    for (var u = 0; u < allKeys.length; u++) {
      if (indeg[allKeys[u]] > 0) unresolved.push(allKeys[u]);
    }
    throw new WriteOrderError(
      "cycle detected in write plan; offending ops: " + unresolved.join(", "),
      unresolved,
    );
  }
  return out;
}

/**
 * Execute a topo-sorted plan via client.claude.createRecord. Each op must
 * carry its own `fields.sys_id` so this function never has to backpatch
 * references — every dependency is already a literal sys_id in the child's
 * fields by the time we get here.
 *
 * Writes are sequential by design — claude.createRecord pins the active
 * update set and scope server-side, and parallel writes would race. If a
 * single write throws, partial state is left in the (uncommitted) update
 * set — callers rely on update-set discard for rollback. The throw includes
 * the failing op's id and table for diagnostics.
 */
export async function executeWritePlan(
  client: ServiceNowClient,
  ops: Array<WriteOp>,
  updateSetSysId: string,
): Promise<Array<WriteOpResult>> {
  if (typeof updateSetSysId !== "string" || updateSetSysId.length !== 32) {
    throw new Error("executeWritePlan: updateSetSysId must be a 32-char sys_id");
  }
  var sorted = topoSort(ops);
  var results: Array<WriteOpResult> = [];
  for (var i = 0; i < sorted.length; i++) {
    var op = sorted[i];
    if (typeof op.fields.sys_id !== "string") {
      throw new Error(
        "executeWritePlan: WriteOp '" + op.id + "' missing fields.sys_id — " +
        "clone/create must pre-generate sys_ids so dependent ops can reference them",
      );
    }
    var fields = op.fields as Record<string, any>;
    try {
      var written = await client.claude.createRecord({
        table: op.table,
        fields: fields,
        scope: op.scope,
        update_set_sys_id: updateSetSysId,
        sys_id: fields.sys_id,
      });
      results.push({
        id: op.id,
        logicalName: op.logicalName,
        table: op.table,
        sysId: written.sys_id || (fields.sys_id as string),
        action: "created",
      });
    } catch (err: any) {
      var msg = err && err.message ? err.message : String(err);
      throw new Error(
        "executeWritePlan: write failed at op '" + op.id + "' (" + op.table + "): " + msg,
      );
    }
  }
  return results;
}
