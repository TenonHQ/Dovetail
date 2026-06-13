// Domain types for `dove reconcile` — the deliberate inverse of `dove watch`:
// make a developer's personal ServiceNow instance match the git branch they
// just checked out. Phase 1 is read-only (diff + report); these types are
// shared by the apply phases (2 + 3) as they land.

/**
 * A single record's reconcilable state, normalized identically for the branch
 * (on-disk) side and the live (instance) side so the two can be compared by
 * value. Build one of these per tracked record on each side.
 */
export interface ReconcileRecord {
  table: string;
  scope: string;
  sys_id: string;
  /** Display name (folder name on disk); used for human-readable report rows. */
  name: string;
  /**
   * `sys_updated_on` as ServiceNow reports it ("2026-06-13 19:01:51"). Used for
   * the baseline dirty-check, never for content equality. Empty when unknown.
   */
  updatedOn: string;
  /**
   * Content-bearing fields keyed by "<field>.<type>" (e.g. "script.js"). The
   * bookkeeping `metaData.json` is excluded by the loader (see fields.ts), so a
   * field-for-field comparison reflects genuine record changes only.
   */
  fields: Record<string, string>;
}

export type RecordChangeKind = "create" | "update" | "delete";

/**
 * For a record present on the live instance but absent from the branch, the
 * baseline disambiguates intent (an instance-only record could mean the branch
 * deleted it OR the dev created it locally):
 *   - "tracked"     the sys_id was in the baseline -> the branch deleted it ->
 *                   reconcile would DELETE it on the instance (safe).
 *   - "local-new"   the sys_id was NOT in the baseline -> the dev created it
 *                   locally -> it is drift, NOT a branch delete -> reconcile
 *                   must NOT delete it; Phase 2 blocks (refuse-if-dirty).
 *   - "no-baseline" no baseline exists yet -> intent is unknowable -> treated
 *                   conservatively as drift (never proposed for deletion).
 */
export type DeleteDisposition = "tracked" | "local-new" | "no-baseline";

export interface FieldDelta {
  /** "<field>.<type>", e.g. "script.js". */
  field: string;
  onBranch: boolean;
  onLive: boolean;
  /** Both sides present and the content differs. */
  changed: boolean;
}

export interface RecordChange {
  kind: RecordChangeKind;
  table: string;
  scope: string;
  sys_id: string;
  name: string;
  /** Populated for updates; empty for create/delete. */
  fieldDeltas: FieldDelta[];
  /** Set only on deletes. */
  deleteDisposition?: DeleteDisposition;
}

export interface RecordDiff {
  creates: RecordChange[];
  updates: RecordChange[];
  deletes: RecordChange[];
  unchangedCount: number;
}

/**
 * The dev's own uncommitted instance work, detected relative to the baseline.
 * Phase 1 reports it; Phase 2 refuses to apply while any exists (unless
 * `--force`). The git analogy: a dirty working tree blocks `git checkout`.
 */
export interface DirtyRecord {
  sys_id: string;
  table: string;
  name: string;
  reason: "changed-since-baseline";
}
