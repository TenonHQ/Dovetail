import { promises as fsp } from "fs";
import path from "path";
import {
  NormalizedField,
  NormalizedSchema,
  NormalizedTable,
  SchemaIndex,
  SnapshotInfo,
  SnapshotManifest,
} from "./types";

export const SNAPSHOTS_DIRNAME = ".snapshots";

// Files written into a schema tree that are not per-table schema documents.
const NON_TABLE_FILES = new Set(["index.json", "_summary.json", "snapshot.json"]);

// Coerce a value that may be a plain string OR a legacy {link,value} object
// (the shape the 2025 baseline stored) down to its string value.
function coerceValue(raw: any): string {
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "object" && "value" in raw) {
    return raw.value === null || raw.value === undefined ? "" : String(raw.value);
  }
  return String(raw);
}

function coerceMandatory(raw: any): boolean {
  return raw === true || raw === "true";
}

// Normalize a single raw field document into the comparable shape. Drops
// `inherited_from` (hierarchy-derived, recomputed each pull) entirely.
export function normalizeField(raw: any): NormalizedField {
  return {
    name: coerceValue(raw.name),
    label: coerceValue(raw.label),
    type: coerceValue(raw.type),
    max_length: coerceValue(raw.max_length),
    mandatory: coerceMandatory(raw.mandatory),
    reference: coerceValue(raw.reference),
    default_value: coerceValue(raw.default_value),
  };
}

function sanitizeTimestamp(iso: string): string {
  // Filesystem-safe: 2026-05-29T16:30:00.123Z -> 2026-05-29T16-30-00-123Z
  return iso.replace(/:/g, "-").replace(/\./g, "-");
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(p);
    return stat.isDirectory();
  } catch (e) {
    return false;
  }
}

async function readJson(filePath: string): Promise<any> {
  const text = await fsp.readFile(filePath, "utf8");
  return JSON.parse(text);
}

// Decide whether a table belongs to a scope. The 2025 baseline omits the
// `scope` field, so fall back to the table-name prefix (x_cadso_journey_*).
function tableMatchesScope(options: {
  tableName: string;
  scope: string | null;
  scopeField: string;
}): boolean {
  const { tableName, scope, scopeField } = options;
  if (!scope) {
    return true;
  }
  if (scopeField && scopeField === scope) {
    return true;
  }
  return tableName.indexOf(scope + "_") === 0;
}

// Read a schema tree (the per-app <table>.json files + index.json) from a
// directory and return a normalized, scope-filtered map for diffing.
export async function readSchemaTree(options: {
  dir: string;
  scope?: string | null;
}): Promise<NormalizedSchema> {
  const { dir } = options;
  const scope = options.scope || null;

  let instance = "";
  let generatedAt: string | null = null;
  const indexPath = path.join(dir, "index.json");
  if (await isDirectory(dir)) {
    try {
      const index: SchemaIndex = await readJson(indexPath);
      instance = index.instance || "";
      generatedAt = index.generated_at || null;
    } catch (e) {
      // index.json is optional — a directory of table files still diffs.
    }
  } else {
    throw new Error("Schema directory not found: " + dir);
  }

  const tables: { [tableName: string]: NormalizedTable } = {};
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === SNAPSHOTS_DIRNAME) {
      continue;
    }
    const appDir = path.join(dir, entry.name);
    const files = await fsp.readdir(appDir);
    for (const file of files) {
      if (!file.endsWith(".json") || NON_TABLE_FILES.has(file)) {
        continue;
      }
      const doc = await readJson(path.join(appDir, file));
      const tableName = coerceValue(doc.table_name) || file.replace(/\.json$/, "");
      const scopeField = coerceValue(doc.scope);
      if (!tableMatchesScope({ tableName, scope, scopeField })) {
        continue;
      }
      const rawFields = Array.isArray(doc.fields) ? doc.fields : [];
      tables[tableName] = {
        table_name: tableName,
        label: coerceValue(doc.label),
        scope: scopeField,
        fields: rawFields.map(normalizeField),
      };
    }
  }

  return { instance, generated_at: generatedAt, tables };
}

