// Pure, deterministic core for `dove knowledge-diff`. No fs, no network — unit-testable.
// Given a Dovetail release manifest (the publish feed) and a consumer repo's
// documented-state ledger + watch config, returns the release-events the
// consumer has not documented yet. knowledgeDiffCommand wraps this with I/O to
// stage pending events for the in-session /dovetail-features-sync skill.

export interface ReleaseEventCommit {
  sha?: string;
  subject: string;
  pr?: number;
}

export interface ReleaseEvent {
  event_id: string;
  package: string;
  version: string;
  prev_version: string | null;
  published_at?: string;
  semver_bump?: string;
  commits?: ReleaseEventCommit[];
  [key: string]: unknown;
}

export interface ReleaseManifest {
  events: ReleaseEvent[];
}

export interface LedgerEntry {
  documented_version: string;
  documented_at?: string;
  last_event_id?: string | null;
}

export interface DocLedger {
  packages: { [pkg: string]: LedgerEntry };
}

export interface KnowledgeConfig {
  watch_packages?: string[];
  ignore_packages?: string[];
}

// Numeric semver compare for the x.y.z range Dovetail uses (no prerelease tags).
export function semverGt(a: string, b: string): boolean {
  const pa = String(a)
    .split(".")
    .map(function (n) {
      return parseInt(n, 10) || 0;
    });
  const pb = String(b)
    .split(".")
    .map(function (n) {
      return parseInt(n, 10) || 0;
    });
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

// Filesystem-safe pending filename: unscoped package name + version.
export function eventFilename(ev: ReleaseEvent): string {
  const unscoped = String(ev.package || "").replace(/^@[^/]+\//, "");
  return unscoped + "@" + ev.version + ".json";
}

// Events newer than the ledger's documented_version, limited to watch_packages
// (when set) and excluding ignore_packages. Deterministically sorted so callers
// and tests get a stable order.
export function computeDrift(
  manifest: ReleaseManifest,
  ledger: DocLedger,
  config: KnowledgeConfig,
): ReleaseEvent[] {
  const events = (manifest && manifest.events) || [];
  const watch = (config && config.watch_packages) || [];
  const ignore = (config && config.ignore_packages) || [];
  const ledgerPackages = (ledger && ledger.packages) || {};

  const drift: ReleaseEvent[] = [];
  for (const ev of events) {
    if (!ev || !ev.package || !ev.version) continue;
    if (ignore.indexOf(ev.package) !== -1) continue;
    if (watch.length > 0 && watch.indexOf(ev.package) === -1) continue;
    const entry = ledgerPackages[ev.package];
    const documented = entry && entry.documented_version;
    if (documented && !semverGt(ev.version, documented)) continue;
    drift.push(ev);
  }
  drift.sort(function (a, b) {
    return (a.package + a.version).localeCompare(b.package + b.version);
  });
  return drift;
}
