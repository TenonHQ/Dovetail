// Tests for the reconcile baseline: defensive read (degrades to null, never
// throws), write round-trip, the pure dirty-check, and live-snapshot capture.

import fs from "fs";
import os from "os";
import path from "path";
import {
  BASELINE_FILENAME,
  baselineFromLive,
  baselineSysIds,
  computeDirty,
  readBaseline,
  writeBaseline,
} from "../reconcile/baseline";
import { ReconcileRecord } from "../reconcile/types";

const live = (sys_id: string, updatedOn: string): ReconcileRecord => ({
  table: "sys_script",
  scope: "x_cadso_core",
  name: sys_id,
  sys_id,
  updatedOn,
  fields: {},
});

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dove-reconcile-base-"));
}

describe("readBaseline — defensive", () => {
  it("returns null when the file is absent", () => {
    expect(readBaseline(tmpRoot(), "tenonworkstudio")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, BASELINE_FILENAME), "{not json");
    expect(readBaseline(root, "tenonworkstudio")).toBeNull();
  });

  it("returns null on wrong version or non-string record map", () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, BASELINE_FILENAME),
      JSON.stringify({ version: 2, instance: "x", records: {} }),
    );
    expect(readBaseline(root, "x")).toBeNull();

    const root2 = tmpRoot();
    fs.writeFileSync(
      path.join(root2, BASELINE_FILENAME),
      JSON.stringify({ version: 1, instance: "x", records: { a: 5 } }),
    );
    expect(readBaseline(root2, "x")).toBeNull();
  });

  it("returns null when the baseline was captured against another instance", () => {
    const root = tmpRoot();
    writeBaseline(root, {
      version: 1,
      instance: "tenonworkshop",
      records: { a: "t" },
    });
    expect(readBaseline(root, "tenonworkstudio")).toBeNull();
  });

  it("round-trips a valid baseline", () => {
    const root = tmpRoot();
    writeBaseline(root, {
      version: 1,
      instance: "tenonworkstudio",
      records: { a: "2026-06-01 00:00:00" },
    });
    const got = readBaseline(root, "tenonworkstudio");
    expect(got).not.toBeNull();
    expect(got!.records.a).toBe("2026-06-01 00:00:00");
  });
});

describe("baselineFromLive + baselineSysIds", () => {
  it("captures sys_id -> updatedOn from the live set", () => {
    const base = baselineFromLive("tenonworkstudio", [
      live("a", "t1"),
      live("b", "t2"),
    ]);
    expect(base.records).toEqual({ a: "t1", b: "t2" });
    expect(base.instance).toBe("tenonworkstudio");
  });

  it("baselineSysIds is null for a null baseline and a Set otherwise", () => {
    expect(baselineSysIds(null)).toBeNull();
    const set = baselineSysIds({
      version: 1,
      instance: "x",
      records: { a: "t" },
    });
    expect(set).not.toBeNull();
    expect(set!.has("a")).toBe(true);
  });
});

describe("computeDirty", () => {
  it("returns [] with no baseline", () => {
    expect(computeDirty({ baseline: null, live: [live("a", "t2")] })).toEqual(
      [],
    );
  });

  it("flags a baseline record whose live updatedOn moved", () => {
    const dirty = computeDirty({
      baseline: { version: 1, instance: "x", records: { a: "t1", b: "t1" } },
      live: [live("a", "t2"), live("b", "t1")],
    });
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toMatchObject({
      sys_id: "a",
      reason: "changed-since-baseline",
    });
  });

  it("does not flag records absent from the baseline (those are deletes/creates, not drift)", () => {
    const dirty = computeDirty({
      baseline: { version: 1, instance: "x", records: {} },
      live: [live("new", "t9")],
    });
    expect(dirty).toEqual([]);
  });

  it("ignores empty timestamps rather than false-flagging", () => {
    const dirty = computeDirty({
      baseline: { version: 1, instance: "x", records: { a: "" } },
      live: [live("a", "t2")],
    });
    expect(dirty).toEqual([]);
  });
});
