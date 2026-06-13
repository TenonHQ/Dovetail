// `dove reconcile` — make a developer's personal ServiceNow instance match the
// git branch they just checked out: the deliberate, diff-gated inverse of
// `dove watch`.
//
// Modes:
//   (default)          read-only dry run — snapshot branch (on-disk) + live
//                      instance, classify create/update/delete, surface drift,
//                      report schema drift (report-only), print the report.
//   --write-baseline   establish the per-instance merge-base from current live
//                      state (no record changes). Run this once before --apply.
//   --apply [--force]  apply records branch -> instance: CREATE net-new (with
//                      the branch's own sys_id, which the server honors),
//                      UPDATE changed records, DELETE tracked instance-only
//                      records. Refuses if the instance drifted since baseline
//                      (unless --force). Schema stays report-only (a SN ceiling).
//                      Updates for a scope with no configured update set are
//                      skipped, not pushed — a raw PATCH would re-parent scope.

import { Sinc, TSFIXME } from "@tenonhq/dovetail-types";
import path from "path";
import os from "os";
import fs, { promises as fsp } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  pullSchema,
  listSnapshots,
  resolveSnapshotDir,
  readSchemaTree,
  diffSchemas,
  SchemaDiff,
} from "@tenonhq/dovetail-schema";
import { logger } from "./Logger";
import { fileLogger } from "./FileLogger";
import { setLogLevel } from "./commands";
import * as ConfigManager from "./config";
import { defaultClient } from "./snClient";
import { getAppFileList, pushFiles } from "./appUtils";
import { getUpdateSetsConfigPath } from "./projectFiles";
import { loadBranchRecords, loadLiveRecords } from "./reconcile/recordSource";
import { diffRecords } from "./reconcile/recordDiff";
import { isComparableField } from "./reconcile/fields";
import {
  readBaseline,
  baselineSysIds,
  computeDirty,
  writeBaseline,
  baselineFromLive,
  BASELINE_FILENAME,
} from "./reconcile/baseline";
import { formatReconcileReport, ReconcileScopeResult } from "./reconcile/report";
import { buildApplyPlan, ApplyPlan } from "./reconcile/applyPlan";
import { runMultiPassOps, OpOutcome } from "./reconcile/multiPass";
import { ensureGitignored } from "./reconcile/gitignore";
import { DirtyRecord, ReconcileRecord, RecordChange, RecordDiff } from "./reconcile/types";

interface UpdateSetSelection {
  sys_id: string;
  name: string;
}

// Per-scope update-set routing, read from the same .dove-update-sets.json the
// push pipeline uses. Missing/parse errors degrade to {} (treated as "no update
// set configured"), never throw.
function getUpdateSetConfig(): Record<string, UpdateSetSelection> {
  try {
    const configPath = getUpdateSetsConfigPath();
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, UpdateSetSelection>;
      }
    }
  } catch (e) {
    fileLogger.debug("reconcile: could not read update-set config");
  }
  return {};
}

const execFileAsync = promisify(execFile);

interface ReconcileArgs {
  scope?: string;
  schema?: boolean;
  apply?: boolean;
  force?: boolean;
  writeBaseline?: boolean;
  logLevel: string;
}

interface Creds {
  SN_USER: string;
  SN_PASSWORD: string;
  SN_INSTANCE: string;
}

interface ScopeData {
  scope: string;
  live: ReconcileRecord[];
  diff: RecordDiff;
  dirty: DirtyRecord[];
}

function requireCreds(): Creds {
  const { SN_USER = "", SN_PASSWORD = "", SN_INSTANCE = "" } = process.env;
  if (!SN_USER || !SN_PASSWORD || !SN_INSTANCE) {
    throw new Error(
      "Missing ServiceNow credentials. Ensure SN_INSTANCE, SN_USER, and SN_PASSWORD are set in your .env file or environment.",
    );
  }
  return { SN_USER, SN_PASSWORD, SN_INSTANCE };
}

