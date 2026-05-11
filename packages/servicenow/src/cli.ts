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

function printHelp(): void {
  process.stdout.write(
    "sinc-sn — ServiceNow helpers\n\n" +
    "Commands:\n" +
    "  add-choices   Upsert sys_choice rows for a table.column (see --help in source)\n"
  );
}

async function main(): Promise<void> {
  var parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "add-choices") {
    await runAddChoices(parsed.flags);
    return;
  }
  if (!parsed.command || parsed.command === "help" || parsed.flags.help === "true") {
    printHelp();
    return;
  }
  throw new Error("Unknown command: " + parsed.command);
}

main().catch(function (err) {
  process.stderr.write("sinc-sn error: " + (err && err.message ? err.message : String(err)) + "\n");
  process.exit(1);
});
