// I/O adapters that materialize a scope's records into the normalized
// ReconcileRecord shape, one builder per side:
//   - loadBranchRecords  reads the on-disk per-scope manifest + each record's
//     field files (the checked-out branch IS the working tree).
//   - loadLiveRecords    reads the instance's current record set via the same
//     getManifest + bulk-download path `dove refresh` uses, but keeps content
//     in memory instead of writing it to disk.
// Both strip the metaData bookkeeping file from the comparable field set (see
// fields.ts), so the pure diff engine sees genuine field content only.

import { SN } from "@tenonhq/dovetail-types";
import path from "path";
import { promises as fsp } from "fs";
import * as ConfigManager from "./../config";
import { defaultClient, unwrapSNResponse } from "./../snClient";
import { normalizeManifestKeys, toSafeFolderName } from "./../appUtils";
import { fileLogger } from "./../FileLogger";
import { fieldKey, isComparableField } from "./fields";
import { ReconcileRecord } from "./types";

// Mirror the refresh chunk size so a large scope stays under ServiceNow's ~10 MB
// REST payload cap.
const BULK_DOWNLOAD_TABLE_CHUNK_SIZE = 5;

// Pull `sys_updated_on` out of a metaData.json blob. Both sides carry
// `sys_updated_on: { value }` — that is the primary source. `_lastUpdatedOn` is
// a legacy fallback: Dovetail no longer writes it (it duplicated
// `sys_updated_on.value` and its no-sys_updated_on branch stamped a wall-clock
// that churned every pull), but a branch checked out before that change still
// has it on disk, so keep reading it. Neither present -> "".
function extractUpdatedOn(metaContent: string | undefined): string {
  if (!metaContent) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaContent);
  } catch (e) {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "";
  }
  const meta = parsed as Record<string, unknown>;
  const updated = meta.sys_updated_on;
  if (
    typeof updated === "object" &&
    updated !== null &&
    typeof (updated as Record<string, unknown>).value === "string"
  ) {
    return (updated as Record<string, string>).value;
  }
  if (typeof meta._lastUpdatedOn === "string") {
    return meta._lastUpdatedOn;
  }
  return "";
}

function applyWhitelist(manifest: SN.AppManifest, scope: string): SN.AppManifest {
  let allowed: string[] = [];
  try {
    allowed = ConfigManager.resolveConfigForScope(scope).tables || [];
  } catch (e) {
    allowed = [];
  }
  if (allowed.length === 0) {
    return manifest;
  }
  const filtered: SN.TableMap = {};
  for (const table of Object.keys(manifest.tables || {})) {
    if (allowed.indexOf(table) !== -1) {
      filtered[table] = manifest.tables[table];
    }
  }
  return { tables: filtered, scope: manifest.scope };
}

// ---------------------------------------------------------------------------
// Branch side (on-disk)
// ---------------------------------------------------------------------------

export async function loadBranchRecords(scope: string): Promise<ReconcileRecord[]> {
  const manifest = await ConfigManager.loadScopeManifest(scope);
  if (!manifest || !manifest.tables) {
    return [];
  }
  const whitelisted = applyWhitelist(manifest, scope);
  const sourcePath = ConfigManager.getSourcePathForScope(scope);

  const records: ReconcileRecord[] = [];
  for (const table of Object.keys(whitelisted.tables)) {
    const tableRecords = whitelisted.tables[table].records || {};
    for (const key of Object.keys(tableRecords)) {
      const meta = tableRecords[key];
      const folder = toSafeFolderName(meta);
      const recordDir = path.join(sourcePath, table, folder);

      const fields: Record<string, string> = {};
      let metaContent: string | undefined;
      for (const file of meta.files || []) {
        const filePath = path.join(recordDir, fieldKey(file));
        let content: string;
        try {
          content = await fsp.readFile(filePath, "utf8");
        } catch (e) {
          // A manifest file with no on-disk counterpart (partial checkout): skip
          // it rather than fail the whole scope. It simply won't participate in
          // the diff for this record.
          fileLogger.debug("reconcile: missing on-disk field " + filePath);
          continue;
        }
        if (file.name === "metaData" && file.type === "json") {
          metaContent = content;
        }
        if (isComparableField(file)) {
          fields[fieldKey(file)] = content;
        }
      }

      records.push({
        table,
        scope,
        sys_id: meta.sys_id,
        name: meta.name || folder,
        updatedOn: extractUpdatedOn(metaContent),
        fields,
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Live side (instance)
// ---------------------------------------------------------------------------

function buildAllFilesMap(manifest: SN.AppManifest): SN.MissingFileTableMap {
  const result: SN.MissingFileTableMap = {};
  const tables = manifest.tables || {};
  for (const table of Object.keys(tables)) {
    const records = tables[table].records || {};
    const recMap: SN.MissingFileRecord = {};
    for (const key of Object.keys(records)) {
      const rec = records[key];
      if (!rec.files || rec.files.length === 0) {
        continue;
      }
      recMap[rec.sys_id] = rec.files.map((f) => ({ name: f.name, type: f.type }));
    }
    if (Object.keys(recMap).length > 0) {
      result[table] = recMap;
    }
  }
  return result;
}

export async function loadLiveRecords(scope: string): Promise<ReconcileRecord[]> {
  const client = defaultClient();
  const config = ConfigManager.getConfig();

  const liveManifest = applyWhitelist(
    normalizeManifestKeys(await unwrapSNResponse(client.getManifest(scope, config))),
    scope,
  );

  const allFiles = buildAllFilesMap(liveManifest);
  const tableNames = Object.keys(allFiles);
  if (tableNames.length === 0) {
    return [];
  }

  // tableOptions feeds field decoding (e.g. JSON fields). Destructure exactly as
  // the refresh path does so the typed config shape is preserved.
  const { tableOptions = {} } = config;

  const downloaded: SN.TableMap = {};
  for (let i = 0; i < tableNames.length; i += BULK_DOWNLOAD_TABLE_CHUNK_SIZE) {
    const chunkTables = tableNames.slice(i, i + BULK_DOWNLOAD_TABLE_CHUNK_SIZE);
    const chunkMissing: SN.MissingFileTableMap = {};
    for (const t of chunkTables) {
      chunkMissing[t] = allFiles[t];
    }
    const chunkResult = (await unwrapSNResponse(
      client.getMissingFiles(chunkMissing, tableOptions),
    )) as SN.TableMap;
    for (const table of Object.keys(chunkResult)) {
      downloaded[table] = chunkResult[table];
    }
  }

  const records: ReconcileRecord[] = [];
  for (const table of Object.keys(downloaded)) {
    const tableRecords = downloaded[table].records || {};
    for (const key of Object.keys(tableRecords)) {
      const rec = tableRecords[key];
      const fields: Record<string, string> = {};
      let metaContent: string | undefined;
      for (const file of rec.files || []) {
        if (file.name === "metaData" && file.type === "json") {
          metaContent = file.content;
        }
        if (isComparableField(file)) {
          fields[fieldKey(file)] = file.content || "";
        }
      }
      records.push({
        table,
        scope,
        sys_id: rec.sys_id,
        name: rec.name || toSafeFolderName(rec),
        updatedOn: extractUpdatedOn(metaContent),
        fields,
      });
    }
  }
  return records;
}
