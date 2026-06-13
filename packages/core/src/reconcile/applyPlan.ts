// Pure decision layer for the reconcile apply phase: given a classified diff,
// the dirty set, and the flags, decide whether to refuse and exactly which
// changes are eligible to apply. No I/O — the command layer executes the plan.
//
// Safety model (the git-checkout analogy):
//   - No baseline            -> refuse. You must establish the merge-base first
//                              (`dove reconcile --write-baseline`); without it
//                              there is no way to tell the dev's edits from the
//                              branch's, so an apply could clobber local work.
//   - Drift, no --force      -> refuse. Tracked records changed on the instance
//                              since baseline; refresh to keep them or --force.
//   - Clean, or --force      -> apply.
//
// What applies, in Phase 2:
//   - UPDATE  every diff update (branch content overwrites the instance).
//   - DELETE  only "tracked" instance-only records (the branch deleted them).
//             "local-new" / "no-baseline" records are the dev's own creations —
//             NEVER deleted, not even with --force (force discards edits to the
//             branch's records, it does not reap records the branch never owned).
//   - CREATE  deferred to Phase 3 — reported, never applied here.

import { DirtyRecord, RecordChange, RecordDiff } from "./types";

export interface ApplyPlan {
  refuse: boolean;
  refuseReason: string;
  /** Updates eligible to apply (branch -> instance). */
  updates: RecordChange[];
  /** Tracked instance-only deletes eligible to apply. */
  deletes: RecordChange[];
  /** Instance-only records kept (local-new / no-baseline) — reported, never deleted. */
  skippedDeletes: RecordChange[];
  /** Creates deferred to Phase 3 — reported, never applied here. */
  deferredCreates: RecordChange[];
}

export interface BuildApplyPlanOptions {
  diff: RecordDiff;
  dirty: DirtyRecord[];
  hasBaseline: boolean;
  force: boolean;
}

export function buildApplyPlan(options: BuildApplyPlanOptions): ApplyPlan {
  const { diff, dirty, hasBaseline, force } = options;

  const deletes: RecordChange[] = [];
  const skippedDeletes: RecordChange[] = [];
  for (const change of diff.deletes) {
    if (change.deleteDisposition === "tracked") {
      deletes.push(change);
    } else {
      skippedDeletes.push(change);
    }
  }

  let refuse = false;
  let refuseReason = "";
  if (!hasBaseline) {
    refuse = true;
    refuseReason =
      "no baseline for this instance — establish the merge-base first with " +
      "`dove reconcile --write-baseline`, then re-run apply.";
  } else if (dirty.length > 0 && !force) {
    refuse = true;
    refuseReason =
      dirty.length +
      " record(s) changed on the instance since baseline. Keep them with " +
      "`dove refresh`, or discard them with --force.";
  }

  return {
    refuse,
    refuseReason,
    updates: diff.updates.slice(),
    deletes,
    skippedDeletes,
    deferredCreates: diff.creates.slice(),
  };
}