function normalizeInstance(instance: string): string {
  return instance.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function resolveScopes(args: ReconcileArgs): string[] {
  const config = ConfigManager.getConfig();
  const configScopes = config.scopes ? Object.keys(config.scopes) : [];
  if (configScopes.length === 0) {
    throw new Error(
      "No scopes configured in dove.config.js. Add scopes to the 'scopes' object in your configuration.",
    );
  }
  if (args.scope) {
    if (configScopes.indexOf(args.scope) === -1) {
      throw new Error(
        'Scope "' +
          args.scope +
          '" is not configured in dove.config.js. Available scopes: ' +
          configScopes.join(", "),
      );
    }
    return [args.scope];
  }
  return configScopes;
}

async function currentBranch(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout.trim();
  } catch (e) {
    return "";
  }
}

// Best-effort schema arm: only runs when a snapshot exists for this instance.
async function buildSchemaDiffs(options: {
  creds: Creds;
  instance: string;
  scopes: string[];
}): Promise<{ diffs: Record<string, SchemaDiff>; skipped: string | null }> {
  const { creds, instance, scopes } = options;
  const rootDir = ConfigManager.getRootDir();
  const outputDir = path.join(rootDir, "schema");

  let snapshots: { dir: string }[] = [];
  try {
    snapshots = await listSnapshots({ outputDir, instance });
  } catch (e) {
    return { diffs: {}, skipped: "schema snapshot lookup failed" };
  }
  if (snapshots.length === 0) {
    return {
      diffs: {},
      skipped:
        "no schema snapshot for " +
        instance +
        " — run `dove schema pull --snapshot <label>` to include schema drift",
    };
  }

  const fromRef = path.basename(snapshots[0].dir);
  let liveDir: string;
  try {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dove-reconcile-schema-"));
    await pullSchema({
      instance: creds.SN_INSTANCE,
      username: creds.SN_USER,
      password: creds.SN_PASSWORD,
      outputDir: tmpDir,
      scopes,
    });
    liveDir = tmpDir;
  } catch (e) {
    return { diffs: {}, skipped: "live schema pull failed" };
  }

  const fromDir = await resolveSnapshotDir({ ref: fromRef, outputDir, instance });
  const diffs: Record<string, SchemaDiff> = {};
  for (const scope of scopes) {
    try {
      const from = await readSchemaTree({ dir: fromDir, scope });
      const to = await readSchemaTree({ dir: liveDir, scope });
      diffs[scope] = diffSchemas({ from, to, fromRef, toRef: "live", scope });
    } catch (e) {
      fileLogger.debug("reconcile: schema diff failed for scope " + scope);
    }
  }
  return { diffs, skipped: null };
}

// Collect the on-disk field file paths for the records an apply will UPDATE, so
// the existing build + update-set push pipeline can overwrite the instance with
// branch content.
async function collectUpdateFilePaths(
  scope: string,
  updates: RecordChange[],
): Promise<string[]> {
  const sourcePath = ConfigManager.getSourcePathForScope(scope);
  const paths: string[] = [];
  for (const change of updates) {
    const recordDir = path.join(sourcePath, change.table, change.name);
    let entries: string[];
    try {
      entries = await fsp.readdir(recordDir);
    } catch (e) {
      fileLogger.debug("reconcile: update record dir missing " + recordDir);
      continue;
    }
    for (const entry of entries) {
      if (entry === "metaData.json") {
        continue;
      }
      const full = path.join(recordDir, entry);
      try {
        const stat = await fsp.stat(full);
        if (stat.isFile()) {
          paths.push(full);
        }
      } catch (e) {
        // ignore unreadable entry
      }
    }
  }
  return paths;
}

