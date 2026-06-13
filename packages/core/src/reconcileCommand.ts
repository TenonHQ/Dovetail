// `dove reconcile` — make a developer's personal ServiceNow instance match the
// git branch they just checked out: the deliberate, diff-gated inverse of
// `dove watch`. THIS BUILD IS PHASE 1: read-only. It snapshots the branch
// (on-disk) and the live instance, classifies every tracked record into
// create / update / delete, surfaces drift (the dev's own edits since
// baseline), reports schema drift (report-only — a ServiceNow ceiling), and
// prints a grouped, deep-linked dry-run report. It writes nothing.
//
// The apply phases (record UPDATE/DELETE in Phase 2, CREATE in Phase 3) land in
// follow-up Draft PRs; an `--apply` / `CONFIRM=1` invocation is rejected here
// with a clear "not in this build" notice so the surface is forward-compatible
// without ever performing an unimplemented write.

import { Sinc, TSFIXME } from "@tenonhq/dovetail-types";
import path from "path";
import os from "os";
import { promises as fsp } from "fs";
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
import { loadBranchRecords, loadLiveRecords } from "./reconcile/recordSource";
import { diffRecords } from "./reconcile/recordDiff";
import { readBaseline, baselineSysIds, computeDirty } from "./reconcile/baseline";
import { formatReconcileReport, ReconcileScopeResult } from "./reconcile/report";
import { ReconcileRecord } from "./reconcile/types";

const execFileAsync = promisify(execFile);

interface ReconcileArgs {
  scope?: string;
  schema?: boolean;
  apply?: boolean;
  logLevel: string;
}

interface Creds {
  SN_USER: string;
  SN_PASSWORD: string;
  SN_INSTANCE: string;
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
    const { stdout } = await execFileAsync("git", [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    return stdout.trim();
  } catch (e) {
    return "";
  }
}

// Best-effort schema arm: only runs when a snapshot exists for this instance.
// Returns a per-scope SchemaDiff map plus a skip reason when it could not run.
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

export async function reconcileCommand(args: TSFIXME): Promise<void> {
  setLogLevel(args as Sinc.SharedCmdArgs);
  const typedArgs = args as ReconcileArgs;

  if (typedArgs.apply || process.env.CONFIRM === "1") {
    logger.warn(
      "reconcile apply is not available in this build. This is Phase 1 " +
        "(read-only diff + report); record UPDATE/DELETE (Phase 2) and CREATE " +
        "(Phase 3) ship in follow-up releases. Showing the dry-run report only.",
    );
  }

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

  const scopeResults: ReconcileScopeResult[] = [];
  for (const scope of scopes) {
    logger.info("Reconciling scope: " + scope + " (read-only)...");
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
}