// Persist an immutable copy of a freshly-pulled schema tree under
// <outputDir>/.snapshots/<instance>/<ISO[__label]>/.
export async function writeSnapshot(options: {
  outputDir: string;
  index: SchemaIndex;
  label?: string | null;
  now: string;
}): Promise<SnapshotInfo> {
  const { outputDir, index, now } = options;
  const label = options.label || null;
  const instance = index.instance;

  const dirName = sanitizeTimestamp(now) + (label ? "__" + label : "");
  const snapshotDir = path.join(outputDir, SNAPSHOTS_DIRNAME, instance, dirName);

  if (await isDirectory(snapshotDir)) {
    throw new Error(
      "Snapshot already exists (snapshots are immutable): " + snapshotDir
    );
  }

  await fsp.mkdir(snapshotDir, { recursive: true });

  // Copy only the app directories named in the index, plus index.json — never
  // the .snapshots dir itself or unrelated files in outputDir.
  for (const app of index.applications) {
    const srcApp = path.join(outputDir, app.name);
    const destApp = path.join(snapshotDir, app.name);
    if (await isDirectory(srcApp)) {
      await fsp.cp(srcApp, destApp, { recursive: true });
    }
  }
  const srcIndex = path.join(outputDir, "index.json");
  try {
    await fsp.copyFile(srcIndex, path.join(snapshotDir, "index.json"));
  } catch (e) {
    // index.json absent — non-fatal.
  }

  const manifest: SnapshotManifest = {
    instance,
    label,
    created_at: now,
    scopes: index.scopes,
    total_tables: index.total_tables,
  };
  await fsp.writeFile(
    path.join(snapshotDir, "snapshot.json"),
    JSON.stringify(manifest, null, 2)
  );

  return { ...manifest, dir: snapshotDir };
}

// List stored snapshots, newest first, optionally filtered to one instance.
export async function listSnapshots(options: {
  outputDir: string;
  instance?: string | null;
}): Promise<SnapshotInfo[]> {
  const { outputDir } = options;
  const instanceFilter = options.instance || null;
  const root = path.join(outputDir, SNAPSHOTS_DIRNAME);

  if (!(await isDirectory(root))) {
    return [];
  }

  const results: SnapshotInfo[] = [];
  const instances = await fsp.readdir(root, { withFileTypes: true });
  for (const inst of instances) {
    if (!inst.isDirectory()) {
      continue;
    }
    if (instanceFilter && inst.name !== instanceFilter) {
      continue;
    }
    const instDir = path.join(root, inst.name);
    const snaps = await fsp.readdir(instDir, { withFileTypes: true });
    for (const snap of snaps) {
      if (!snap.isDirectory()) {
        continue;
      }
      const snapDir = path.join(instDir, snap.name);
      try {
        const manifest: SnapshotManifest = await readJson(
          path.join(snapDir, "snapshot.json")
        );
        results.push({ ...manifest, dir: snapDir });
      } catch (e) {
        // Directory without a manifest — skip.
      }
    }
  }

  results.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return results;
}

// Resolve a snapshot ref (a label, an ISO/dir name, or a filesystem path) to a
// directory. `live` is handled by the caller (it requires a fresh pull).
export async function resolveSnapshotDir(options: {
  ref: string;
  outputDir: string;
  instance: string;
}): Promise<string> {
  const { ref, outputDir, instance } = options;

  // An explicit directory path wins (covers --from ../../Tables).
  if (await isDirectory(ref)) {
    return path.resolve(ref);
  }

  const snapshots = await listSnapshots({ outputDir, instance });

  // Exact directory-name match, then label match, then prefix match.
  const exact = snapshots.find((s) => path.basename(s.dir) === ref);
  if (exact) {
    return exact.dir;
  }
  const byLabel = snapshots.find((s) => s.label === ref);
  if (byLabel) {
    return byLabel.dir;
  }
  const byPrefix = snapshots.find((s) => path.basename(s.dir).indexOf(ref) === 0);
  if (byPrefix) {
    return byPrefix.dir;
  }

  throw new Error(
    'Could not resolve schema ref "' +
      ref +
      '" for instance ' +
      instance +
      ". Use `dove schema snapshots` to list available snapshots, or pass a directory path."
  );
}
