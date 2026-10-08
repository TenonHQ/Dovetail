/**
 * Per-record pull: mirror ONE (or a handful of) ServiceNow records into the
 * repo without a scope-wide refresh.
 *
 * `dove refresh` is a whole-scope operation: it rewrites the scope manifest in
 * full and re-downloads every record in every whitelisted table. Mirroring a
 * handful of records captured on the instance (a Now Assist skill is ~50 records
 * across 17 tables) therefore meant a scoped refresh on a feature branch plus a
 * dozen manual restore-and-splice steps. This module is the narrow alternative:
 *
 *   - resolves each record's owning scope from the instance (`sys_scope`) and
 *     REFUSES a record outside the target scope before anything is written;
 *   - reuses the two read-only sync endpoints refresh already uses (`getManifest`
 *     for the record's file list + folder name, `bulkDownload` for content), so
 *     the folder, file names, and manifest entry are byte-for-byte what a full
 *     refresh would produce for that record;
 *   - writes ONLY that record's folder and splices ONLY that record's manifest
 *     entry, leaving every other manifest entry byte-identical;
 *   - works for a table the server-side manifest skips (no script/html column
 *     and no field override): it still writes the record's `metaData.json`.
 *
 * Two phases, like every other Dovetail write: `planPull` is read-only against
 * the instance and the disk, `applyPull` performs the writes from the plan.
 */

import { SN, Sinc } from "@tenonhq/dovetail-types";
import path from "path";
import { promises as fsp } from "fs";
import * as ConfigManager from "./config";
import * as fUtils from "./FileUtils";
import {
  defaultClient,
  RecordScopeReadRecord,
  SNClient,
  SNReferenceValue,
  unwrapSNResponse,
  UpdateXmlReadRecord,
} from "./snClient";
import {
  emptyMetadataFile,
  normalizeManifestKeys,
  stampMetadataContent,
  toSafeFolderName,
} from "./appUtils";
import { fileLogger } from "./FileLogger";

export const SYS_ID_RE = /^[0-9a-f]{32}$/;
// ServiceNow table names: lowercase, digits, underscores, never leading digit.
export const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;
// sys_update_xml.name for a per-record capture is `<table>_<sys_id>`.
const UPDATE_XML_NAME_RE = /^([a-z][a-z0-9_]*)_([0-9a-f]{32})$/;
const UPDATE_SET_PAGE_SIZE = 1000;

export interface PullTarget {
  table: string;
  sysId: string;
}

export interface PullOptions {
  /** Target scope. When set, every record must belong to it or the pull refuses. */
  scope?: string;
  /** Rewrite every file even when its content already matches the instance. */
  force?: boolean;
}

export type FileAction = "write" | "unchanged";
export type ManifestAction = "add" | "update" | "unchanged";

export interface PlannedFile {
  /** Absolute path the file will be written to. */
  path: string;
  file: SN.File;
  action: FileAction;
}

export interface PlannedRecord {
  table: string;
  sysId: string;
  scope: string;
  /** Manifest key == on-disk folder name. */
  key: string;
  /** An existing manifest key holding this sys_id under a different name. */
  previousKey?: string;
  recordDir: string;
  files: PlannedFile[];
  /** The manifest entry (name + type only, no content, no metaData). */
  manifestEntry: SN.MetaRecord;
  manifestAction: ManifestAction;
  /** Table is in the scope's `_tables` whitelist (a scope-wide refresh keeps it). */
  inWhitelist: boolean;
  /** Record was listed by the server-side scope manifest (vs. metaData-only fallback). */
  inServerManifest: boolean;
  warnings: string[];
}

export interface PlannedManifest {
  scope: string;
  manifestPath: string;
  /** False when the on-disk manifest does not round-trip through Dovetail's writer. */
  formatPreserved: boolean;
  /** The file existed on disk before this pull. */
  existed: boolean;
  records: PlannedRecord[];
}

export interface PullPlan {
  records: PlannedRecord[];
  manifests: PlannedManifest[];
  warnings: string[];
}

