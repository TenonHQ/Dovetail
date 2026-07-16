import { SN, Sinc } from "@tenonhq/dovetail-types";
import path from "path";
import fs from "fs";
import ProgressBar from "progress";
import * as fUtils from "./FileUtils";
import * as ConfigManager from "./config";
import {
  CONCURRENCY_TABLES,
  CONCURRENCY_RECORDS,
  CONCURRENCY_FILES,
  CONCURRENCY_PUSH,
  CONCURRENCY_BUILD,
} from "./constants";
import PluginManager from "./PluginManager";
import { fileLogger } from "./FileLogger";
import { readUpdateSetConfig, writeUpdateSetRouting } from "./updateSetConfig";
import {
  defaultClient,
  processPushResponse,
  retryOnErr,
  retryOnHttpErr,
  setBenchmarkSink,
  SNClient,
  unwrapSNResponse,
  unwrapTableAPIFirstItem,
} from "./snClient";
import { BenchmarkCollector } from "./benchmark";
import { logger } from "./Logger";
import { aggregateErrorMessages, allSettled, processBatched, allSettledBatched } from "./genericUtils";

interface UpdateSetSelection {
  sys_id: string;
  name: string;
}

type UpdateSetConfig = Record<string, UpdateSetSelection>;

// Delegate to the shared reader so the push hot-path and the
// createUpdateSet/switchUpdateSet writers stay on one parse contract.
const getUpdateSetConfig = (): UpdateSetConfig => readUpdateSetConfig();

// Strip the ServiceNow instance host from an absolute _record_link, leaving the
// instance-relative path. The CADSO metadata endpoint returns an absolute URL
// (https://<instance>.service-now.com/<table>.do?sys_id=...); persisting that
// makes the on-disk artifact instance-bound, so a re-pull from a different
// instance rewrites every metaData.json with the new host. The relative path
// (/<table>.do?sys_id=...) resolves against whatever instance the reader is on.
// Matches any *.service-now.com host so the output is portable across instances.
const stripRecordLinkHost = (link: string): string =>
  link.replace(/^https?:\/\/[^/]+\.service-now\.com/i, "");

// Strip the derived `display_value` from every field pair, keeping only `value`.
// A ServiceNow field is serialized as a { value, display_value } pair. The
// display_value is the *current* display name of the field's value — for a
// reference field, the referenced record's name, resolved live on the server at
// pull time. That makes it non-deterministic on disk: rename a referenced record
// on the instance and every metaData.json pointing at it re-churns its
// display_value on the next pull, even though the pointing record is unchanged.
// `value` (the sys_id / raw value) is the stable identity; display_value is a
// convenience the mirror does not need. Reconcile already ignores metaData.json
// content and pushes key off `value` / the manifest, so no consumer depends on
// the persisted display_value. Dropping it keeps re-pulls byte-identical.
const stripFieldDisplayValues = (metadata: Record<string, unknown>): void => {
  for (const key of Object.keys(metadata)) {
    const field = metadata[key];
    if (
      field !== null &&
      typeof field === "object" &&
      "display_value" in field
    ) {
      delete (field as { display_value?: unknown }).display_value;
    }
  }
};

// Merge _lastUpdatedOn into the server-provided metadata content. Preserves all
// record fields (sys_id, sys_scope, field value/display_value pairs, etc.) so
// the local metaData.json is a full snapshot of the record, not just a stub.
export const stampMetadataContent = (file: SN.File): SN.File => {
  if (file.name !== "metaData" || file.type !== "json") return file;
  const stamp = new Date().toISOString();
  if (!file.content) {
    return { ...file, content: JSON.stringify({ _lastUpdatedOn: stamp }, null, 2) };
  }
  try {
    const metadata = JSON.parse(file.content);
    if (metadata.sys_updated_on && metadata.sys_updated_on.value) {
      metadata._lastUpdatedOn = metadata.sys_updated_on.value;
    } else {
      metadata._lastUpdatedOn = stamp;
    }
    if (typeof metadata._record_link === "string") {
      metadata._record_link = stripRecordLinkHost(metadata._record_link);
    }
    stripFieldDisplayValues(metadata);
    return { ...file, content: JSON.stringify(metadata, null, 2) };
  } catch (e) {
    // Content isn't JSON — leave as-is, it will be written verbatim.
    return file;
  }
};

const hasServerMetadata = (files: SN.File[]): boolean =>
  files.some((f) => f.name === "metaData" && f.type === "json" && !!f.content);

const processFilesInManRec = async (
  recPath: string,
  rec: SN.MetaRecord,
  forceWrite: boolean,
) => {
  fileLogger.debug("Processing record: " + rec.name + " (" + rec.files.length + " files)");

  const fileWrite = fUtils.writeSNFileCurry(forceWrite);

  // If the server did not provide a metadata file, fall back to a timestamp-only
  // stub so the record directory always has a metaData.json.
  if (!hasServerMetadata(rec.files)) {
    const stubMetadata: SN.File = {
      name: "metaData",
      type: "json",
      content: JSON.stringify({ _lastUpdatedOn: new Date().toISOString() }, null, 2),
    };
    await fileWrite(stubMetadata, recPath);
  }

  const writeResults = await allSettledBatched(
    rec.files,
    CONCURRENCY_FILES,
    function(file) { return fileWrite(stampMetadataContent(file), recPath); },
  );
  const writeFailures = writeResults.filter(
    (r) => r.status === "rejected",
  );
  if (writeFailures.length > 0) {
    writeFailures.forEach((f) => {
      fileLogger.error("File write failed: " + (f as PromiseRejectedResult).reason);
    });
  }

  // Remove content from ALL files (metadata is not included in manifest)
  rec.files = rec.files.map((file) => {
    const fileCopy = { ...file };
    delete fileCopy.content;
    return fileCopy;
  });

};

