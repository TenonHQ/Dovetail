// FK-safe record operations without building a dependency graph. ServiceNow
// refuses to delete a record another still references, and refuses to create a
// record before the parent it references exists. Both orderings fall out of the
// same loop: attempt every pending record, keep whatever succeeded, retry the
// failures next pass, stop when a full pass makes no progress (a genuine,
// non-ordering failure — e.g. ACL) and report the stragglers.
//   - DELETE: a parent blocked by a still-present child succeeds once the child
//     is gone (children before parents).
//   - CREATE: a child blocked by a missing parent succeeds once the parent
//     exists (parents before children).
//
// Pure control flow: the operation is injected, so the loop is unit-tested with
// a fake executor that encodes a dependency ("B cannot proceed until A has").

import { RecordChange } from "./types";

export interface OpAttemptResult {
  ok: boolean;
  error?: string;
}

export interface OpOutcome {
  change: RecordChange;
  ok: boolean;
  error?: string;
}

export type OpExecutor = (change: RecordChange) => Promise<OpAttemptResult>;

export async function runMultiPassOps(
  changes: RecordChange[],
  attempt: OpExecutor,
): Promise<OpOutcome[]> {
  const succeeded: OpOutcome[] = [];
  let pending = changes.slice();
  let lastError = new Map<string, string>();

  while (pending.length > 0) {
    const stillPending: RecordChange[] = [];
    let progressed = false;
    lastError = new Map<string, string>();

    for (const change of pending) {
      let result: OpAttemptResult;
      try {
        result = await attempt(change);
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (result.ok) {
        succeeded.push({ change, ok: true });
        progressed = true;
      } else {
        stillPending.push(change);
        lastError.set(change.sys_id, result.error || "operation failed");
      }
    }

    pending = stillPending;
    if (!progressed) {
      // A full pass changed nothing — the remaining failures are not ordering
      // problems. Report them and stop.
      break;
    }
  }

  const failures: OpOutcome[] = pending.map((change) => ({
    change,
    ok: false,
    error: lastError.get(change.sys_id) || "operation failed",
  }));

  return succeeded.concat(failures);
}
