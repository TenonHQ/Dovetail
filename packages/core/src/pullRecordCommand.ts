/**
 * `dove pull <table> <sysId...>` — the per-record form of pull. See
 * pullRecord.ts for the engine; this file is the CLI surface: argument
 * normalization, the dry-run report, and the summary.
 *
 * A bare `dove pull` (no table, no --from-update-set) is still the historic
 * alias of `dove refresh`; commander.ts routes that case before reaching here.
 */

import { Sinc } from "@tenonhq/dovetail-types";
import path from "path";
import chalk from "chalk";
import { logger } from "./Logger";
import { fileLogger } from "./FileLogger";
import { setLogLevel } from "./commands";
import * as ConfigManager from "./config";
import {
  applyPull,
  assertTableName,
  normalizeSysIds,
  planPull,
  PlannedRecord,
  PullPlan,
  PullTarget,
  targetsFromUpdateSet,
} from "./pullRecord";

export interface PullRecordCmdArgs extends Sinc.SharedCmdArgs {
  table?: string;
  /** Positional `[sysId..]` — yargs collects the variadic into an array. */
  sysId?: string[] | string;
  /** `--sys-ids a,b,c` (yargs camel-cases it; keep both spellings). */
  sysIds?: string[] | string;
  "sys-ids"?: string[] | string;
  fromUpdateSet?: string;
  scope?: string;
  force?: boolean;
  dryRun?: boolean;
  /** A stray `-t` from the refresh spelling — caught so it never silently no-ops. */
  t?: unknown;
}

function relToRoot(p: string): string {
  try {
    return path.relative(ConfigManager.getRootDir(), p) || ".";
  } catch (e) {
    return p;
  }
}

function describeRecord(rec: PlannedRecord, dryRun: boolean): string[] {
  const lines: string[] = [];
  const verb = dryRun ? "would write" : "wrote";
  lines.push(
    chalk.bold(rec.table) + " " + rec.sysId + "  →  " + chalk.cyan(relToRoot(rec.recordDir) + path.sep) +
    chalk.dim("  [" + rec.scope + "]"),
  );
  for (const f of rec.files) {
    const mark = f.action === "write" ? chalk.green("+") : chalk.dim("=");
    const note = f.action === "write" ? verb : "unchanged";
    lines.push("  " + mark + " " + path.basename(f.path) + chalk.dim("  (" + note + ")"));
  }
  const manifestNote =
    rec.manifestAction === "add" ? "add" : rec.manifestAction === "update" ? "update" : "unchanged";
  lines.push(
    "  " + (rec.manifestAction === "unchanged" ? chalk.dim("=") : chalk.green("~")) +
    " manifest key " + JSON.stringify(rec.key) + chalk.dim("  (" + manifestNote + ")"),
  );
  for (const w of rec.warnings) lines.push("  " + chalk.yellow("!") + " " + w);
  return lines;
}

function report(plan: PullPlan, dryRun: boolean): void {
  for (const rec of plan.records) {
    for (const line of describeRecord(rec, dryRun)) logger.info(line);
  }
  for (const m of plan.manifests) {
    const touched = m.records.filter((r) => r.manifestAction !== "unchanged").length;
    if (touched === 0) continue;
    logger.info(
      (dryRun ? "would splice " : "spliced ") + touched + " entr" + (touched === 1 ? "y" : "ies") +
      " into " + chalk.cyan(relToRoot(m.manifestPath)) + (m.existed ? "" : chalk.dim("  (new file)")),
    );
  }
  for (const w of plan.warnings) logger.warn(w);
}

/**
 * Turn the CLI arguments into pull targets. Positional sys_ids and `--sys-ids`
 * compose; `--from-update-set` expands to the set's per-record captures (and
 * composes with an explicit table + sys_ids too).
 */
export async function collectTargets(args: PullRecordCmdArgs): Promise<{ targets: PullTarget[]; skipped: string[] }> {
  const targets: PullTarget[] = [];
  let skipped: string[] = [];

  const ids = normalizeSysIds(
    ([] as Array<string | undefined>)
      .concat(Array.isArray(args.sysId) ? args.sysId : [args.sysId])
      .concat(Array.isArray(args.sysIds) ? args.sysIds : [args.sysIds])
      .concat(Array.isArray(args["sys-ids"]) ? args["sys-ids"] : [args["sys-ids"]]),
  );
  if (args.table) {
    const table = assertTableName(args.table);
    if (ids.length === 0 && !args.fromUpdateSet) {
      throw new Error(
        "dove pull " + table + ": give at least one sys_id (positional, or --sys-ids a,b,c), " +
        "or use --from-update-set <sys_id>. A bare 'dove pull' is the scope-wide refresh.",
      );
    }
    for (const sysId of ids) targets.push({ table, sysId });
  } else if (ids.length > 0) {
    throw new Error("dove pull: a table name is required before the sys_id(s).");
  }

  if (args.fromUpdateSet) {
    const fromSet = await targetsFromUpdateSet(String(args.fromUpdateSet));
    for (const t of fromSet.targets) targets.push(t);
    skipped = fromSet.skipped;
  }
  return { targets, skipped };
}

export async function pullRecordCommand(args: PullRecordCmdArgs): Promise<void> {
  setLogLevel(args);
  try {
    if (args.t !== undefined && !args.table) {
      throw new Error(
        "dove pull has no -t/--table flag. For a table-narrowed scope refresh use " +
        "'dove refresh -t <table>'; for one record use 'dove pull <table> <sys_id>'.",
      );
    }
    const dryRun = !!args.dryRun;
    const { targets, skipped } = await collectTargets(args);
    for (const s of skipped) logger.warn("skipped " + s);
    if (targets.length === 0) {
      throw new Error("Nothing to pull: no per-record targets resolved.");
    }
    fileLogger.debug(
      "pull: " + targets.length + " target(s), scope=" + (args.scope || "auto") +
      ", force=" + !!args.force + ", dryRun=" + dryRun,
    );

    const plan = await planPull(targets, { scope: args.scope, force: !!args.force });
    if (dryRun) {
      logger.info(chalk.bold("Dry run — nothing written."));
      report(plan, true);
      return;
    }
    const result = await applyPull(plan);
    report(plan, false);
    logger.success(
      "Pulled " + plan.records.length + " record(s): " + result.filesWritten + " file(s) written, " +
      result.filesUnchanged + " unchanged, " + result.manifestsWritten.length + " manifest(s) updated.",
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(message);
    fileLogger.error("pull failed: " + message);
    process.exitCode = 1;
  }
}
