// FK-safe deletion without building a dependency graph. ServiceNow refuses to
// delete a record another record still references; the safe order is therefore
// children before parents. Rather than model the foreign-key graph, delete in
// passes: attempt every pending record, keep whatever succeeded, and retry the
// failures on the next pass. A record blocked by a still-present dependent
// succeeds once that dependent is gone. Stop when a full pass makes no progress
// (a genuine, non-ordering failure — e.g. ACL) and report the stragglers.
//
// Pure control flow: the actual delete is injected, so the loop is unit-tested
// with a fake executor that encodes "B cannot delete until A is gone."

import { RecordChange } from "./types";

export interface DeleteAttemptResult {
  ok: boolean;
  error?: string;
}

export interface DeleteOutcome {
  change: RecordChange;
  ok: boolean;
  error?: string;
}

export type DeleteExecutor = (
  change: RecordChange,
) => Promise<DeleteAttemptResult>;

export async function runMultiPassDeletes(
  changes: RecordChange[],
  attemptDelete: DeleteExecutor,
): Promise<DeleteOutcome[]> {
  const succeeded: DeleteOutcome[] = [];
  let pending = changes.slice();
  let lastError = new Map<string, string>();

  while (pending.length > 0) {
    const stillPending: RecordChange[] = [];
    let progressed = false;
    lastError = new Map<string, string>();

    for (const change of pending) {
      let result: DeleteAttemptResult;
      try {
        result = await attemptDelete(change);
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (result.ok) {
        succeeded.push({ change, ok: true });
        progressed = true;
      } else {
        stillPending.push(change);
        lastError.set(change.sys_id, result.error || "delete failed");
      }
    }

    pending = stillPending;
    if (!progressed) {
      // A full pass deleted nothing — the remaining failures are not ordering
      // problems. Report them and stop.
      break;
    }
  }

  const failures: DeleteOutcome[] = pending.map((change) => ({
    change,
    ok: false,
    error: lastError.get(change.sys_id) || "delete failed",
  }));

  return succeeded.concat(failures);
}