const processRecsInManTable = async (
  tablePath: string,
  table: SN.TableConfig,
  forceWrite: boolean,
  onRecordProcessed?: () => void,
) => {
  const { records } = table;
  const recKeys = Object.keys(records);
  // Derive the folder name via toSafeFolderName, not the raw record.name. The
  // download path normalizes manifest keys upstream (processManifest), but the
  // refresh path (processMissingFiles) feeds this writer the raw bulkDownload
  // response, whose .name is the unmodified ServiceNow display name — which can
  // be filesystem-unsafe (e.g. a `<table>.*` ACL). toSafeFolderName is
  // idempotent on already-safe names, so re-applying it here is harmless.
  const recKeyToPath = (key: string) => path.join(tablePath, toSafeFolderName(records[key]));
  const recPathPromises = recKeys
    .map(recKeyToPath)
    .map(fUtils.createDirRecursively);
  await Promise.all(recPathPromises);

  await processBatched(recKeys, CONCURRENCY_RECORDS, function(recKey) {
    return processFilesInManRec(recKeyToPath(recKey), records[recKey], forceWrite).then(function() {
      if (onRecordProcessed) onRecordProcessed();
    });
  });
};

const countRecordsInTables = (tables: SN.TableMap): number => {
  return Object.keys(tables).reduce(function(sum, tableName) {
    return sum + Object.keys(tables[tableName].records).length;
  }, 0);
};

const processTablesInManifest = async (
  tables: SN.TableMap,
  forceWrite: boolean,
  sourcePath?: string,
  onRecordProcessed?: () => void,
  scope?: string,
) => {
  var basePath = sourcePath || ConfigManager.getSourcePath();
  var tableNames = Object.keys(tables);

  // Defense-in-depth: filter out any table not in the resolved whitelist before
  // writing to disk. Protects against upstream defects that let non-whitelisted
  // tables through (e.g. server-side manifest fanout, stale manifest entries).
  if (scope) {
    try {
      var resolved = ConfigManager.resolveConfigForScope(scope);
      var allowed = resolved.tables;
      if (allowed && allowed.length > 0) {
        var skipped: string[] = [];
        tableNames = tableNames.filter(function(t) {
          if (allowed.indexOf(t) === -1) {
            skipped.push(t);
            return false;
          }
          return true;
        });
        if (skipped.length > 0) {
          fileLogger.debug(
            "processTablesInManifest: dropped " + skipped.length +
            " non-whitelisted tables for scope '" + scope + "': " + skipped.join(", ")
          );
        }
      }
    } catch (e) {
      // Config resolution can fail for legacy single-scope manifests; fall
      // through and process whatever the manifest contains.
      fileLogger.debug("processTablesInManifest: could not resolve whitelist for scope '" + scope + "'");
    }
  }

  await processBatched(tableNames, CONCURRENCY_TABLES, function(tableName) {
    return processRecsInManTable(
      path.join(basePath, tableName),
      tables[tableName],
      forceWrite,
      onRecordProcessed,
    );
  });
};

/**
 * Returns a filesystem-safe folder name for a record.
 *
 * Dovetail names each record's on-disk folder after the record's display name.
 * Windows/NTFS forbids these characters in a path component — `< > : " | ? * \ /`
 * — and forbids a trailing space or trailing dot. A folder whose name violates
 * this cannot be checked out on Windows (`git clone` aborts with "invalid path"),
 * even though macOS/Linux accept it. When the display name is unsafe we fall back
 * to the record's sys_id, which is hex and safe on every OS. The true display name
 * is unaffected here and is still carried by the server-provided metaData.json.
 */
