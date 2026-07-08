// Tests for the generic multi-pass op loop: clean ops, emergent ordering (a
// record blocked until its dependency resolves), a genuine failure surviving a
// no-progress pass, and thrown-error handling. Exercised for both delete
// ordering (children before parents) and create ordering (parents before
// children).

import { runMultiPassOps, OpExecutor } from "../reconcile/multiPass";
import { RecordChange } from "../reconcile/types";

const rec = (sys_id: string, kind: RecordChange["kind"]): RecordChange => ({
  kind,
  table: "sys_script",
  scope: "x_cadso_core",
  sys_id,
  name: sys_id,
  fieldDeltas: [],
});

describe("runMultiPassOps", () => {
  it("completes everything in a single clean pass", async () => {
    const calls: string[] = [];
    const exec: OpExecutor = async (c) => {
      calls.push(c.sys_id);
      return { ok: true };
    };
    const out = await runMultiPassOps(
      [rec("a", "delete"), rec("b", "delete")],
      exec,
    );
    expect(out.every((o) => o.ok)).toBe(true);
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  it("resolves DELETE ordering: parent succeeds only after child is gone", async () => {
    const deleted = new Set<string>();
    const exec: OpExecutor = async (c) => {
      if (c.sys_id === "parent" && !deleted.has("child")) {
        return { ok: false, error: "still referenced by child" };
      }
      deleted.add(c.sys_id);
      return { ok: true };
    };
    const out = await runMultiPassOps(
      [rec("parent", "delete"), rec("child", "delete")],
      exec,
    );
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it("resolves CREATE ordering: child succeeds only after parent exists", async () => {
    const created = new Set<string>();
    const exec: OpExecutor = async (c) => {
      if (c.sys_id === "child" && !created.has("parent")) {
        return { ok: false, error: "parent does not exist yet" };
      }
      created.add(c.sys_id);
      return { ok: true };
    };
    // child attempted first, fails, then succeeds on the pass after parent.
    const out = await runMultiPassOps(
      [rec("child", "create"), rec("parent", "create")],
      exec,
    );
    expect(out.every((o) => o.ok)).toBe(true);
    expect(created.has("child")).toBe(true);
  });

  it("reports a record that fails for a non-ordering reason", async () => {
    const exec: OpExecutor = async (c) =>
      c.sys_id === "locked"
        ? { ok: false, error: "ACL blocked" }
        : { ok: true };
    const out = await runMultiPassOps(
      [rec("ok", "delete"), rec("locked", "delete")],
      exec,
    );
    const failed = out.filter((o) => !o.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].change.sys_id).toBe("locked");
    expect(failed[0].error).toBe("ACL blocked");
  });

  it("treats a thrown executor error as a failure", async () => {
    const exec: OpExecutor = async () => {
      throw new Error("network down");
    };
    const out = await runMultiPassOps([rec("a", "create")], exec);
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toBe("network down");
  });

  it("returns [] for no changes", async () => {
    const out = await runMultiPassOps([], async () => ({ ok: true }));
    expect(out).toEqual([]);
  });
});
