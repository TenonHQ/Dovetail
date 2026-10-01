// The reconcile baseline — the "merge-base / index" in the git analogy. It
// records the {sys_id -> sys_updated_on} the instance was known to hold at the
// last reconcile (or refresh), namespaced by instance host. It MUST live
// outside the git tree: after a `git checkout`, the on-disk
// `metaData.sys_updated_on` is whatever the *committer's* instance held, not
// this developer's instance state, so the branch files cannot answer "did the
// dev change the instance since we last synced?". The baseline can.
//
// Phase 1 only READS the baseline (to disambiguate deletes and surface drift).
// `writeBaseline` / `baselineFromLive` are the apply-phase write path and the
// pure dirty-check is shared by both.

import fs from "fs";
import path from "path";
import { DirtyRecord, ReconcileRecord } from "./types";

export const BASELINE_FILENAME = ".dove-reconcile-baseline.json";

export interface ReconcileBaseline {
  version: 1;
  /** Instance host the baseline was captured against (normalized, no scheme). */
  instance: string;
  /** sys_id -> sys_updated_on at baseline time. */
  records: Record<string, string>;
}

export function baselinePath(rootDir: string): string {
  return path.join(rootDir, BASELINE_FILENAME);
}

function isStringRecordMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (typeof (value as Record<string, unknown>)[key] !== "string") {
      return false;
    }
  }
  return true;
}

/**
 * Read the baseline for `instance`. Returns null when the file is absent,
 * unparseable, malformed, or was captured against a different instance (a
 * mismatched baseline is useless and must not silently disambiguate the wrong
 * instance's records). All failure modes degrade to "no baseline", never throw.
 */
export function readBaseline(
  rootDir: string,
  instance: string,
): ReconcileBaseline | null {
  const filePath = baselinePath(rootDir);
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<ReconcileBaseline>;
  if (candidate.version !== 1 || !isStringRecordMap(candidate.records)) {
    return null;
  }
  if (instance && candidate.instance && candidate.instance !== instance) {
    return null;
  }
  return {
    version: 1,
    instance: candidate.instance || instance,
    records: candidate.records,
  };
}

export function writeBaseline(
  rootDir: string,
  baseline: ReconcileBaseline,
): void {
  fs.writeFileSync(
    baselinePath(rootDir),
    JSON.stringify(baseline, null, 2) + "\n",
    "utf8",
  );
}

/** Build a fresh baseline snapshot from the current live record set. */
export function baselineFromLive(
  instance: string,
  live: ReconcileRecord[],
): ReconcileBaseline {
  const records: Record<string, string> = {};
  for (const record of live) {
    records[record.sys_id] = record.updatedOn || "";
  }
  return { version: 1, instance, records };
}

export function baselineSysIds(
  baseline: ReconcileBaseline | null,
): Set<string> | null {
  if (!baseline) {
    return null;
  }
  return new Set(Object.keys(baseline.records));
}

/**
 * The dev's own uncommitted instance work: records present in the baseline
 * whose live `sys_updated_on` has moved since. This is the refuse-if-dirty
 * signal — Phase 1 reports it, Phase 2 blocks apply on it (unless `--force`).
 * Pure. With no baseline there is nothing to compare against, so it returns [].
 */
export function computeDirty(options: {
  baseline: ReconcileBaseline | null;
  live: ReconcileRecord[];
}): DirtyRecord[] {
  const { baseline, live } = options;
  if (!baseline) {
    return [];
  }
  const dirty: DirtyRecord[] = [];
  for (const record of live) {
    const baselineStamp = baseline.records[record.sys_id];
    if (
      baselineStamp !== undefined &&
      baselineStamp !== "" &&
      record.updatedOn !== "" &&
      record.updatedOn !== baselineStamp
    ) {
      dirty.push({
        sys_id: record.sys_id,
        table: record.table,
        name: record.name,
        reason: "changed-since-baseline",
      });
    }
  }
  return dirty;
}
