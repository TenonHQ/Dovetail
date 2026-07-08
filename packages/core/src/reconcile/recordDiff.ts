// The pure record-diff engine: classify every tracked record into create /
// update / delete / unchanged by joining the branch and live sides on sys_id.
// No I/O — callers supply already-normalized ReconcileRecord[] (see
// recordSource.ts for the on-disk + instance adapters). Fully unit-testable.

import {
  DeleteDisposition,
  FieldDelta,
  RecordChange,
  RecordChangeKind,
  RecordDiff,
  ReconcileRecord,
} from "./types";

function indexBySysId(
  records: ReconcileRecord[],
): Map<string, ReconcileRecord> {
  const map = new Map<string, ReconcileRecord>();
  for (const record of records) {
    map.set(record.sys_id, record);
  }
  return map;
}

function toChange(
  kind: RecordChangeKind,
  record: ReconcileRecord,
  fieldDeltas: FieldDelta[],
): RecordChange {
  return {
    kind,
    table: record.table,
    scope: record.scope,
    sys_id: record.sys_id,
    name: record.name,
    fieldDeltas,
  };
}

// Compare two sides of the same record. Emits one FieldDelta per field that is
// added, removed, or changed; identical fields produce nothing.
function computeFieldDeltas(
  branch: ReconcileRecord,
  live: ReconcileRecord,
): FieldDelta[] {
  const keys = new Set<string>();
  for (const key of Object.keys(branch.fields)) {
    keys.add(key);
  }
  for (const key of Object.keys(live.fields)) {
    keys.add(key);
  }

  const deltas: FieldDelta[] = [];
  for (const key of Array.from(keys).sort()) {
    const onBranch = Object.prototype.hasOwnProperty.call(branch.fields, key);
    const onLive = Object.prototype.hasOwnProperty.call(live.fields, key);
    const changed =
      onBranch && onLive && branch.fields[key] !== live.fields[key];
    if (!onBranch || !onLive || changed) {
      deltas.push({ field: key, onBranch, onLive, changed });
    }
  }
  return deltas;
}

function byTableThenName(a: RecordChange, b: RecordChange): number {
  if (a.table !== b.table) {
    return a.table < b.table ? -1 : 1;
  }
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  return a.sys_id < b.sys_id ? -1 : a.sys_id > b.sys_id ? 1 : 0;
}

export interface DiffRecordsOptions {
  /** Records the checked-out branch carries (on-disk). */
  branch: ReconcileRecord[];
  /** Records the live instance currently carries (Dovetail-tracked). */
  live: ReconcileRecord[];
  /**
   * sys_ids the baseline knew about, for delete disambiguation. Pass `null`
   * when no baseline exists yet — every instance-only record is then marked
   * "no-baseline" and never proposed for deletion.
   */
  baselineSysIds: Set<string> | null;
}

export function diffRecords(options: DiffRecordsOptions): RecordDiff {
  const { branch, live } = options;
  const branchIndex = indexBySysId(branch);
  const liveIndex = indexBySysId(live);
  const hasBaseline = options.baselineSysIds !== null;
  const baseline = options.baselineSysIds || new Set<string>();

  const creates: RecordChange[] = [];
  const updates: RecordChange[] = [];
  const deletes: RecordChange[] = [];
  let unchangedCount = 0;

  // CREATE + UPDATE/unchanged — walk the branch side.
  for (const branchRecord of branch) {
    const liveRecord = liveIndex.get(branchRecord.sys_id);
    if (!liveRecord) {
      creates.push(toChange("create", branchRecord, []));
      continue;
    }
    const deltas = computeFieldDeltas(branchRecord, liveRecord);
    if (deltas.length === 0) {
      unchangedCount++;
    } else {
      updates.push(toChange("update", branchRecord, deltas));
    }
  }

  // DELETE — live records the branch no longer carries.
  for (const liveRecord of live) {
    if (branchIndex.has(liveRecord.sys_id)) {
      continue;
    }
    let disposition: DeleteDisposition;
    if (!hasBaseline) {
      disposition = "no-baseline";
    } else if (baseline.has(liveRecord.sys_id)) {
      disposition = "tracked";
    } else {
      disposition = "local-new";
    }
    const change = toChange("delete", liveRecord, []);
    change.deleteDisposition = disposition;
    deletes.push(change);
  }

  creates.sort(byTableThenName);
  updates.sort(byTableThenName);
  deletes.sort(byTableThenName);

  return { creates, updates, deletes, unchangedCount };
}
