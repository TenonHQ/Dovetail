// Tests for the pure apply-plan decision: refuse-if-dirty, baseline gating,
// --force semantics, and delete eligibility by disposition.

import { buildApplyPlan } from "../reconcile/applyPlan";
import { DirtyRecord, RecordChange, RecordDiff } from "../reconcile/types";

const change = (
  over: Partial<RecordChange> & Pick<RecordChange, "sys_id" | "kind">,
): RecordChange => ({
  table: "sys_script",
  scope: "x_cadso_core",
  name: over.sys_id,
  fieldDeltas: [],
  ...over,
});

const diff = (over: Partial<RecordDiff>): RecordDiff => ({
  creates: [],
  updates: [],
  deletes: [],
  unchangedCount: 0,
  ...over,
});

const dirty = (sys_id: string): DirtyRecord => ({
  sys_id,
  table: "sys_script",
  name: sys_id,
  reason: "changed-since-baseline",
});

describe("buildApplyPlan — refusal gating", () => {
  it("refuses with no baseline", () => {
    const plan = buildApplyPlan({
      diff: diff({}),
      dirty: [],
      hasBaseline: false,
      force: false,
    });
    expect(plan.refuse).toBe(true);
    expect(plan.refuseReason).toContain("--write-baseline");
  });

  it("refuses on drift without --force", () => {
    const plan = buildApplyPlan({
      diff: diff({}),
      dirty: [dirty("a")],
      hasBaseline: true,
      force: false,
    });
    expect(plan.refuse).toBe(true);
    expect(plan.refuseReason).toContain(
      "changed on the instance since baseline",
    );
  });

  it("does not refuse on drift with --force", () => {
    const plan = buildApplyPlan({
      diff: diff({}),
      dirty: [dirty("a")],
      hasBaseline: true,
      force: true,
    });
    expect(plan.refuse).toBe(false);
  });

  it("does not refuse when clean", () => {
    const plan = buildApplyPlan({
      diff: diff({}),
      dirty: [],
      hasBaseline: true,
      force: false,
    });
    expect(plan.refuse).toBe(false);
  });
});

describe("buildApplyPlan — what applies", () => {
  it("includes updates and creates", () => {
    const plan = buildApplyPlan({
      diff: diff({
        updates: [change({ sys_id: "u", kind: "update" })],
        creates: [change({ sys_id: "c", kind: "create" })],
      }),
      dirty: [],
      hasBaseline: true,
      force: false,
    });
    expect(plan.updates.map((u) => u.sys_id)).toEqual(["u"]);
    expect(plan.creates.map((c) => c.sys_id)).toEqual(["c"]);
  });

  it("applies only tracked deletes; keeps local-new and no-baseline", () => {
    const plan = buildApplyPlan({
      diff: diff({
        deletes: [
          change({ sys_id: "t", kind: "delete", deleteDisposition: "tracked" }),
          change({
            sys_id: "l",
            kind: "delete",
            deleteDisposition: "local-new",
          }),
          change({
            sys_id: "n",
            kind: "delete",
            deleteDisposition: "no-baseline",
          }),
        ],
      }),
      dirty: [],
      hasBaseline: true,
      force: false,
    });
    expect(plan.deletes.map((d) => d.sys_id)).toEqual(["t"]);
    expect(plan.skippedDeletes.map((d) => d.sys_id).sort()).toEqual(["l", "n"]);
  });

  it("--force still never deletes local-new records", () => {
    const plan = buildApplyPlan({
      diff: diff({
        deletes: [
          change({
            sys_id: "mine",
            kind: "delete",
            deleteDisposition: "local-new",
          }),
        ],
      }),
      dirty: [dirty("other")],
      hasBaseline: true,
      force: true,
    });
    expect(plan.deletes).toHaveLength(0);
    expect(plan.skippedDeletes.map((d) => d.sys_id)).toEqual(["mine"]);
  });
});
