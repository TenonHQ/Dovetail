// Tests for the multi-pass delete loop: clean deletes, emergent FK ordering
// (a record blocked until its dependent is gone), and a genuine failure that
// survives a no-progress pass and is reported.

import { runMultiPassDeletes, DeleteExecutor } from "../reconcile/deleteOrder";
import { RecordChange } from "../reconcile/types";

const del = (sys_id: string): RecordChange => ({
  kind: "delete",
  table: "sys_script",
  scope: "x_cadso_core",
  sys_id,
  name: sys_id,
  fieldDeltas: [],
  deleteDisposition: "tracked",
});

describe("runMultiPassDeletes", () => {
  it("deletes everything in a single clean pass", async () => {
    const calls: string[] = [];
    const exec: DeleteExecutor = async (c) => {
      calls.push(c.sys_id);
      return { ok: true };
    };
    const out = await runMultiPassDeletes([del("a"), del("b")], exec);
    expect(out.every((o) => o.ok)).toBe(true);
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  it("resolves FK ordering: parent succeeds only after the child is gone", async () => {
    // "parent" cannot delete while "child" still exists.
    const deleted = new Set<string>();
    const exec: DeleteExecutor = async (c) => {
      if (c.sys_id === "parent" && !deleted.has("child")) {
        return { ok: false, error: "still referenced by child" };
      }
      deleted.add(c.sys_id);
      return { ok: true };
    };
    // parent is attempted first, fails, then succeeds on the pass after child.
    const out = await runMultiPassDeletes([del("parent"), del("child")], exec);
    expect(out.filter((o) => o.ok).map((o) => o.change.sys_id).sort()).toEqual([
      "child",
      "parent",
    ]);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it("reports a record that fails for a non-ordering reason", async () => {
    const exec: DeleteExecutor = async (c) => {
      if (c.sys_id === "locked") {
        return { ok: false, error: "ACL blocked" };
      }
      return { ok: true };
    };
    const out = await runMultiPassDeletes([del("ok"), del("locked")], exec);
    const failed = out.filter((o) => !o.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].change.sys_id).toBe("locked");
    expect(failed[0].error).toBe("ACL blocked");
  });

  it("treats a thrown executor error as a failure", async () => {
    const exec: DeleteExecutor = async () => {
      throw new Error("network down");
    };
    const out = await runMultiPassDeletes([del("a")], exec);
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toBe("network down");
  });

  it("returns [] for no changes", async () => {
    const out = await runMultiPassDeletes([], async () => ({ ok: true }));
    expect(out).toEqual([]);
  });
});
