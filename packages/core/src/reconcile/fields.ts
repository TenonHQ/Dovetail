// Field-comparison rules for reconcile. A record's on-disk representation is a
// directory of per-field files plus a `metaData.json` snapshot. metaData is
// Dovetail bookkeeping — it carries a host-stripped `_record_link` and a full
// field dump including volatile audit columns (sys_updated_on, sys_mod_count) —
// so including it in a content comparison would make every record read as
// modified. Excluding it leaves the genuine, content-bearing field files
// (script.js, etc.), which is exactly what `dove refresh` writes verbatim from
// the instance. Comparing those raw is therefore consistent with the Phase 1
// acceptance test: "a reconcile dry-run matches a hand-diff of two refresh
// snapshots."

export interface ComparableFile {
  name: string;
  type: string;
}

/** Stable "<field>.<type>" key used on both the branch and live sides. */
export function fieldKey(file: ComparableFile): string {
  return file.name + "." + file.type;
}

/**
 * True when a record file is a content-bearing field that should participate in
 * the diff. Excludes the `metaData.json` bookkeeping file.
 */
export function isComparableField(file: ComparableFile): boolean {
  if (file.name === "metaData" && file.type === "json") {
    return false;
  }
  return true;
}
