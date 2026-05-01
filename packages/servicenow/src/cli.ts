#!/usr/bin/env node
/**
 * sinc-sn — thin CLI adapter for @tenonhq/dovetail-servicenow.
 *
 * Usage:
 *   sinc-sn add-choices \
 *     --table x_cadso_core_event \
 *     --column state \
 *     --update-set <sys_id> \
 *     --choices 'delivered=Delivered,failed=Failed,...' \
 *     [--choice-type 3] [--json]
 *
 *   sinc-sn add-choices --from-json path/to/choices.json
 *
 * JSON payload shape:
 *   {
 *     "table": "x_cadso_core_event",
 *     "column": "state",
 *     "updateSetSysId": "...",
 *     "choiceType": 3,
 *     "choices": [{ "value": "delivered", "label": "Delivered" }, ...]
 *   }
 */

import * as fs from "fs";
import { createClient } from "./client";
import { addChoicesToField } from "./choices";
import { formatAddChoicesResult } from "./formatter";
import { runBuildFlow } from "./flowDesigner/buildFlowOrchestrator";
import { formatBuildFlowResult } from "./flowDesigner-formatter";
import type { AddChoicesParams, ChoiceValue } from "./types";

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

function parseArgs(argv: Array<string>): ParsedArgs {
  var command = argv[0] || "";
  var flags: Record<string, string> = {};
  for (var i = 1; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg.indexOf("--") !== 0) continue;
    var key = arg.slice(2);
    var value = "true";
    var eq = key.indexOf("=");
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && argv[i + 1].indexOf("--") !== 0) {
      value = argv[i + 1];
      i += 1;
    }
    flags[key] = value;
  }
  return { command: command, flags: flags };
}

function parseChoicesInline(input: string): Array<ChoiceValue> {
  return input.split(",").map(function (pair) {
    var parts = pair.split("=");
    if (parts.length !== 2) {
      throw new Error("Invalid --choices entry '" + pair + "' (expected value=Label)");
    }
    return { value: parts[0].trim(), label: parts[1].trim() };
  });
}

function paramsFromFlags(flags: Record<string, string>): AddChoicesParams {
  if (flags["from-json"]) {
    var raw = fs.readFileSync(flags["from-json"], "utf8");
    var obj = JSON.parse(raw);
    return obj as AddChoicesParams;
  }
  var table = flags.table;
  var column = flags.column;
  var updateSetSysId = flags["update-set"] || flags.updateSetSysId;
  var choicesInline = flags.choices;
  if (!table || !column || !updateSetSysId || !choicesInline) {
    throw new Error("Missing required flags: --table, --column, --update-set, --choices");
  }
  var params: AddChoicesParams = {
    table: table,
    column: column,
    updateSetSysId: updateSetSysId,
    choices: parseChoicesInline(choicesInline)
  };
  if (flags["choice-type"]) {
    params.choiceType = Number(flags["choice-type"]) as 0 | 1 | 3;
  }
  return params;
}

async function runAddChoices(flags: Record<string, string>): Promise<void> {
  var params = paramsFromFlags(flags);
  var client = createClient({});
  var result = await addChoicesToField(client, params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify({ params: params, result: result }, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatAddChoicesResult(params.table, params.column, result) + "\n");
}

/**
 * sinc-sn build-flow:
 *   --from-json <path>      Required. JSON spec for the artifact (clone | create).
 *   --update-set <sys_id>   Optional. Overrides spec.updateSetSysId at the CLI level.
 *   --dry-run               Optional. Emit the planned write graph; do nothing.
 *   --skip-publish          Optional. Skip the publish trigger entirely.
 *   --json                  Optional. Emit the structured BuildFlowResult instead of human text.
 *
 * Exit codes (mirror BuildFlowResult.outcome):
 *   0 — done OR unchanged OR dry-run
 *   2 — needs-ui-publish (writes ok, verify ok, publish degraded)
 *   3 — verify-mismatch  (writes ok but verify saw counts that don't match)
 *   4 — write-failed     (partial state in update set; discard to roll back)
 *   5 — unrecoverable    (spec or auth bug; never reached SN)
 */
async function runBuildFlowCmd(flags: Record<string, string>): Promise<number> {
  if (!flags["from-json"]) {
    process.stderr.write("build-flow: --from-json <path> is required\n");
    return 5;
  }
  var raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(flags["from-json"], "utf8"));
  } catch (err: any) {
    process.stderr.write("build-flow: failed to read/parse spec file: " + err.message + "\n");
    return 5;
  }
  if (flags["update-set"] && raw && typeof raw === "object") {
    (raw as Record<string, unknown>).updateSetSysId = flags["update-set"];
  }
  var client = createClient({});
  var result = await runBuildFlow(client, raw, {
    dryRun: flags["dry-run"] === "true",
    skipPublish: flags["skip-publish"] === "true",
  });
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatBuildFlowResult(result) + "\n");
  }
  return result.exitCode;
}

function printHelp(): void {
  process.stdout.write(
    "sinc-sn — ServiceNow helpers\n\n" +
    "Commands:\n" +
    "  add-choices   Upsert sys_choice rows for a table.column\n" +
    "  build-flow    Author Custom Action Types and Subflows from a JSON spec\n" +
    "                (--from-json <path> [--update-set <sys_id>] [--dry-run] [--skip-publish] [--json])\n"
  );
}

async function main(): Promise<number> {
  var parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "add-choices") {
    await runAddChoices(parsed.flags);
    return 0;
  }
  if (parsed.command === "build-flow") {
    return await runBuildFlowCmd(parsed.flags);
  }
  if (!parsed.command || parsed.command === "help" || parsed.flags.help === "true") {
    printHelp();
    return 0;
  }
  throw new Error("Unknown command: " + parsed.command);
}

main()
  .then(function (code) {
    process.exit(code);
  })
  .catch(function (err) {
    process.stderr.write("sinc-sn error: " + (err && err.message ? err.message : String(err)) + "\n");
    process.exit(1);
  });