export const toSafeFolderName = (record: SN.MetaRecord): string => {
  var name = record.name || "";
  var isUnsafe = /[<>:"|?*\\/]/.test(name) || /[ .]$/.test(name) || name === "";
  return isUnsafe ? record.sys_id : name;
};

/**
 * Re-keys manifest records from sys_id to a filesystem-safe folder name.
 * Some ServiceNow tables return records keyed by sys_id instead of display name.
 * This ensures consistent naming for directories and manifest lookups, and keeps
 * the on-disk folder name (which every writer derives from `record.name`) equal to
 * the manifest key that `dove push` looks records up by — so the key ≡ folder
 * invariant holds even when an unsafe display name forces a sys_id fallback.
 */
export const normalizeManifestKeys = (manifest: SN.AppManifest): SN.AppManifest => {
  var tables = manifest.tables || {};
  var tableNames = Object.keys(tables);
  for (var i = 0; i < tableNames.length; i++) {
    var tableName = tableNames[i];
    var records = tables[tableName].records || {};
    var recordKeys = Object.keys(records);
    var normalized: SN.TableConfigRecords = {};
    for (var j = 0; j < recordKeys.length; j++) {
      var key = recordKeys[j];
      var record = records[key];
      var displayKey = toSafeFolderName(record);
      // Handle duplicate folder names by appending sys_id suffix
      if (normalized[displayKey]) {
        displayKey = displayKey + " (" + record.sys_id.substring(0, 8) + ")";
      }
      // Keep record.name === manifest key so all writers (which build the folder
      // path from record.name) and push (which looks up by folder name) agree.
      // The real display name lives in the server-provided metaData.json snapshot.
      record.name = displayKey;
      normalized[displayKey] = record;
    }
    tables[tableName].records = normalized;
  }
  return manifest;
};

export const processManifest = async (
  manifest: SN.AppManifest,
  forceWrite = false,
  sourcePath?: string,
): Promise<void> => {
  // Idempotent: guarantees filesystem-safe folder names + key ≡ record.name on
  // every write path, including downloadCommand which does not normalize upstream.
  normalizeManifestKeys(manifest);
  const tableCount = Object.keys(manifest.tables).length;
  fileLogger.debug("Processing manifest: " + (manifest.scope || "legacy") + " (" + tableCount + " tables)");

  var recordCount = countRecordsInTables(manifest.tables);
  var progress = createScopeProgress(logger.getLogLevel(), {
    scope: manifest.scope || "default",
    total: recordCount,
  });

  await processTablesInManifest(manifest.tables, forceWrite, sourcePath, progress.tick, manifest.scope);

  if (manifest.scope) {
    await fUtils.writeScopeManifest(manifest.scope, manifest);
  } else {
    await fUtils.writeFileForce(
      ConfigManager.getManifestPath(),
      JSON.stringify(manifest, null, 2),
    );
  }
};

export interface SyncManifestOptions {
  force?: boolean;
  benchmark?: boolean;
  // Narrow the FILE refresh to these tables (a subset of the scope's `_tables`
  // whitelist). The manifest itself is still written in full — narrowing it
  // would drop every other table from dove.manifest.<scope>.json and break
  // push/watch. Empty/absent means "every allowed table", the historic default.
  tables?: string[];
  // Narrow the FILE refresh to a SINGLE record (by table + sys_id). Same safety
  // property as `tables`: the manifest is still written in full — only the file
  // download is scoped to the one record. This is what lets `dove create`'s
  // post-create round-trip write just the new record's files instead of
  // refreshing every record in the scope (the whole-scope-churn footgun).
  // Only meaningful with a specific `scope`; ignored on an all-scopes refresh.
  record?: { table: string; sysId: string };
  // Internal: the active collector + request to close the per-scope segment.
  // Passed scope-to-scope so the caller can wire a single collector across an
  // all-scopes refresh. Not exposed on the CLI surface.
  _benchmarkCollector?: import("./benchmark").BenchmarkCollector;
}

/**
 * Narrow a manifest's table map to `tables`, for the FILE refresh only.
 *
 * Returns a NEW manifest and NEVER mutates its input — the caller must keep
 * writing the original, full manifest to disk. Narrowing the persisted manifest
 * would drop every other table from dove.manifest.<scope>.json and break
 * push/watch. That non-mutation is the whole safety property of `--table`, so
 * it lives in one testable function rather than inline in syncManifest.
 *
 * An empty table map means the scope holds none of the requested tables;
 * refreshAllFiles no-ops on an empty map, so the scope is skipped untouched.
 */
export const narrowManifestToTables = (
  manifest: SN.AppManifest,
  tables?: string[],
): SN.AppManifest => {
  if (!tables || tables.length === 0) return manifest;

  var wantedTables: SN.TableMap = {} as SN.TableMap;
  var presentTableNames = Object.keys(manifest.tables || {});
  for (var w = 0; w < presentTableNames.length; w++) {
    var wName = presentTableNames[w];
    if (tables.indexOf(wName) !== -1) {
      wantedTables[wName] = manifest.tables[wName];
    }
  }
  return Object.assign({}, manifest, { tables: wantedTables });
};

/**
 * Narrow a manifest's table map to a SINGLE record (matched by `table` +
 * `sysId`), for the FILE refresh only.
 *
 * Returns a NEW manifest and NEVER mutates its input — same safety contract as
 * `narrowManifestToTables`: the caller keeps writing the original, full manifest
 * to disk, so the on-disk `dove.manifest.<scope>.json` never loses its other
 * tables/records. Only the file download is scoped to this one record.
 *
 * If the table or a record with that sys_id is absent from the manifest, the
 * returned manifest has an empty table map — refreshAllFiles no-ops on it, so no
 * files are written (the create flow warns and points the user at `dove refresh`).
 */
export const narrowManifestToRecord = (
  manifest: SN.AppManifest,
  table: string,
  sysId: string,
): SN.AppManifest => {
  var empty = Object.assign({}, manifest, { tables: {} as SN.TableMap });
  var tables = manifest.tables || {};
  var tableEntry = (tables as any)[table];
  if (!tableEntry || !tableEntry.records) return empty;

  var records = tableEntry.records;
  var recKeys = Object.keys(records);
  var wantedRecords: Record<string, any> = {};
  for (var i = 0; i < recKeys.length; i++) {
    var rec = records[recKeys[i]];
    if (rec && rec.sys_id === sysId) {
      wantedRecords[recKeys[i]] = rec;
    }
  }
  if (Object.keys(wantedRecords).length === 0) return empty;

  var narrowedTables: any = {};
  narrowedTables[table] = Object.assign({}, tableEntry, { records: wantedRecords });
  return Object.assign({}, manifest, { tables: narrowedTables });
};

export const syncManifest = async (
  scope?: string,
  options: SyncManifestOptions = {},
) => {
  // Top-level entry owns the collector lifecycle. Recursive calls (all-scopes
  // → per-scope) inherit the collector via options._benchmarkCollector.
  var isBenchmarkOwner = false;
  var collector: BenchmarkCollector | undefined = options._benchmarkCollector;
  if (options.benchmark && !collector) {
    collector = new BenchmarkCollector();
    setBenchmarkSink(collector);
    isBenchmarkOwner = true;
  }

  try {
    const curManifest = await ConfigManager.getManifest();
    if (!curManifest) throw new Error("No manifest file loaded!");

    const config = ConfigManager.getConfig();
    const declaredScopes = (config.scopes && Object.keys(config.scopes)) || [];

    // If a specific scope is provided, sync only that scope
    if (scope) {
      // Scope whitelist gate: refuse to refresh scopes not declared in dove.config.js.
      // Without this, stale entries in dove.manifest.json leak undeclared scopes into
      // the refresh loop (see RFC-0004 / sys_alias debris incident 2026-04-14).
      if (declaredScopes.length > 0 && declaredScopes.indexOf(scope) === -1) {
        logger.warn(
          "Skipping scope '" + scope + "' — not declared in dove.config.js `scopes`. " +
          "Add it to config.scopes to sync, or remove its manifest file."
        );
        fileLogger.debug("syncManifest: skipped undeclared scope '" + scope + "'");
        return;
      }

      logger.info("Refreshing scope: " + scope + "...");
      const client = defaultClient();

      // Resolve scope-specific source directory + table whitelist
      var scopeSourcePath = ConfigManager.getSourcePathForScope(scope);
      var resolvedConfig = ConfigManager.resolveConfigForScope(scope);
      var allowedTables = resolvedConfig.tables;

      const newManifest = normalizeManifestKeys(
        await unwrapSNResponse(client.getManifest(scope, config)),
      );

      // Table whitelist gate: drop any table the server returned that is not in
      // the resolved _tables whitelist for this scope. Mirrors the filter in
      // commands.ts downloadCommand() and allScopesCommands.ts processScope().
      if (allowedTables && allowedTables.length > 0) {
        var manifestTableNames = Object.keys(newManifest.tables || {});
        var filteredTables: any = {};
        var skippedCount = 0;
        for (var t = 0; t < manifestTableNames.length; t++) {
          var tName = manifestTableNames[t];
          if (allowedTables.indexOf(tName) !== -1) {
            filteredTables[tName] = newManifest.tables[tName];
          } else {
            skippedCount++;
          }
        }
        if (skippedCount > 0) {
          fileLogger.debug(
            "syncManifest: filtered " + skippedCount + " tables not in _tables whitelist for " +
            scope + " (kept " + Object.keys(filteredTables).length + " of " + manifestTableNames.length + ")"
          );
        }
        newManifest.tables = filteredTables;
      } else {
        logger.warn("No _tables whitelist defined — writing ALL tables for " + scope);
      }

      const refreshTableCount = Object.keys(newManifest.tables).length;
      fileLogger.debug("Refreshed manifest for " + scope + ": " + refreshTableCount + " tables");

      // The manifest is always written in FULL. Narrowing it to the --table
      // subset would drop every other table from dove.manifest.<scope>.json and
      // break push/watch, so the filter applies only to the file download below.
      await fUtils.writeScopeManifest(scope, newManifest);

      // --table gate: refresh file content for only the requested tables. Any
      // table outside this scope's `_tables` whitelist was already dropped above,
      // so intersecting the manifest is enough. `newManifest` is left intact —
      // see narrowManifestToTables.
      var refreshManifest = narrowManifestToTables(newManifest, options.tables);
      // Single-record narrowing (dove create round-trip). Applied after the
      // --table narrowing so the two compose; the full manifest was already
      // written above, so only the file download is scoped to the one record.
      if (options.record) {
        refreshManifest = narrowManifestToRecord(
          refreshManifest,
          options.record.table,
          options.record.sysId,
        );
        if (Object.keys(refreshManifest.tables).length === 0) {
          logger.warn(
            "Created record " + options.record.sysId + " (" + options.record.table +
            ") not found in the refreshed scope manifest — local files not written. " +
            "Run 'npx dove refresh' to pull it.",
          );
        } else {
          fileLogger.debug(
            "syncManifest: narrowed file refresh to single record " +
            options.record.sysId + " (" + options.record.table + ")",
          );
        }
      }
      if (options.tables && options.tables.length > 0) {
        var wantedNames = Object.keys(refreshManifest.tables);
        if (wantedNames.length === 0) {
          // Expected on every non-matching scope of an all-scopes filtered
          // refresh, so this is debug — at info it would emit one noise line per
          // scope that simply doesn't hold the table you asked for.
          fileLogger.debug(
            "syncManifest: scope " + scope + " holds none of the requested tables — skipping file refresh",
          );
        } else {
          logger.info(
            "Refreshing " + wantedNames.length + " of " + refreshTableCount + " tables in " +
            scope + " (--table): " + wantedNames.join(", "),
          );
        }
      }

      if (collector) collector.startScope(scope);
      await refreshAllFiles(refreshManifest, scopeSourcePath, {
        force: options.force,
        benchmarkCollector: collector,
      });

      // Update the in-memory manifest for this scope
      if (ConfigManager.isMultiScopeManifest(curManifest)) {
        (curManifest as any)[scope] = newManifest;
        ConfigManager.updateManifest(curManifest as any);
      }
    } else {
      // Sync all scopes. Prefer the declared-scopes list (config.scopes) over
      // the persisted manifest keys — the manifest may contain stale undeclared
      // scopes that leaked in before the whitelist gate existed.
      var childOptions: SyncManifestOptions = {
        force: options.force,
        tables: options.tables,
        _benchmarkCollector: collector,
      };
      if (declaredScopes.length > 0) {
        for (var d = 0; d < declaredScopes.length; d++) {
          await syncManifest(declaredScopes[d], childOptions);
        }
      } else if (ConfigManager.isMultiScopeManifest(curManifest)) {
        // No declared scopes — fall back to the persisted manifest's scopes.
        for (const scopeName of Object.keys(curManifest)) {
          await syncManifest(scopeName, childOptions);
        }
      } else if (curManifest.scope) {
        // Single scope manifest
        await syncManifest(curManifest.scope, childOptions);
      }
    }
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    logger.error("Refresh failed: " + message);
  } finally {
    if (isBenchmarkOwner && collector) {
      setBenchmarkSink(null);
      logger.info(collector.formatSummary());
    }
  }
};

const markFileMissing =
  (missingObj: SN.MissingFileTableMap) =>
  (table: string) =>
  (recordId: string) =>
  (file: SN.File) => {
    if (!missingObj[table]) {
      missingObj[table] = {};
    }
    if (!missingObj[table][recordId]) {
      missingObj[table][recordId] = [];
    }
    const { name, type } = file;
    missingObj[table][recordId].push({ name, type });
  };
type MarkTableMissingFunc = ReturnType<typeof markFileMissing>;
type MarkRecordMissingFunc = ReturnType<MarkTableMissingFunc>;
type MarkFileMissingFunc = ReturnType<MarkRecordMissingFunc>;

const markRecordMissing = (
  record: SN.MetaRecord,
  missingFunc: MarkRecordMissingFunc,
) => {
  record.files.forEach((file) => {
    missingFunc(record.sys_id)(file);
  });
};

const markTableMissing = (
  table: SN.TableConfig,
  tableName: string,
  missingFunc: MarkTableMissingFunc,
) => {
  Object.keys(table.records).forEach((recName) => {
    markRecordMissing(table.records[recName], missingFunc(tableName));
  });
};

const checkFilesForMissing = async (
  recPath: string,
  files: SN.File[],
  missingFunc: MarkFileMissingFunc,
) => {
  const checkPromises = files.map(fUtils.SNFileExists(recPath));
  const checks = await Promise.all(checkPromises);
  checks.forEach((check, index) => {
    if (!check) {
      missingFunc(files[index]);
    }
  });
};

const checkRecordsForMissing = async (
  tablePath: string,
  records: SN.TableConfigRecords,
  missingFunc: MarkRecordMissingFunc,
) => {
  const recNames = Object.keys(records);
  const recPaths = recNames.map(fUtils.appendToPath(tablePath));
  const checkPromises = recNames.map((recName, index) =>
    fUtils.pathExists(recPaths[index]),
  );
  const checks = await Promise.all(checkPromises);
  const fileCheckPromises = checks.map(async (check, index) => {
    const recName = recNames[index];
    const record = records[recName];
    if (!check) {
      markRecordMissing(record, missingFunc);
      return;
    }
    await checkFilesForMissing(
      recPaths[index],
      record.files,
      missingFunc(record.sys_id),
    );
  });
  await Promise.all(fileCheckPromises);
};

const checkTablesForMissing = async (
  topPath: string,
  tables: SN.TableMap,
  missingFunc: MarkTableMissingFunc,
) => {
  const tableNames = Object.keys(tables);
  const tablePaths = tableNames.map(fUtils.appendToPath(topPath));
  const checkPromises = tableNames.map((tableName, index) =>
    fUtils.pathExists(tablePaths[index]),
  );
  const checks = await Promise.all(checkPromises);

  const recCheckPromises = checks.map(async (check, index) => {
    const tableName = tableNames[index];
    if (!check) {
      markTableMissing(tables[tableName], tableName, missingFunc);
      return;
    }
    await checkRecordsForMissing(
      tablePaths[index],
      tables[tableName].records,
      missingFunc(tableName),
    );
  });
  await Promise.all(recCheckPromises);
};

export const findMissingFiles = async (
  manifest: SN.AppManifest,
  sourcePath?: string,
): Promise<SN.MissingFileTableMap> => {
  const missing: SN.MissingFileTableMap = {};
  const { tables } = manifest;
  const missingTableFunc = markFileMissing(missing);
  await checkTablesForMissing(
    sourcePath || ConfigManager.getSourcePath(),
    tables,
    missingTableFunc,
  );
  // missing gets mutated along the way as things get processed
  return missing;
};

// Chunk bulkDownload by table to stay under ServiceNow's 10 MB REST payload cap.
// A single unchunked call 500s on large scopes (e.g. x_cadso_automate at ~29 MB).
// Must mirror the chunk size used by allScopesCommands.ts (watch path) so behaviour
// is consistent across `refresh` and `watch`.
const BULK_DOWNLOAD_TABLE_CHUNK_SIZE = 5;

/**
 * Builds a MissingFileTableMap containing EVERY file in the manifest — ignores
 * local disk state. Used by `sinc refresh` to pull instance-side edits down.
 */
const buildAllFilesMap = (manifest: SN.AppManifest): SN.MissingFileTableMap => {
  const result: SN.MissingFileTableMap = {} as SN.MissingFileTableMap;
  const { tables } = manifest;
  const tableNames = Object.keys(tables);
  for (var t = 0; t < tableNames.length; t++) {
    var tableName = tableNames[t];
    var records = tables[tableName].records;
    var recNames = Object.keys(records);
    if (recNames.length === 0) continue;
    var recMap: SN.MissingFileRecord = {} as SN.MissingFileRecord;
    for (var r = 0; r < recNames.length; r++) {
      var rec = records[recNames[r]];
      if (!rec.files || rec.files.length === 0) continue;
      // Strip any content that may be lingering on manifest file entries; the
      // bulkDownload endpoint only needs name + type to resolve each field.
      recMap[rec.sys_id] = rec.files.map(function(f) {
        return { name: f.name, type: f.type };
      });
    }
    if (Object.keys(recMap).length > 0) result[tableName] = recMap;
  }
  return result;
};

/**
 * Refreshes local files against the ServiceNow instance for every file in the
 * given manifest. Unlike `processMissingFiles` (which only writes files absent
 * from disk), this walks ALL manifest files, fetches their current content from
 * the instance, and writes when content differs.
 *
 * @param options.force — when true, always overwrite local files even if their
 * content matches the instance. Use for deliberate "reset local to instance".
 */
export const refreshAllFiles = async (
  newManifest: SN.AppManifest,
  sourcePath?: string,
  options: { force?: boolean; benchmarkCollector?: BenchmarkCollector } = {},
): Promise<void> => {
  try {
    const allFiles = buildAllFilesMap(newManifest);
    const tableNames = Object.keys(allFiles);
    if (tableNames.length === 0) return;

    fileLogger.debug(
      "Refreshing file content for " + tableNames.length + " tables (force=" + !!options.force + ")",
    );

    const { tableOptions = {} } = ConfigManager.getConfig();
    const client = defaultClient();
    const totalChunks = Math.ceil(tableNames.length / BULK_DOWNLOAD_TABLE_CHUNK_SIZE);
    const filesToProcess: SN.TableMap = {} as SN.TableMap;

    for (var i = 0; i < tableNames.length; i += BULK_DOWNLOAD_TABLE_CHUNK_SIZE) {
      const chunkTableNames = tableNames.slice(i, i + BULK_DOWNLOAD_TABLE_CHUNK_SIZE);
      const chunkMissing: SN.MissingFileTableMap = {} as SN.MissingFileTableMap;
      for (var j = 0; j < chunkTableNames.length; j++) {
        chunkMissing[chunkTableNames[j]] = allFiles[chunkTableNames[j]];
      }

      const batchNum = Math.floor(i / BULK_DOWNLOAD_TABLE_CHUNK_SIZE) + 1;
      fileLogger.debug(
        "Refresh download batch " + batchNum + "/" + totalChunks +
        " (" + chunkTableNames.length + " tables): " + chunkTableNames.join(", "),
      );

      const chunkResult = await unwrapSNResponse(
        client.getMissingFiles(chunkMissing, tableOptions),
      );

      for (var tableName in chunkResult) {
        (filesToProcess as any)[tableName] = (chunkResult as any)[tableName];
      }
    }

    var basePath = sourcePath || ConfigManager.getSourcePath();
    var recordCount = countRecordsInTables(filesToProcess);
    var progress = createScopeProgress(logger.getLogLevel(), {
      scope: newManifest.scope || "default",
      total: recordCount,
    });

    var writtenCount = 0;
    var unchangedCount = 0;
    const forceWrite = !!options.force;
    const forceWriter = fUtils.writeSNFileCurry(false);

    const processedTableNames = Object.keys(filesToProcess);
    await processBatched(processedTableNames, CONCURRENCY_TABLES, async function(tableName) {
      var tablePath = path.join(basePath, tableName);
      var recs = filesToProcess[tableName].records;
      var recKeys = Object.keys(recs);
      await Promise.all(recKeys.map(function(k) {
        // toSafeFolderName, not raw recs[k].name: the bulkDownload response
        // carries the unmodified ServiceNow display name, which may be
        // filesystem-unsafe (e.g. a `<table>.*` ACL). Without this, refresh
        // recreates Windows-illegal folders that normalizeManifestKeys
        // already removed from the manifest.
        return fUtils.createDirRecursively(path.join(tablePath, toSafeFolderName(recs[k])));
      }));

      await processBatched(recKeys, CONCURRENCY_RECORDS, async function(recKey) {
        var rec = recs[recKey];
        var recPath = path.join(tablePath, toSafeFolderName(rec));

        // Split server-provided metadata off from the regular files so we can
        // track whether any regular file actually changed — metaData shouldn't
        // be the trigger for "this record changed" since we stamp it on every
        // touch.
        var metadataFiles: SN.File[] = [];
        var regularFiles: SN.File[] = [];
        for (var mi = 0; mi < rec.files.length; mi++) {
          var rf = rec.files[mi];
          if (rf.name === "metaData" && rf.type === "json") {
            metadataFiles.push(rf);
          } else {
            regularFiles.push(rf);
          }
        }

        var results = await allSettledBatched(regularFiles, CONCURRENCY_FILES, async function(file) {
          if (forceWrite) {
            await forceWriter(file, recPath);
            return true;
          }
          return fUtils.writeSNFileIfDifferent(file, recPath);
        });

        var anyChanged = false;
        for (var f = 0; f < results.length; f++) {
          var res = results[f];
          if (res.status === "rejected") {
            fileLogger.error("File write failed: " + (res as PromiseRejectedResult).reason);
            continue;
          }
          if ((res as PromiseFulfilledResult<boolean>).value) {
            anyChanged = true;
            writtenCount++;
          } else {
            unchangedCount++;
          }
        }

        // Only touch metaData when at least one regular file in the record
        // actually changed. Avoids rewriting _lastUpdatedOn for records that
        // were already in sync with the instance. Prefer the server-provided
        // metadata (full field snapshot) over a stub; fall back to a stub only
        // when the server didn't send metadata at all.
        if (anyChanged || forceWrite) {
          let metadataFile: SN.File;
          if (metadataFiles.length > 0 && metadataFiles[0].content) {
            metadataFile = stampMetadataContent(metadataFiles[0]);
          } else {
            metadataFile = {
              name: "metaData",
              type: "json",
              content: JSON.stringify({ _lastUpdatedOn: new Date().toISOString() }, null, 2),
            };
          }
          await forceWriter(metadataFile, recPath);
        }

        // Strip content from manifest entries to keep memory bounded.
        rec.files = rec.files.map(function(file) {
          var copy = Object.assign({}, file);
          delete copy.content;
          return copy;
        });

        progress.tick();
      });
    });

    fileLogger.debug(
      "Refresh complete: " + writtenCount + " written, " + unchangedCount + " unchanged",
    );
    if (writtenCount > 0) {
      logger.info(
        "Refreshed " + writtenCount + " file(s) from instance" +
        (unchangedCount > 0 ? " (" + unchangedCount + " already in sync)" : ""),
      );
    } else {
      logger.debug("No file changes detected from instance (" + unchangedCount + " checked)");
    }

    if (options.benchmarkCollector) {
      options.benchmarkCollector.endScope(writtenCount, unchangedCount);
    }
  } catch (e) {
    if (options.benchmarkCollector) {
      options.benchmarkCollector.endScope(0, 0);
    }
    throw e;
  }
};

export const processMissingFiles = async (
  newManifest: SN.AppManifest,
  sourcePath?: string,
): Promise<void> => {
  try {
    const missing = await findMissingFiles(newManifest, sourcePath);
    const missingTableCount = Object.keys(missing).length;
    if (missingTableCount === 0) return;

    fileLogger.debug("Downloading missing files from " + missingTableCount + " tables");

    const { tableOptions = {} } = ConfigManager.getConfig();
    const client = defaultClient();

    // Chunk the bulkDownload request: ServiceNow rejects REST payloads > 10 MB,
    // so send table batches and merge the results before processing.
    const tableNames = Object.keys(missing);
    const totalChunks = Math.ceil(tableNames.length / BULK_DOWNLOAD_TABLE_CHUNK_SIZE);
    const filesToProcess: SN.TableMap = {} as SN.TableMap;

    for (var i = 0; i < tableNames.length; i += BULK_DOWNLOAD_TABLE_CHUNK_SIZE) {
      const chunkTableNames = tableNames.slice(i, i + BULK_DOWNLOAD_TABLE_CHUNK_SIZE);
      const chunkMissing: SN.MissingFileTableMap = {} as SN.MissingFileTableMap;
      for (var j = 0; j < chunkTableNames.length; j++) {
        chunkMissing[chunkTableNames[j]] = missing[chunkTableNames[j]];
      }

      const batchNum = Math.floor(i / BULK_DOWNLOAD_TABLE_CHUNK_SIZE) + 1;
      fileLogger.debug(
        "Bulk download batch " + batchNum + "/" + totalChunks +
        " (" + chunkTableNames.length + " tables): " + chunkTableNames.join(", "),
      );

      const chunkResult = await unwrapSNResponse(
        client.getMissingFiles(chunkMissing, tableOptions),
      );

      // Chunks are partitioned by table key, so merging is a simple assign.
      for (var tableName in chunkResult) {
        (filesToProcess as any)[tableName] = (chunkResult as any)[tableName];
      }
    }

    var recordCount = countRecordsInTables(filesToProcess);
    var progress = createScopeProgress(logger.getLogLevel(), {
      scope: newManifest.scope || "default",
      total: recordCount,
    });

    await processTablesInManifest(filesToProcess, false, sourcePath, progress.tick, newManifest.scope);
  } catch (e) {
    throw e;
  }
};

export const groupAppFiles = (fileCtxs: Sinc.FileContext[]) => {
  const combinedFiles = fileCtxs.reduce(
    (groupMap, cur) => {
      const { tableName, targetField, sys_id } = cur;
      const key = `${tableName}-${sys_id}`;
      const entry: Sinc.BuildableRecord = groupMap[key] ?? {
        table: tableName,
        sysId: sys_id,
        fields: {},
      };
      const newEntry: Sinc.BuildableRecord = {
        ...entry,
        fields: { ...entry.fields, [targetField]: cur ?? "" },
      };
      return { ...groupMap, [key]: newEntry };
    },
    {} as Record<string, Sinc.BuildableRecord>,
  );
  return Object.values(combinedFiles);
};

export const getAppFileList = async (
  paths: string | string[],
): Promise<Sinc.BuildableRecord[]> => {
  const validPaths =
    typeof paths === "object"
      ? paths
      : await fUtils.encodedPathsToFilePaths(paths);
  const appFileCtxs: Sinc.FileContext[] = [];
  validPaths.forEach(function (filePath) {
    var result = fUtils.getFileContextWithSkipReason(filePath);
    if (result.context) {
      appFileCtxs.push(result.context);
    } else {
      var reason = result.skipReason || "unknown";
      if (reason === "not in manifest") {
        logger.info(`Skipped: ${filePath} (${reason})`);
      } else {
        logger.warn(`Skipped: ${filePath} (${reason})`);
      }
    }
  });
  return groupAppFiles(appFileCtxs);
};

const buildRec = async (
  rec: Sinc.BuildableRecord,
): Promise<Sinc.RecBuildRes> => {
  const fields = Object.keys(rec.fields);
  const buildPromises = fields.map((field) => {
    return PluginManager.getFinalFileContents(rec.fields[field]);
  });
  const builtFiles = await allSettled(buildPromises);
  const buildSuccess = !builtFiles.find(
    (buildRes) => buildRes.status === "rejected",
  );
  if (!buildSuccess) {
    return {
      success: false,
      message: aggregateErrorMessages(
        builtFiles
          .filter((b): b is Sinc.FailPromiseResult => b.status === "rejected")
          .map((b) => b.reason),
        "Failed to build!",
        (_, index) => `${index}`,
      ),
    };
  }
  const builtRec = builtFiles.reduce(
    (acc, buildRes, index) => {
      const { value: content } = buildRes as Sinc.SuccessPromiseResult<string>;
      const fieldName = fields[index];
      return { ...acc, [fieldName]: content };
    },
    {} as Record<string, string>,
  );
  return {
    success: true,
    builtRec,
  };
};

const pushRec = async (
  client: SNClient,
  table: string,
  sysId: string,
  builtRec: Record<string, string>,
  summary?: string,
  scope?: string,
  updateSetConfig?: UpdateSetConfig,
) => {
  const recSummary = summary ?? `${table} > ${sysId}`;
  try {
    // Use the batch-level config passed from pushFiles() to avoid re-reading per record
    const config = updateSetConfig || {};
    const updateSet = scope ? config[scope] : undefined;

    const pushFn = updateSet
      ? () => {
          logger.debug(
            `Pushing ${recSummary} via update set: ${updateSet.name}`,
          );
          return client.pushWithUpdateSet(
            updateSet.sys_id,
            table,
            sysId,
            builtRec,
          );
        }
      : () => client.updateRecord(table, sysId, builtRec);

    const pushRes = await retryOnHttpErr(pushFn, recSummary);
    return processPushResponse(pushRes, recSummary);
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    const errMsg = message || "Too many retries";
    return { success: false, message: `${recSummary} : ${errMsg}` };
  }
};

export const pushFiles = async (
  recs: Sinc.BuildableRecord[],
): Promise<Sinc.PushResult[]> => {
  const client = defaultClient();
  const updateSetConfig = getUpdateSetConfig();
  const hasUpdateSets = Object.keys(updateSetConfig).length > 0;
  if (hasUpdateSets) {
    const activeScopes = Object.entries(updateSetConfig)
      .map(([scope, us]) => `${scope} -> ${us.name} (${us.sys_id})`)
      .join(", ");
    // Name the source file and show the sys_id so the operator can see exactly
    // where captures land — push routes by this file, not the active set (#182).
    logger.info(
      `Update set routing (from .dove-update-sets.json): ${activeScopes}`,
    );
  }

  // Pre-resolve read-only table sets for every scope present in this batch.
  // Cheaper than re-resolving per record. Tables flagged in _readOnlyTables
  // are pulled normally but pushes are skipped.
  const readOnlyByScope: Record<string, Set<string>> = {};
  for (const rec of recs) {
    const fieldNames = Object.keys(rec.fields);
    if (fieldNames.length === 0) continue;
    const scope = rec.fields[fieldNames[0]].scope;
    if (scope && !readOnlyByScope[scope]) {
      readOnlyByScope[scope] = ConfigManager.getReadOnlyTablesForScope(scope);
    }
  }
  const announcedSkipTables: Record<string, boolean> = {};

  const tick = getProgTick(logger.getLogLevel(), recs.length * 2) || (() => {});
  const results = await allSettledBatched(recs, CONCURRENCY_PUSH, async function(rec) {
    const fieldNames = Object.keys(rec.fields);
    const firstField = rec.fields[fieldNames[0]];
    const recSummary = summarizeRecord(rec.table, firstField.name);
    const scope = firstField.scope;

    const readOnlySet = scope ? readOnlyByScope[scope] : undefined;
    if (readOnlySet && readOnlySet.has(rec.table)) {
      tick();
      tick();
      const skipKey = `${scope}:${rec.table}`;
      if (!announcedSkipTables[skipKey]) {
        announcedSkipTables[skipKey] = true;
        logger.info(`Read-only table ${rec.table} in scope ${scope}: push skipped`);
      }
      return { success: true, message: `${recSummary} : skipped (read-only table)` };
    }

    const buildRes = await buildRec(rec);
    tick();
    if (!buildRes.success) {
      tick();
      return { success: false, message: `${recSummary} : ${buildRes.message}` };
    }
    const pushRes = await pushRec(
      client,
      rec.table,
      rec.sysId,
      buildRes.builtRec,
      recSummary,
      scope,
      updateSetConfig,
    );
    tick();
    return pushRes;
  });
  return results.map(function(result) {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return { success: false, message: `Push failed: ${result.reason}` };
  });
};

export const summarizeRecord = (table: string, recDescriptor: string): string =>
  `${table} > ${recDescriptor}`;

interface ScopeProgressResult {
  tick: () => void;
  setTotal: (n: number) => void;
}

const createScopeProgress = (
  logLevel: string,
  options: { scope: string; total: number },
): ScopeProgressResult => {
  if (logLevel !== "info" || options.total === 0) {
    return { tick: function() {}, setTotal: function() {} };
  }
  var progBar = new ProgressBar(":scope :bar :current/:total (:percent)", {
    total: options.total,
    width: 40,
    complete: "=",
    incomplete: "-",
  });
  return {
    tick: function() {
      progBar.tick({ scope: options.scope });
    },
    setTotal: function(n) {
      progBar.total = n;
    },
  };
};

const getProgTick = (
  logLevel: string,
  total: number,
): (() => void) | undefined => {
  if (logLevel === "info") {
    const progBar = new ProgressBar(":bar (:percent)", {
      total,
      width: 60,
    });
    return () => {
      progBar.tick();
    };
  }
  // no-op at other log levels
  return undefined;
};

const writeBuildFile = async (
  preBuild: Sinc.BuildableRecord,
  buildRes: Sinc.RecBuildSuccess,
  summary?: string,
): Promise<Sinc.BuildResult> => {
  const { fields, table, sysId } = preBuild;
  const recSummary = summary ?? `${table} > ${sysId}`;
  const sourcePath = ConfigManager.getSourcePath();
  const buildPath = ConfigManager.getBuildPath();
  const fieldNames = Object.keys(fields);
  const writePromises = fieldNames.map(async (field) => {
    const fieldCtx = fields[field];
    const srcFilePath = fieldCtx.filePath;
    const relativePath = path.relative(sourcePath, srcFilePath);
    const relPathNoExt = relativePath.split(".").slice(0, -1).join();
    const buildExt = fUtils.getBuildExt(
      fieldCtx.tableName,
      fieldCtx.name,
      fieldCtx.targetField,
      fieldCtx.scope,
    );
    const relPathNewExt = `${relPathNoExt}.${buildExt}`;
    const buildFilePath = path.join(buildPath, relPathNewExt);
    await fUtils.createDirRecursively(path.dirname(buildFilePath));
    const writeResult = await fUtils.writeFileForce(
      buildFilePath,
      buildRes.builtRec[fieldCtx.targetField],
    );
    return writeResult;
  });
  
  try {
    await processBatched(fieldNames, CONCURRENCY_FILES, async function(field) {
      const fieldCtx = fields[field];
      const srcFilePath = fieldCtx.filePath;
      const relativePath = path.relative(sourcePath, srcFilePath);
      const relPathNoExt = relativePath.split(".").slice(0, -1).join();
      const buildExt = fUtils.getBuildExt(
        fieldCtx.tableName,
        fieldCtx.name,
        fieldCtx.targetField,
      );
      const relPathNewExt = `${relPathNoExt}.${buildExt}`;
      const buildFilePath = path.join(buildPath, relPathNewExt);
      await fUtils.createDirRecursively(path.dirname(buildFilePath));
      await fUtils.writeFileForce(
        buildFilePath,
        buildRes.builtRec[fieldCtx.targetField],
      );
    });
    return { success: true, message: `${recSummary} built successfully` };
  } catch (e) {
    return {
      success: false,
      message: `${recSummary} : ${e}`,
    };
  }
};

export const buildFiles = async (
  fileList: Sinc.BuildableRecord[],
): Promise<Sinc.BuildResult[]> => {
  const tick =
    getProgTick(logger.getLogLevel(), fileList.length * 2) || (() => {});
  const results = await allSettledBatched(fileList, CONCURRENCY_BUILD, async function(rec) {
    const { fields, table } = rec;
    const fieldNames = Object.keys(fields);
    const recSummary = summarizeRecord(table, fields[fieldNames[0]].name);
    const buildRes = await buildRec(rec);
    tick();
    if (!buildRes.success) {
      tick();
      return { success: false, message: `${recSummary} : ${buildRes.message}` };
    }
    // writeFile
    const writeRes = await writeBuildFile(rec, buildRes, recSummary);
    tick();
    return writeRes;
  });
  return results.map(function(result) {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return { success: false, message: `Build failed: ${result.reason}` };
  });
};

export const swapScope = async (currentScope: string): Promise<SN.ScopeObj> => {
  try {
    const client = defaultClient();
    const scopeId = await unwrapTableAPIFirstItem(
      client.getScopeId(currentScope),
      "sys_id",
    );
    await swapServerScope(scopeId);
    const scopeObj = await unwrapSNResponse(client.getCurrentScope());
    return scopeObj;
  } catch (e) {
    throw e;
  }
};

const swapServerScope = async (scopeId: string): Promise<void> => {
  try {
    const client = defaultClient();
    const userSysId = await unwrapTableAPIFirstItem(
      client.getUserSysId(),
      "sys_id",
    );
    const curAppUserPrefId =
      (await unwrapTableAPIFirstItem(
        client.getCurrentAppUserPrefSysId(userSysId),
        "sys_id",
      )) || "";
    // If not user pref record exists, create it.
    if (curAppUserPrefId !== "")
      await client.updateCurrentAppUserPref(scopeId, curAppUserPrefId);
    else await client.createCurrentAppUserPref(scopeId, userSysId);
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    logger.error(message);
    throw e;
  }
};

/**
 * Creates a new update set and assigns it to the current user.
 * @param updateSetName - does not create update set if value is blank
 * @param scope - optional scope name (e.g. x_cadso_work) to create the update set in
 */
export const createAndAssignUpdateSet = async (updateSetName = "", scope?: string) => {
  logger.info(`Update Set Name: ${updateSetName}` + (scope ? ` (scope: ${scope})` : ""));
  const client = defaultClient();
  var scopeSysId: string | undefined;
  if (scope) {
    var scopeResult = await unwrapSNResponse(client.getScopeId(scope));
    if (scopeResult.length > 0) {
      scopeSysId = scopeResult[0].sys_id;
    }
  }
  const { sys_id: updateSetSysId } = await unwrapSNResponse(
    client.createUpdateSet(updateSetName, scopeSysId),
  );
  const userSysId = await unwrapTableAPIFirstItem(
    client.getUserSysId(),
    "sys_id",
  );
  const curUpdateSetUserPrefId = await unwrapTableAPIFirstItem(
    client.getCurrentUpdateSetUserPref(userSysId),
    "sys_id",
  );

  if (curUpdateSetUserPrefId !== "") {
    await client.updateCurrentUpdateSetUserPref(
      updateSetSysId,
      curUpdateSetUserPrefId,
    );
  } else {
    await client.createCurrentUpdateSetUserPref(updateSetSysId, userSysId);
  }

  // Route this scope's captures to the new set. pushFiles() routes by
  // .dove-update-sets.json, not the active set, so without this a `dove push
  // --updateSet` could create+activate a set yet capture into a stale one
  // (TenonHQ/Dovetail#182). Only possible when the scope name is known.
  if (scope) {
    const routed = writeUpdateSetRouting({
      scope,
      sysId: updateSetSysId,
      name: updateSetName,
    });
    if (routed) {
      logger.info(
        `Push routing updated: ${scope} -> ${updateSetName} (${updateSetSysId})`,
      );
    }
  }

  return {
    name: updateSetName,
    id: updateSetSysId,
  };
};

