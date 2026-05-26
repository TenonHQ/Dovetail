#!/usr/bin/env node
/**
 * dove-claude-plans CLI. Subcommands:
 *   mcp [--smoke]        run MCP stdio server (used by .mcp.json)
 *   list [--status X]    list plans newest-first
 *   exit <slug>          flip a single plan to EXITED
 *   exit-stale [--quiet] flip every DRAFT plan to EXITED (used by Claude Stop hook)
 *   where                print the storage root path
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import { listPlans, storageRoot, updatePlanStatus } from "./storage";
import { runSmoke, runStdio } from "./server";
import { ClaudePlan, PlanStatus } from "./types";
import { extractCategories } from "./categories";

function arg(name: string): string | undefined {
  var i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.indexOf(name) !== -1;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: dove-claude-plans <command> [options]",
      "",
      "Commands:",
      "  mcp [--smoke]         Run MCP stdio server",
      "  list [--status X]     List plans newest-first (X: DRAFT|APPROVED|EXITED)",
      "  exit <slug>           Flip a single plan to EXITED",
      "  exit-stale [--quiet]  Flip every DRAFT plan to EXITED",
      "  recategorize [--dry]  Re-extract topic categories on every plan",
      "  where                 Print the storage root path",
      ""
    ].join("\n")
  );
}

async function cmdMcp(): Promise<void> {
  if (hasFlag("--smoke")) {
    await runSmoke();
    return;
  }
  await runStdio();
}

async function cmdList(): Promise<void> {
  var status = arg("--status") as PlanStatus | undefined;
  var plans = listPlans({ status: status });
  if (plans.length === 0) {
    process.stdout.write("(no plans)\n");
    return;
  }
  for (var i = 0; i < plans.length; i++) {
    var p = plans[i];
    process.stdout.write(p.status.padEnd(9) + " " + p.slug + "  " + p.title + "\n");
  }
}

async function cmdExit(slug: string | undefined): Promise<void> {
  if (!slug) {
    process.stderr.write("usage: dove-claude-plans exit <slug>\n");
    process.exit(2);
    return;
  }
  var next = updatePlanStatus(slug, "EXITED");
  process.stdout.write("exited: " + next.slug + "\n");
}

async function cmdExitStale(): Promise<void> {
  var quiet = hasFlag("--quiet");
  var drafts = listPlans({ status: "DRAFT" });
  var exited = 0;
  for (var i = 0; i < drafts.length; i++) {
    try {
      updatePlanStatus(drafts[i].slug, "EXITED");
      exited++;
    } catch (err) {
      if (!quiet) {
        var msg = err instanceof Error ? err.message : String(err);
        process.stderr.write("warn: " + drafts[i].slug + ": " + msg + "\n");
      }
    }
  }
  if (!quiet) process.stdout.write("exited " + exited + " stale draft(s)\n");
}

async function cmdWhere(): Promise<void> {
  process.stdout.write(storageRoot() + "\n");
}

/**
 * Re-extract topic categories on every plan in the storage root and write
 * them back atomically. Idempotent: a second run produces no further writes.
 *
 * --dry mode prints what would change without writing.
 */
async function cmdRecategorize(): Promise<void> {
  var dry = hasFlag("--dry");
  var root = storageRoot();
  if (!fs.existsSync(root)) {
    process.stdout.write("(no plans directory at " + root + ")\n");
    return;
  }
  var entries = fs.readdirSync(root);
  var updated = 0;
  var skipped = 0;
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i];
    if (!name.endsWith(".json")) continue;
    var filePath = path.join(root, name);
    var raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      continue;
    }
    var plan: ClaudePlan;
    try {
      plan = JSON.parse(raw) as ClaudePlan;
    } catch (err) {
      continue;
    }
    var next = extractCategories({
      title: plan.title,
      content_md: plan.content_md,
      content_html: plan.content_html
    });
    var prior = plan.categories || [];
    if (sameArray(prior, next)) {
      skipped++;
      continue;
    }
    if (dry) {
      process.stdout.write(
        plan.slug + ": [" + prior.join(", ") + "] -> [" + next.join(", ") + "]\n"
      );
    } else {
      plan.categories = next;
      var tmp = filePath + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
      fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
      fs.renameSync(tmp, filePath);
    }
    updated++;
  }
  process.stdout.write(
    (dry ? "[dry] " : "") +
      "recategorized " +
      updated +
      " plan(s); " +
      skipped +
      " already current\n"
  );
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main(): Promise<void> {
  var cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }
  if (cmd === "mcp") return cmdMcp();
  if (cmd === "list") return cmdList();
  if (cmd === "exit") return cmdExit(process.argv[3]);
  if (cmd === "exit-stale") return cmdExitStale();
  if (cmd === "recategorize") return cmdRecategorize();
  if (cmd === "where") return cmdWhere();

  process.stderr.write("unknown command: " + cmd + "\n");
  printUsage();
  process.exit(2);
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write(
      "dove-claude-plans fatal: " + (err && err.message ? err.message : String(err)) + "\n"
    );
    process.exit(1);
  });
}