export interface PullClient {
  getRecordScope: SNClient["getRecordScope"];
  getManifest: SNClient["getManifest"];
  getMissingFiles: SNClient["getMissingFiles"];
  getUpdateSetMembers: SNClient["getUpdateSetMembers"];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Normalize the sys_id inputs (positional list + `--sys-ids` flag) into one
 * validated, de-duplicated list. Throws on the first malformed value — a typo
 * must not turn into a 404 against the instance halfway through a batch.
 */
export function normalizeSysIds(raw: ReadonlyArray<string | undefined> | string | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const part of parts) {
    if (part === undefined || part === null) continue;
    for (const piece of String(part).split(",")) {
      const id = piece.trim().toLowerCase();
      if (id === "") continue;
      if (!SYS_ID_RE.test(id)) {
        throw new Error("'" + piece.trim() + "' is not a sys_id (expected 32 hex characters).");
      }
      if (out.indexOf(id) === -1) out.push(id);
    }
  }
  return out;
}

export function assertTableName(table: string): string {
  const name = String(table || "").trim();
  if (!TABLE_NAME_RE.test(name)) {
    throw new Error(
      "'" + table + "' is not a ServiceNow table name (lowercase letters, digits and underscores).",
    );
  }
  return name;
}

/**
 * Parse a `sys_update_xml.name` into a pull target. Only per-record captures
 * are named `<table>_<sys_id>`; schema captures (`sys_dictionary_<table>_<field>`,
 * `sys_db_object_<table>`, choice sets, …) are not and return undefined.
 */
export function parseUpdateXmlName(name: string): PullTarget | undefined {
  const m = UPDATE_XML_NAME_RE.exec(String(name || "").trim());
  if (!m) return undefined;
  return { table: m[1], sysId: m[2] };
}

export function dedupeTargets(targets: ReadonlyArray<PullTarget>): PullTarget[] {
  const seen: Record<string, boolean> = {};
  const out: PullTarget[] = [];
  for (const t of targets) {
    const k = t.table + "/" + t.sysId;
    if (seen[k]) continue;
    seen[k] = true;
    out.push({ table: t.table, sysId: t.sysId });
  }
  return out;
}

/** Strip content so an entry carries exactly what a refresh-written manifest does. */
export function toManifestFiles(files: ReadonlyArray<SN.File>): SN.File[] {
  const out: SN.File[] = [];
  for (const f of files) {
    if (f.name === "metaData" && f.type === "json") continue;
    out.push({ name: f.name, type: f.type });
  }
  return out;
}

export function findRecordBySysId(
  tables: SN.TableMap | undefined,
  table: string,
  sysId: string,
): { key: string; record: SN.MetaRecord } | undefined {
  if (!tables) return undefined;
  const tableEntry = tables[table];
  if (!tableEntry || !tableEntry.records) return undefined;
  const keys = Object.keys(tableEntry.records);
  for (const key of keys) {
    const rec = tableEntry.records[key];
    if (rec && rec.sys_id === sysId) return { key, record: rec };
  }
  return undefined;
}

function sameEntry(a: SN.MetaRecord | undefined, b: SN.MetaRecord): boolean {
  if (!a) return false;
  return JSON.stringify(entryShape(a)) === JSON.stringify(entryShape(b));
}

function entryShape(e: SN.MetaRecord): SN.MetaRecord {
  return { files: toManifestFiles(e.files || []), name: e.name, sys_id: e.sys_id };
}

/**
 * Splice ONE record entry into a scope manifest. Returns a NEW manifest; the
 * input is never mutated. Every other table and record entry is carried over
 * untouched and in its original order, so re-serializing changes exactly one
 * key. A stale key holding the same sys_id (record renamed on the instance) is
 * removed, since the manifest key must equal the folder name push looks up.
 */
export function spliceManifestRecord(
  manifest: SN.AppManifest | undefined,
  scope: string,
  table: string,
  entry: SN.MetaRecord,
  previousKey?: string,
): SN.AppManifest {
  const base: SN.AppManifest = manifest
    ? { tables: manifest.tables || {}, scope: manifest.scope || scope }
    : { tables: {}, scope };
  const tables: SN.TableMap = {};
  const tableNames = Object.keys(base.tables);
  let placed = false;
  for (const name of tableNames) {
    if (name !== table) {
      tables[name] = base.tables[name];
      continue;
    }
    const records: SN.TableConfigRecords = {};
    const existing = base.tables[name].records || {};
    for (const key of Object.keys(existing)) {
      if (previousKey !== undefined && key === previousKey && key !== entry.name) continue;
      if (key === entry.name) {
        records[key] = entryShape(entry);
        placed = true;
        continue;
      }
      records[key] = existing[key];
    }
    if (!placed) {
      records[entry.name] = entryShape(entry);
      placed = true;
    }
    tables[name] = Object.assign({}, base.tables[name], { records });
  }
  if (!placed) {
    tables[table] = { records: { [entry.name]: entryShape(entry) } };
  }
  // Preserve the original top-level key order (tables first, then scope) —
  // that is what refresh writes, so the diff stays one entry.
  const out: SN.AppManifest = { tables, scope: base.scope };
  return out;
}