async function applyUpdates(
  scope: string,
  updates: RecordChange[],
): Promise<{ pushed: number; failures: string[] }> {
  if (updates.length === 0) {
    return { pushed: 0, failures: [] };
  }
  const paths = await collectUpdateFilePaths(scope, updates);
  if (paths.length === 0) {
    return { pushed: 0, failures: [] };
  }
  const recs = await getAppFileList(paths);
  const results = await pushFiles(recs);
  const failures: string[] = [];
  let pushed = 0;
  for (const result of results) {
    if (result.success) {
      pushed++;
    } else {
      failures.push(result.message);
    }
  }
  return { pushed, failures };
}

async function applyDeletes(
  scope: string,
  deletes: RecordChange[],
): Promise<OpOutcome[]> {
  if (deletes.length === 0) {
    return [];
  }
  const client = defaultClient();
  return runMultiPassOps(deletes, async (change) => {
    try {
      const response = await client.deleteRecord({
        table: change.table,
        sys_id: change.sys_id,
        scope,
      });
      let data = response.data as TSFIXME;
      if (data && data.result) {
        data = data.result;
      }
      if (data && (data.error || data.success === false)) {
        return { ok: false, error: data.error || "delete rejected" };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// Reconstruct the full field set for a CREATE from the record's on-disk
// representation: the metaData.json snapshot supplies every captured field
// value, then the canonical field files (script.js, etc.) override their own
// fields. Volatile bookkeeping and identity columns are excluded — sys_id is
// passed separately (and honored by the server), sys_scope comes from `scope`.
async function buildCreateFields(
  scope: string,
  change: RecordChange,
): Promise<Record<string, string>> {
  const sourcePath = ConfigManager.getSourcePathForScope(scope);
  const recordDir = path.join(sourcePath, change.table, change.name);
  const fields: Record<string, string> = {};

  // 1. metaData snapshot — short/non-file fields (active, order, name, ...).
  try {
    const metaRaw = await fsp.readFile(path.join(recordDir, "metaData.json"), "utf8");
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;
    for (const key of Object.keys(meta)) {
      if (key.charAt(0) === "_" || key === "sys_id" || key === "sys_scope") {
        continue;
      }
      if (key.indexOf("sys_") === 0) {
        // sys_created_on/by, sys_updated_on/by, sys_mod_count, sys_class_name, ...
        // Skipped: server-managed. (sys_class_name on a base table defaults fine.)
        continue;
      }
      const value = meta[key];
      if (typeof value === "string") {
        fields[key] = value;
      } else if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as Record<string, unknown>).value === "string"
      ) {
        fields[key] = (value as Record<string, string>).value;
      }
    }
  } catch (e) {
    fileLogger.debug("reconcile: no metaData for create " + recordDir);
  }

  // 2. Canonical field files override (the authoritative large-field content).
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(recordDir);
  } catch (e) {
    fileLogger.debug("reconcile: create record dir missing " + recordDir);
  }
  for (const entry of entries) {
    if (entry === "metaData.json") {
      continue;
    }
    const dot = entry.lastIndexOf(".");
    if (dot <= 0) {
      continue;
    }
    const name = entry.slice(0, dot);
    const type = entry.slice(dot + 1);
    if (!isComparableField({ name, type })) {
      continue;
    }
    try {
      const stat = await fsp.stat(path.join(recordDir, entry));
      if (stat.isFile()) {
        fields[name] = await fsp.readFile(path.join(recordDir, entry), "utf8");
      }
    } catch (e) {
      // ignore unreadable entry
    }
  }

  // Ensure a name is present (some tables require it).
  if (!fields.name && change.name) {
    fields.name = change.name;
  }
  return fields;
}

async function applyCreates(
  scope: string,
  creates: RecordChange[],
  updateSetSysId: string | undefined,
): Promise<OpOutcome[]> {
  if (creates.length === 0) {
    return [];
  }
  const client = defaultClient();
  return runMultiPassOps(creates, async (change) => {
    try {
      const fields = await buildCreateFields(scope, change);
      const response = await client.createRecord({
        table: change.table,
        fields,
        sys_id: change.sys_id,
        scope,
        update_set_sys_id: updateSetSysId,
      });
      let data = response.data as TSFIXME;
      if (data && data.result) {
        data = data.result;
      }
      if (data && data.error) {
        return { ok: false, error: data.error };
      }
      if (data && data.sys_id && data.sys_id !== change.sys_id) {
        // The server reassigned the sys_id — identity would diverge and the
        // diff would never converge. Surface it loudly rather than silently
        // creating a phantom.
        return {
          ok: false,
          error: "server reassigned sys_id (" + data.sys_id + " != " + change.sys_id + ")",
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// Capture current live state across every scope into a fresh baseline + ensure
// the baseline file is gitignored in the consumer project.
async function recaptureBaseline(options: {
  rootDir: string;
  instance: string;
  scopes: string[];
}): Promise<number> {
  const all: ReconcileRecord[] = [];
  for (const scope of options.scopes) {
    try {
      const live = await loadLiveRecords(scope);
      for (const record of live) {
        all.push(record);
      }
    } catch (e) {
      logger.warn("Baseline capture failed for scope " + scope + " — skipped.");
    }
  }
  writeBaseline(options.rootDir, baselineFromLive(options.instance, all));
  const update = ensureGitignored(options.rootDir, BASELINE_FILENAME);
  if (update.changed) {
    logger.info("Added " + BASELINE_FILENAME + " to .gitignore.");
  }
  return all.length;
}

async function writeBaselineMode(options: {
  rootDir: string;
  instance: string;
  scopes: string[];
}): Promise<void> {
  logger.info("Establishing reconcile baseline for " + options.instance + "...");
  const count = await recaptureBaseline(options);
  logger.success(
    "Baseline established: " + count + " record(s) captured to " + BASELINE_FILENAME + ".",
  );
}

export async function reconcileCommand(args: TSFIXME): Promise<void> {
  setLogLevel(args as Sinc.SharedCmdArgs);
  const typedArgs = args as ReconcileArgs;

  let creds: Creds;
  try {
    creds = requireCreds();
  } catch (e) {
    logger.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }

  const instance = normalizeInstance(creds.SN_INSTANCE);
  const scopes = resolveScopes(typedArgs);
  const rootDir = ConfigManager.getRootDir();

  // --write-baseline: establish the merge-base and stop.
  if (typedArgs.writeBaseline) {
    await writeBaselineMode({ rootDir, instance, scopes });
    return;
  }

  const branchRef = await currentBranch();
  const baseline = readBaseline(rootDir, instance);
  const baselineIds = baselineSysIds(baseline);

  // Schema arm is on by default; --no-schema disables it.
  let schemaDiffs: Record<string, SchemaDiff> = {};
  let schemaSkippedReason: string | null = null;
  if (typedArgs.schema === false) {
    schemaSkippedReason = "schema diff disabled (--no-schema)";
  } else {
    const schemaResult = await buildSchemaDiffs({ creds, instance, scopes });
    schemaDiffs = schemaResult.diffs;
    schemaSkippedReason = schemaResult.skipped;
  }

  const scopeData: ScopeData[] = [];
  const scopeResults: ReconcileScopeResult[] = [];
  for (const scope of scopes) {
    logger.info("Reconciling scope: " + scope + "...");
    let branch: ReconcileRecord[];
    let live: ReconcileRecord[];
    try {
      branch = await loadBranchRecords(scope);
      live = await loadLiveRecords(scope);
    } catch (e) {
      logger.error(
        "Failed to load records for scope " +
          scope +
          ": " +
          (e instanceof Error ? e.message : String(e)),
      );
      continue;
    }

    const diff = diffRecords({ branch, live, baselineSysIds: baselineIds });
    const dirty = computeDirty({ baseline, live });

    scopeData.push({ scope, live, diff, dirty });
    scopeResults.push({
      scope,
      diff,
      dirty,
      hasBaseline: baseline !== null,
      schema: schemaDiffs[scope] || null,
    });
  }

  const report = formatReconcileReport({
    instanceHost: instance,
    branchRef,
    scopes: scopeResults,
    schemaSkippedReason,
  });
  // console.log so the report's own layout survives the winston line-wrapper.
  console.log(report);

  if (!typedArgs.apply) {
    return;
  }

  await applyMode({ typedArgs, scopeData, baseline: baseline !== null, rootDir, instance, scopes });
}

async function applyMode(options: {
  typedArgs: ReconcileArgs;
  scopeData: ScopeData[];
  baseline: boolean;
  rootDir: string;
  instance: string;
  scopes: string[];
}): Promise<void> {
  const { typedArgs, scopeData } = options;
  const force = typedArgs.force === true;

  const plans: { scope: string; plan: ApplyPlan }[] = scopeData.map((data) => ({
    scope: data.scope,
    plan: buildApplyPlan({
      diff: data.diff,
      dirty: data.dirty,
      hasBaseline: options.baseline,
      force,
    }),
  }));

  const refused = plans.filter((entry) => entry.plan.refuse);
  if (refused.length > 0) {
    logger.error("Apply refused:");
    for (const entry of refused) {
      logger.error("  [" + entry.scope + "] " + entry.plan.refuseReason);
    }
    process.exitCode = 1;
    return;
  }

  logger.info("");
  logger.info("Applying reconcile (branch -> instance)...");

  const updateSetConfig = getUpdateSetConfig();
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  const failures: string[] = [];

  for (const entry of plans) {
    const { scope, plan } = entry;
    const updateSet = updateSetConfig[scope];
    const updateSetSysId = updateSet ? updateSet.sys_id : undefined;

    // CREATE — scope-correct via the `scope` param; routed into the update set
    // when one is configured.
    const createOutcomes = await applyCreates(scope, plan.creates, updateSetSysId);
    for (const outcome of createOutcomes) {
      if (outcome.ok) {
        totalCreated++;
      } else {
        failures.push(
          "[" + scope + "] create " + outcome.change.table + "/" + outcome.change.name + ": " + (outcome.error || "failed"),
        );
      }
    }

    // UPDATE — guard against the re-parenting trap: pushFiles falls back to a
    // raw PATCH (which adopts session scope) when no update set is configured.
    // Refuse to push updates for such a scope rather than silently re-parent.
    if (plan.updates.length > 0 && !updateSetSysId) {
      failures.push(
        "[" +
          scope +
          "] " +
          plan.updates.length +
          " update(s) skipped — no update set configured for this scope. " +
          "Set one (e.g. `dove switchUpdateSet`) before applying updates, to avoid re-parenting scope.",
      );
    } else {
      const updateResult = await applyUpdates(scope, plan.updates);
      totalUpdated += updateResult.pushed;
      for (const failure of updateResult.failures) {
        failures.push("[" + scope + "] update: " + failure);
      }
    }

    // DELETE — tracked instance-only records.
    const deleteOutcomes = await applyDeletes(scope, plan.deletes);
    for (const outcome of deleteOutcomes) {
      if (outcome.ok) {
        totalDeleted++;
      } else {
        failures.push(
          "[" + scope + "] delete " + outcome.change.table + "/" + outcome.change.name + ": " + (outcome.error || "failed"),
        );
      }
    }
  }

  // Re-capture the baseline from the now-converged instance.
  await recaptureBaseline({
    rootDir: options.rootDir,
    instance: options.instance,
    scopes: options.scopes,
  });

  logger.info("");
  logger.success(
    "Applied: " +
      totalCreated +
      " created, " +
      totalUpdated +
      " updated, " +
      totalDeleted +
      " deleted.",
  );
  if (failures.length > 0) {
    logger.error(failures.length + " operation(s) failed:");
    for (const failure of failures) {
      logger.error("  " + failure);
    }
    process.exitCode = 1;
  }
}
