// Tests for the pure reconcile record-diff engine — CRUD classification by
// sys_id, field-level deltas, and delete disambiguation against the baseline.

import { diffRecords } from "../reconcile/recordDiff";
import { ReconcileRecord } from "../reconcile/types";

const rec = (
  over: Partial<ReconcileRecord> & Pick<ReconcileRecord, "sys_id">,
): ReconcileRecord => ({
  table: "sys_script_include",
  scope: "x_cadso_core",
  name: over.sys_id,
  updatedOn: "2026-06-01 00:00:00",
  fields: { "script.js": "var a = 1;" },
  ...over,
});

describe("diffRecords — classification", () => {
  it("marks a branch-only record as create", () => {
    const diff = diffRecords({
      branch: [rec({ sys_id: "a" })],
      live: [],
      baselineSysIds: new Set(),
    });
    expect(diff.creates.map((c) => c.sys_id)).toEqual(["a"]);
    expect(diff.updates).toHaveLength(0);
    expect(diff.deletes).toHaveLength(0);
  });

  it("marks identical records as unchanged (not update)", () => {
    const diff = diffRecords({
      branch: [rec({ sys_id: "a", fields: { "script.js": "X" } })],
      live: [rec({ sys_id: "a", fields: { "script.js": "X" } })],
      baselineSysIds: new Set(["a"]),
    });
    expect(diff.unchangedCount).toBe(1);
    expect(diff.updates).toHaveLength(0);
    expect(diff.creates).toHaveLength(0);
    expect(diff.deletes).toHaveLength(0);
  });

  it("marks a content difference as update with a changed field delta", () => {
    const diff = diffRecords({
      branch: [rec({ sys_id: "a", fields: { "script.js": "NEW" } })],
      live: [rec({ sys_id: "a", fields: { "script.js": "OLD" } })],
      baselineSysIds: new Set(["a"]),
    });
    expect(diff.updates).toHaveLength(1);
    const deltas = diff.updates[0].fieldDeltas;
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      field: "script.js",
      onBranch: true,
      onLive: true,
      changed: true,
    });
  });

  it("reports a field present only on the branch and only on the instance", () => {
    const diff = diffRecords({
      branch: [rec({ sys_id: "a", fields: { "script.js": "X", "extra.js": "Y" } })],
      live: [rec({ sys_id: "a", fields: { "script.js": "X", "old.js": "Z" } })],
      baselineSysIds: new Set(["a"]),
    });
    const deltas = diff.updates[0].fieldDeltas;
    const byField = Object.fromEntries(deltas.map((d) => [d.field, d]));
    expect(byField["extra.js"]).toMatchObject({ onBranch: true, onLive: false, changed: false });
    expect(byField["old.js"]).toMatchObject({ onBranch: false, onLive: true, changed: false });
    // unchanged shared field is not emitted
    expect(byField["script.js"]).toBeUndefined();
  });
});

describe("diffRecords — delete disambiguation", () => {
  it("marks an instance-only record in the baseline as a tracked delete", () => {
    const diff = diffRecords({
      branch: [],
      live: [rec({ sys_id: "gone" })],
      baselineSysIds: new Set(["gone"]),
    });
    expect(diff.deletes).toHaveLength(1);
    expect(diff.deletes[0].deleteDisposition).toBe("tracked");
  });

  it("marks an instance-only record absent from the baseline as local-new (drift)", () => {
    const diff = diffRecords({
      branch: [],
      live: [rec({ sys_id: "mine" })],
      baselineSysIds: new Set(["other"]),
    });
    expect(diff.deletes[0].deleteDisposition).toBe("local-new");
  });

  it("marks every instance-only record no-baseline when no baseline exists", () => {
    const diff = diffRecords({
      branch: [],
      live: [rec({ sys_id: "x" }), rec({ sys_id: "y" })],
      baselineSysIds: null,
    });
    expect(diff.deletes.map((d) => d.deleteDisposition)).toEqual([
      "no-baseline",
      "no-baseline",
    ]);
  });
});

describe("diffRecords — ordering & convergence", () => {
  it("sorts each bucket by table then name", () => {
    const diff = diffRecords({
      branch: [
        rec({ sys_id: "2", table: "sys_script", name: "b" }),
        rec({ sys_id: "1", table: "sys_script", name: "a" }),
        rec({ sys_id: "3", table: "sys_script_include", name: "a" }),
      ],
      live: [],
      baselineSysIds: new Set(),
    });
    expect(diff.creates.map((c) => c.table + "/" + c.name)).toEqual([
      "sys_script/a",
      "sys_script/b",
      "sys_script_include/a",
    ]);
  });

  it("an already-converged instance produces an empty diff (idempotent)", () => {
    const records = [rec({ sys_id: "a" }), rec({ sys_id: "b" })];
    const diff = diffRecords({
      branch: records,
      live: records,
      baselineSysIds: new Set(["a", "b"]),
    });
    expect(diff.creates).toHaveLength(0);
    expect(diff.updates).toHaveLength(0);
    expect(diff.deletes).toHaveLength(0);
    expect(diff.unchangedCount).toBe(2);
  });
});