export interface ManifestText {
  manifest: SN.AppManifest | undefined;
  /** JSON.stringify(parsed, null, 2) reproduces the file (modulo one trailing newline). */
  formatPreserved: boolean;
  trailingNewline: boolean;
  existed: boolean;
}

export function parseManifestText(text: string | undefined): ManifestText {
  if (text === undefined) {
    return { manifest: undefined, formatPreserved: true, trailingNewline: false, existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("Scope manifest is not valid JSON: " + (e instanceof Error ? e.message : String(e)));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Scope manifest is not a JSON object.");
  }
  const manifest = parsed as SN.AppManifest;
  const trailingNewline = text.endsWith("\n");
  const reserialized = JSON.stringify(manifest, null, 2);
  const body = trailingNewline ? text.slice(0, -1) : text;
  return {
    manifest,
    formatPreserved: reserialized === body,
    trailingNewline,
    existed: true,
  };
}

export function serializeManifest(manifest: SN.AppManifest, trailingNewline: boolean): string {
  return JSON.stringify(manifest, null, 2) + (trailingNewline ? "\n" : "");
}

function scopeNameOf(rec: RecordScopeReadRecord): string {
  const dotWalked = rec["sys_scope.scope"];
  if (typeof dotWalked === "string" && dotWalked.trim() !== "") return dotWalked.trim();
  return "";
}

function scopeSysIdOf(rec: RecordScopeReadRecord): string {
  const ref = rec.sys_scope;
  if (typeof ref === "string") return ref;
  if (ref && typeof (ref as SNReferenceValue).value === "string") return (ref as SNReferenceValue).value;
  return "";
}

function httpStatusOf(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const resp = (e as { response?: { status?: unknown } }).response;
  if (resp && typeof resp.status === "number") return resp.status;
  return undefined;
}

// ---------------------------------------------------------------------------
// Instance reads
// ---------------------------------------------------------------------------

/**
 * Expand `--from-update-set <sys_id>` into per-record targets: every
 * INSERT_OR_UPDATE capture named `<table>_<sys_id>`. Captures that are not
 * per-record (schema, choice sets, deletes) are reported in `skipped`.
 */
export async function targetsFromUpdateSet(
  updateSetSysId: string,
  client: PullClient = defaultClient(),
): Promise<{ targets: PullTarget[]; skipped: string[] }> {
  const id = String(updateSetSysId || "").trim().toLowerCase();
  if (!SYS_ID_RE.test(id)) {
    throw new Error("--from-update-set: '" + updateSetSysId + "' is not a sys_id (expected 32 hex characters).");
  }
  const targets: PullTarget[] = [];
  const skipped: string[] = [];
  let offset = 0;
  let total = 0;
  for (;;) {
    const page: UpdateXmlReadRecord[] = await unwrapSNResponse(
      client.getUpdateSetMembers(id, offset, UPDATE_SET_PAGE_SIZE),
    );
    if (!Array.isArray(page) || page.length === 0) break;
    total += page.length;
    for (const row of page) {
      const action = String(row.action || "").toUpperCase();
      if (action === "DELETE") {
        skipped.push(row.name + " (DELETE)");
        continue;
      }
      const target = parseUpdateXmlName(row.name);
      if (!target) {
        skipped.push(row.name + " (not a per-record capture)");
        continue;
      }
      targets.push(target);
    }
    if (page.length < UPDATE_SET_PAGE_SIZE) break;
    offset += UPDATE_SET_PAGE_SIZE;
  }
  fileLogger.debug(
    "pull: update set " + id + " holds " + total + " captures → " + targets.length +
    " per-record targets, " + skipped.length + " skipped",
  );
  if (total === 0) {
    throw new Error(
      "--from-update-set: no customer updates found for update set " + id +
      " (wrong sys_id, empty set, or no read access to sys_update_xml).",
    );
  }
  return { targets: dedupeTargets(targets), skipped };
}

interface ResolvedTarget extends PullTarget {
  scope: string;
  scopeSysId: string;
}

async function resolveTargetScope(
  target: PullTarget,
  options: PullOptions,
  client: PullClient,
): Promise<ResolvedTarget> {
  const label = target.table + " " + target.sysId;
  let rec: RecordScopeReadRecord;
  try {
    rec = await unwrapSNResponse(client.getRecordScope(target.table, target.sysId));
  } catch (e) {
    const status = httpStatusOf(e);
    if (status === 404) {
      throw new Error(label + ": not found on the instance (no such record, or no read access).");
    }
    if (status === 400) {
      throw new Error(
        label + ": the instance rejected the read (status 400) — does table '" +
        target.table + "' exist?",
      );
    }
    throw e;
  }
  if (!rec || typeof rec !== "object" || rec.sys_id !== target.sysId) {
    throw new Error(label + ": the instance returned an unexpected record (sys_id mismatch).");
  }
  const actualClass = typeof rec.sys_class_name === "string" ? rec.sys_class_name.trim() : "";
  if (actualClass !== "" && actualClass !== target.table) {
    throw new Error(
      label + ": the record's class is '" + actualClass + "', not '" + target.table +
      "'. Dovetail mirrors a record under its own class — re-run with '" + actualClass + "'.",
    );
  }
  let scope = scopeNameOf(rec);
  if (scope === "") {
    if (!options.scope) {
      throw new Error(
        label + ": the record carries no sys_scope, so its scope cannot be resolved. " +
        "Pass --scope <scope> to place it explicitly.",
      );
    }
    scope = options.scope;
  }
  if (options.scope && scope !== options.scope) {
    throw new Error(
      label + ": belongs to scope '" + scope + "', not the requested '" + options.scope +
      "'. Nothing was written.",
    );
  }
  return { table: target.table, sysId: target.sysId, scope, scopeSysId: scopeSysIdOf(rec) };
}

/** Files a scope's config says this table syncs, when the server manifest has nothing for it. */
function filesFromFieldOverrides(scope: string, table: string): SN.File[] {
  let overrides: Sinc.TablePropMap = {};
  try {
    overrides = ConfigManager.resolveConfigForScope(scope).fieldOverrides || {};
  } catch (e) {
    return [];
  }
  const tableOverride = overrides[table];
  if (!tableOverride || typeof tableOverride !== "object" || Array.isArray(tableOverride)) return [];
  const out: SN.File[] = [];
  const fieldMap = tableOverride as Sinc.FieldMap;
  for (const fieldName of Object.keys(fieldMap)) {
    const cfg = fieldMap[fieldName];
    const type: SN.FileType = cfg && cfg.type ? cfg.type : "txt";
    out.push({ name: fieldName, type });
  }
  return out;
}

function tableIsWhitelisted(scope: string, table: string): boolean {
  try {
    const tables = ConfigManager.resolveConfigForScope(scope).tables || [];
    return tables.indexOf(table) !== -1;
  } catch (e) {
    return false;
  }
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch (e) {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Plan (read-only)
// ---------------------------------------------------------------------------

/**
 * Build the pull plan: resolve scopes (refusing any mismatch before a single
 * byte is fetched for content), look each record up in its scope's server-side
 * manifest, download its content, and diff against disk + the local manifest.
 * Touches nothing on disk.
 */
export async function planPull(
  rawTargets: ReadonlyArray<PullTarget>,
  options: PullOptions = {},
  client: PullClient = defaultClient(),
): Promise<PullPlan> {
  const warnings: string[] = [];
  const targets = dedupeTargets(
    rawTargets.map((t) => {
      const ids = normalizeSysIds(t.sysId);
      if (ids.length !== 1) throw new Error("'" + t.table + "': a sys_id is required.");
      return { table: assertTableName(t.table), sysId: ids[0] };
    }),
  );
  if (targets.length === 0) throw new Error("Nothing to pull: no table + sys_id given.");

  const config = ConfigManager.getConfig();
  const declaredScopes = (config.scopes && Object.keys(config.scopes)) || [];
  if (options.scope && declaredScopes.length > 0 && declaredScopes.indexOf(options.scope) === -1) {
    throw new Error(
      "--scope '" + options.scope + "' is not declared in dove.config.js `scopes` (" +
      declaredScopes.join(", ") + ").",
    );
  }

  // 1. Resolve every record's scope FIRST. Any mismatch aborts the whole pull
  //    before content is fetched, so a bad batch writes nothing.
  const resolved: ResolvedTarget[] = [];
  const failures: string[] = [];
  for (const t of targets) {
    try {
      resolved.push(await resolveTargetScope(t, options, client));
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  for (const r of resolved) {
    if (declaredScopes.length > 0 && declaredScopes.indexOf(r.scope) === -1) {
      failures.push(
        r.table + " " + r.sysId + ": belongs to scope '" + r.scope +
        "', which is not declared in dove.config.js `scopes`. Nothing was written.",
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      (failures.length === 1 ? "Refusing to pull:\n  " : "Refusing to pull (" + failures.length + " problems):\n  ") +
      failures.join("\n  "),
    );
  }

  // 2. One server-manifest read per scope (structure only, no content). This is
  //    what gives the record the SAME folder name and file list a full refresh
  //    would — including the duplicate-name suffix only the full set can know.
  const scopes: string[] = [];
  for (const r of resolved) if (scopes.indexOf(r.scope) === -1) scopes.push(r.scope);
  const serverManifests: Record<string, SN.AppManifest> = {};
  for (const scope of scopes) {
    fileLogger.debug("pull: reading server manifest for scope " + scope);
    serverManifests[scope] = normalizeManifestKeys(
      await unwrapSNResponse(client.getManifest(scope, config)),
    );
  }

  // 3. Decide each record's file list, then ONE bulkDownload for all of them.
  interface Pending extends ResolvedTarget {
    serverKey?: string;
    requestFiles: SN.File[];
  }
  const pending: Pending[] = resolved.map((r) => {
    const hit = findRecordBySysId(serverManifests[r.scope].tables, r.table, r.sysId);
    const requestFiles = hit ? toManifestFiles(hit.record.files) : filesFromFieldOverrides(r.scope, r.table);
    return Object.assign({}, r, { serverKey: hit ? hit.key : undefined, requestFiles });
  });

  const missing: SN.MissingFileTableMap = {};
  for (const p of pending) {
    if (!missing[p.table]) missing[p.table] = {};
    missing[p.table][p.sysId] = p.requestFiles.map((f) => ({ name: f.name, type: f.type }));
  }
  const downloaded = await unwrapSNResponse(client.getMissingFiles(missing, config.tableOptions || {}));

  // 4. Diff against disk + local manifests.
  const manifestTexts: Record<string, ManifestText> = {};
  const manifestsByScope: Record<string, PlannedManifest> = {};
  const records: PlannedRecord[] = [];
  const forceWrite = !!options.force;

  for (const p of pending) {
    const label = p.table + " " + p.sysId;
    const dl = findRecordBySysId(downloaded, p.table, p.sysId);
    if (!dl) {
      throw new Error(label + ": the instance returned no content for this record (bulkDownload).");
    }
    const recWarnings: string[] = [];
    const key = p.serverKey !== undefined
      ? p.serverKey
      : toSafeFolderName({ name: dl.record.name, sys_id: p.sysId, files: [] });

    if (!manifestTexts[p.scope]) {
      const manifestPath = ConfigManager.getScopeManifestPath(p.scope);
      manifestTexts[p.scope] = parseManifestText(await readIfExists(manifestPath));
      manifestsByScope[p.scope] = {
        scope: p.scope,
        manifestPath,
        formatPreserved: manifestTexts[p.scope].formatPreserved,
        existed: manifestTexts[p.scope].existed,
        records: [],
      };
    }
    const local = manifestTexts[p.scope].manifest;
    const existing = findRecordBySysId(local ? local.tables : undefined, p.table, p.sysId);
    const manifestEntry: SN.MetaRecord = { files: p.requestFiles.map((f) => ({ name: f.name, type: f.type })), name: key, sys_id: p.sysId };
    let manifestAction: ManifestAction = "add";
    let previousKey: string | undefined;
    if (existing) {
      if (existing.key !== key) previousKey = existing.key;
      manifestAction = existing.key === key && sameEntry(existing.record, manifestEntry) ? "unchanged" : "update";
    }

    const recordDir = path.join(ConfigManager.getSourcePathForScope(p.scope), p.table, key);
    if (previousKey !== undefined) {
      recWarnings.push(
        "renamed on the instance: manifest key '" + previousKey + "' → '" + key +
        "'. The old folder " + path.join(ConfigManager.getSourcePathForScope(p.scope), p.table, previousKey) +
        " is left in place — remove it by hand if it is now stale.",
      );
    }

    // Field files first, then metaData (stamped exactly as refresh stamps it).
    const files: PlannedFile[] = [];
    let serverMeta: SN.File | undefined;
    for (const f of dl.record.files || []) {
      if (f.name === "metaData" && f.type === "json") {
        serverMeta = f;
        continue;
      }
      files.push({ path: path.join(recordDir, f.name + "." + f.type), file: f, action: "write" });
    }
    const metaFile = serverMeta && serverMeta.content ? stampMetadataContent(serverMeta) : emptyMetadataFile();
    files.push({ path: path.join(recordDir, "metaData.json"), file: metaFile, action: "write" });
    for (const pf of files) {
      const current = await readIfExists(pf.path);
      const wanted = pf.file.content || "";
      pf.action = !forceWrite && current === wanted ? "unchanged" : "write";
    }

    const inWhitelist = tableIsWhitelisted(p.scope, p.table);
    if (!inWhitelist) {
      recWarnings.push(
        "table '" + p.table + "' is not in includes._tables for scope '" + p.scope +
        "'. The record is mirrored, but the next scope-wide 'dove refresh' will drop it from " +
        "the manifest and 'dove push' will skip it — add the table to dove.config.js to keep it.",
      );
    }
    if (p.serverKey === undefined) {
      recWarnings.push(
        (p.requestFiles.length === 0
          ? "no script/html column and no field override for '" + p.table + "' — metaData.json only. "
          : "") +
        "The server-side scope manifest does not list this record, so a scope-wide 'dove refresh' " +
        "will drop its manifest entry.",
      );
    }

    const planned: PlannedRecord = {
      table: p.table,
      sysId: p.sysId,
      scope: p.scope,
      key,
      previousKey,
      recordDir,
      files,
      manifestEntry,
      manifestAction,
      inWhitelist,
      inServerManifest: p.serverKey !== undefined,
      warnings: recWarnings,
    };
    records.push(planned);
    manifestsByScope[p.scope].records.push(planned);
  }

  const manifests: PlannedManifest[] = scopes.filter((s) => !!manifestsByScope[s]).map((s) => manifestsByScope[s]);
  for (const m of manifests) {
    if (m.existed && !m.formatPreserved) {
      warnings.push(
        m.manifestPath + " was not written by Dovetail's manifest writer (formatting differs), so " +
        "re-serializing it will touch more than this record's entry. Run 'dove refresh' once to " +
        "settle it, or review the diff carefully.",
      );
    }
  }
  return { records, manifests, warnings };
}

// ---------------------------------------------------------------------------
// Apply (writes)
// ---------------------------------------------------------------------------

export interface PullResult {
  filesWritten: number;
  filesUnchanged: number;
  manifestsWritten: string[];
}

/**
 * Perform the writes a plan describes: each record's folder + the files flagged
 * `write`, then ONE splice per scope manifest. Everything else on disk is left
 * exactly as it was.
 */
export async function applyPull(plan: PullPlan): Promise<PullResult> {
  let filesWritten = 0;
  let filesUnchanged = 0;
  const manifestsWritten: string[] = [];

  for (const rec of plan.records) {
    await fUtils.createDirRecursively(rec.recordDir);
    for (const pf of rec.files) {
      if (pf.action !== "write") {
        filesUnchanged++;
        continue;
      }
      await fUtils.writeFileForce(pf.path, pf.file.content || "");
      fileLogger.debug("pull: wrote " + pf.path);
      filesWritten++;
    }
  }

  for (const m of plan.manifests) {
    const touched = m.records.filter((r) => r.manifestAction !== "unchanged");
    if (touched.length === 0) continue;
    // Re-read at apply time: the plan's parse is for the diff, the splice must
    // start from whatever is on disk NOW.
    const text = parseManifestText(await readIfExists(m.manifestPath));
    let manifest: SN.AppManifest | undefined = text.manifest;
    for (const r of touched) {
      manifest = spliceManifestRecord(manifest, m.scope, r.table, r.manifestEntry, r.previousKey);
    }
    if (!manifest) continue;
    await fUtils.writeFileForce(m.manifestPath, serializeManifest(manifest, text.trailingNewline));
    fileLogger.debug("pull: spliced " + touched.length + " entr" + (touched.length === 1 ? "y" : "ies") + " into " + m.manifestPath);
    manifestsWritten.push(m.manifestPath);
  }

  return { filesWritten, filesUnchanged, manifestsWritten };
}
