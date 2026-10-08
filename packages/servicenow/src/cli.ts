#!/usr/bin/env node
/**
 * dove-sn — thin CLI adapter for @tenonhq/dovetail-servicenow.
 *
 * Usage:
 *   dove-sn help                 verb index
 *   dove-sn help <verb>          one verb's flags, value formats, write gate, example
 *   dove-sn <verb> --help        same — never loads an env file or builds a client
 *   dove-sn <verb> [flags]
 *
 * Every verb's usage is rendered from VERB_USAGE in ./cliUsage — add the entry there
 * when you add a dispatch site below; cliHelp.test.ts fails on a missing one.
 */

import * as fs from "fs";
import * as path from "path";
import { loadEnvFile } from "./loadEnv";
import {
  formatUnknownVerb,
  formatVerbIndex,
  formatVerbUsage,
  isKnownVerb,
  normalizeVerbInput,
  usageFor,
} from "./cliUsage";
import { createClient } from "./client";
import { resolveRecordFields } from "./fieldsFromJson";
import { addChoicesToField, removeChoicesFromField } from "./choices";
import { formatAddChoicesResult, formatRemoveChoicesResult } from "./formatter";
import { createView } from "./layout/views";
import { setListLayout } from "./layout/listLayout";
import { setFormLayout } from "./layout/formLayout";
import { setRelatedLists } from "./layout/relatedLists";
import { formatLayoutResult, formatCreateViewResult } from "./layout/formatter";
import { runStdio, runSmoke } from "./mcp/server";
import { exportUpdateSet } from "./exportUpdateSet";
import type { ExportMode } from "./exportUpdateSet";
import { exportApp } from "./exportApp";
import { stripSecrets } from "./secrets/stripSecrets";
import { loadSecretRules } from "./secrets/secretRules";
import { removeChoicesFromFieldSchema } from "./mcp/schemas";
import { runBuildFlow } from "./flowDesigner/buildFlowOrchestrator";
import { formatBuildFlowResult } from "./flowDesigner-formatter";
import { readFlow } from "./flowDesigner/readFlow";
import { readActionType } from "./flowDesigner/readActionType";
import { publishFlow } from "./flowDesigner/publishFlow";
import { copyFlow } from "./flowDesigner/copyFlow";
import { createFlow } from "./flowDesigner/createFlow";
import { editFlow } from "./flowDesigner/editFlow";
import { editActionType } from "./flowDesigner/editActionType";
import { cloneActionType } from "./flowDesigner/cloneActionType";
import { defineActionType } from "./flowDesigner/defineActionType";
import type { DefineActionSpec, DefineActionTypeResult } from "./flowDesigner/defineActionType";
import type { StepOps } from "./flowDesigner/stepOps";
import { testFlow } from "./flowDesigner/testFlow";
import {
  createTable,
  addColumn,
  addIndex,
  listIndexes,
  createIndex,
  setColumn,
  setTable,
} from "./table";
import type {
  ColumnSpec,
  CreateTableParams,
  AddColumnParams,
  AddIndexParams,
  CreateIndexParams,
  SetColumnParams,
  ColumnAttributes,
  SetTableParams,
  TableAttributes,
} from "./table";
import { setField } from "./setField";
import type { SetFieldParams } from "./setField";
import { createRecord } from "./createRecord";
import type { CreateRecordParams } from "./createRecord";
import { deleteRecord } from "./deleteRecord";
import type { DeleteRecordParams } from "./deleteRecord";
import { invokeRest, writeInvokeRestResultFile } from "./invokeRest";
import type { InvokeRestParams } from "./invokeRest";
import { publishApp, parsePublishTargets, PUBLISH_TARGETS } from "./publishApp";
import type {
  PublishAppParams,
  PublishAppResult,
  PublishTarget,
} from "./publishApp";
import { hostAssets, formatHostAssetsResult } from "./hostAssets";
import {
  formatReadFlowResult,
  formatReadActionTypeResult,
} from "./flowDesigner-formatter";
import type {
  AddChoicesParams,
  RemoveChoicesParams,
  ChoiceValue,
  CreateViewParams,
  SetListLayoutParams,
  SetFormLayoutParams,
  SetRelatedListsParams,
  HostAssetsParams,
} from "./types";

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  /**
   * Flags that arrived with no value at all (`--label` followed by another flag, or by
   * nothing). They land in `flags` as the string "true", which is right for a boolean and
   * a trap for a string: `--label` with a forgotten value would rename a column to "true".
   * Recorded here so a verb can tell the two apart and refuse.
   */
  bare: Record<string, boolean>;
  /**
   * Non-flag tokens after the command that no flag consumed as its value —
   * `dove-sn help add-choices` carries the verb here.
   */
  positional: Array<string>;
}

export function parseArgs(argv: Array<string>): ParsedArgs {
  // `dove-sn --help` has no verb: a leading flag means an empty command and the
  // flag loop starts at index 0 instead of skipping it.
  var hasCommand = argv.length > 0 && argv[0].indexOf("--") !== 0;
  var command = hasCommand ? argv[0] : "";
  var flags: Record<string, string> = {};
  var bare: Record<string, boolean> = {};
  var positional: Array<string> = [];
  for (var i = hasCommand ? 1 : 0; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg.indexOf("--") !== 0) {
      positional.push(arg);
      continue;
    }
    var key = arg.slice(2);
    var value = "true";
    var isBare = true;
    var eq = key.indexOf("=");
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
      isBare = false;
    } else if (i + 1 < argv.length && argv[i + 1].indexOf("--") !== 0) {
      value = argv[i + 1];
      i += 1;
      isBare = false;
    }
    flags[key] = value;
    if (isBare) bare[key] = true;
  }
  return { command: command, flags: flags, bare: bare, positional: positional };
}

function parseChoicesInline(input: string): Array<ChoiceValue> {
  return input.split(",").map(function (pair) {
    var parts = pair.split("=");
    if (parts.length !== 2) {
      throw new Error(
        "Invalid --choices entry '" + pair + "' (expected value=Label)",
      );
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
    throw new Error(
      "Missing required flags: --table, --column, --update-set, --choices",
    );
  }
  var params: AddChoicesParams = {
    table: table,
    column: column,
    updateSetSysId: updateSetSysId,
    choices: parseChoicesInline(choicesInline),
  };
  if (flags["choice-type"]) {
    params.choiceType = Number(flags["choice-type"]) as 0 | 1 | 3;
  }
  return params;
}

/**
 * A string flag whose value was forgotten arrives as the literal "true" (see
 * ParsedArgs.bare). Booleans legitimately do that, strings never do — so refuse
 * rather than write nonsense. Returns the message to print, or null when clean.
 *
 * The list of string flags is the verb's `stringFlags` in VERB_USAGE — the help and
 * this guard read the same array, so neither can drift from the other.
 */
function bareStringFlagError(
  verb: string,
  bare: Record<string, boolean>,
): string | null {
  var usage = usageFor(verb);
  var stringFlags = usage && usage.stringFlags ? usage.stringFlags : [];
  for (var f = 0; f < stringFlags.length; f += 1) {
    if (bare[stringFlags[f]]) {
      return (
        verb + ": --" + stringFlags[f] + " needs a value (it was given none).\n"
      );
    }
  }
  return null;
}

async function runAddChoices(
  flags: Record<string, string>,
  bare: Record<string, boolean>,
): Promise<number> {
  // `updateSetSysId` is guarded alongside `update-set` because paramsFromFlags accepts
  // both spellings — guarding only the dashed one leaves the alias as a way in.
  var bareErr = bareStringFlagError("add-choices", bare);
  if (bareErr) {
    process.stderr.write(bareErr);
    return 1;
  }
  var params = paramsFromFlags(flags);
  // The flag is parsed for every verb; this verb used to drop it on the floor and WRITE
  // (#296). Threading it here is what makes --dry-run a real plan, not a label.
  if (flags["dry-run"] === "true") {
    params.dryRun = true;
  }
  var client = createClient({});
  var result = await addChoicesToField(client, params);
  if (flags.json === "true") {
    process.stdout.write(
      JSON.stringify({ params: params, result: result }, null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    formatAddChoicesResult(params.table, params.column, result) + "\n",
  );
  return 0;
}

function removeParamsFromFlags(
  flags: Record<string, string>,
): RemoveChoicesParams {
  if (flags["from-json"]) {
    var raw = fs.readFileSync(flags["from-json"], "utf8");
    // Validate rather than cast: the same zod schema the MCP tool parses with, so a
    // malformed spec fails here with a field-level message instead of somewhere
    // downstream as an undefined table name.
    return removeChoicesFromFieldSchema.parse(
      JSON.parse(raw),
    ) as RemoveChoicesParams;
  }
  var table = flags.table;
  var column = flags.column;
  var updateSetSysId = flags["update-set"] || flags.updateSetSysId;
  var valuesInline = flags.values;
  if (!table || !column || !updateSetSysId || !valuesInline) {
    throw new Error(
      "Missing required flags: --table, --column, --update-set, --values",
    );
  }
  var params: RemoveChoicesParams = {
    table: table,
    column: column,
    updateSetSysId: updateSetSysId,
    values: valuesInline
      .split(",")
      .map(function (v) {
        return v.trim();
      })
      .filter(function (v) {
        return v.length > 0;
      }),
  };
  if (flags.language) {
    params.language = flags.language;
  }
  return params;
}

async function runRemoveChoices(
  flags: Record<string, string>,
  bare: Record<string, boolean>,
): Promise<number> {
  // --language matters most here: a bare one makes every lookup key "true::<value>",
  // so every value reports "missing", nothing is written, and the summary still reads
  // like a clean run. That is the silent failure this verb family exists to catch.
  var bareErr = bareStringFlagError("remove-choices", bare);
  if (bareErr) {
    process.stderr.write(bareErr);
    return 1;
  }
  var params = removeParamsFromFlags(flags);
  if (flags["dry-run"] === "true") {
    params.dryRun = true;
  }
  var client = createClient({});
  var result = await removeChoicesFromField(client, params);
  if (flags.json === "true") {
    process.stdout.write(
      JSON.stringify({ params: params, result: result }, null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    formatRemoveChoicesResult(params.table, params.column, result) + "\n",
  );
  return 0;
}

/**
 * dove-sn build-flow:
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
    process.stderr.write(
      "build-flow: failed to read/parse spec file: " + err.message + "\n",
    );
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

/** Split a comma-separated CLI value into a trimmed, non-empty list. */
function splitList(raw: string): Array<string> {
  return raw
    .split(",")
    .map(function (v) {
      return v.trim();
    })
    .filter(function (v) {
      return v !== "";
    });
}

async function runCreateView(flags: Record<string, string>): Promise<void> {
  var params: CreateViewParams = {
    name: flags.name,
    updateSetSysId: flags["update-set"] || flags.updateSetSysId,
  };
  if (!params.name || !params.updateSetSysId) {
    throw new Error("create-view: --name and --update-set are required");
  }
  if (flags.title) {
    params.title = flags.title;
  }
  if (flags.scope) {
    params.scope = flags.scope;
  }
  if (flags["dry-run"] === "true") {
    params.dryRun = true;
  }
  var result = await createView(createClient({}), params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatCreateViewResult(result) + "\n");
}

async function runSetListLayout(flags: Record<string, string>): Promise<void> {
  var params: SetListLayoutParams;
  if (flags["from-json"]) {
    params = JSON.parse(
      fs.readFileSync(flags["from-json"], "utf8"),
    ) as SetListLayoutParams;
  } else {
    var table = flags.table;
    var updateSetSysId = flags["update-set"] || flags.updateSetSysId;
    var columns = flags.columns;
    if (!table || !updateSetSysId || !columns) {
      throw new Error(
        "set-list-layout: --table, --update-set and --columns are required (or use --from-json)",
      );
    }
    params = {
      table: table,
      updateSetSysId: updateSetSysId,
      columns: splitList(columns),
    };
    if (flags.view) {
      params.view = flags.view;
    }
    if (flags.scope) {
      params.scope = flags.scope;
    }
    if (flags.parent) {
      params.parent = flags.parent;
    }
    if (flags.prune === "false") {
      params.prune = false;
    }
  }
  if (flags["dry-run"] === "true") {
    params.dryRun = true;
  }
  var result = await setListLayout(createClient({}), params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatLayoutResult("list layout", result) + "\n");
}

async function runSetFormLayout(flags: Record<string, string>): Promise<void> {
  if (!flags["from-json"]) {
    throw new Error(
      "set-form-layout: --from-json <path> is required (sections are nested — pass a JSON spec)",
    );
  }
  var params = JSON.parse(
    fs.readFileSync(flags["from-json"], "utf8"),
  ) as SetFormLayoutParams;
  if (flags["update-set"]) {
    params.updateSetSysId = flags["update-set"];
  }
  if (flags["dry-run"] === "true") {
    params.dryRun = true;
  }
  var result = await setFormLayout(createClient({}), params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatLayoutResult("form layout", result) + "\n");
}

async function runSetRelatedLists(
  flags: Record<string, string>,
): Promise<void> {
  var params: SetRelatedListsParams;
  if (flags["from-json"]) {
    params = JSON.parse(
      fs.readFileSync(flags["from-json"], "utf8"),
    ) as SetRelatedListsParams;
  } else {
    var table = flags.table;
    var updateSetSysId = flags["update-set"] || flags.updateSetSysId;
    var relatedLists = flags["related-lists"];
    if (!table || !updateSetSysId || !relatedLists) {
      throw new Error(
        "set-related-lists: --table, --update-set and --related-lists are required (or use --from-json)",
      );
    }
    params = {
      table: table,
      updateSetSysId: updateSetSysId,
      relatedLists: splitList(relatedLists),
    };
    if (flags.view) {
      params.view = flags.view;
    }
    if (flags.scope) {
      params.scope = flags.scope;
    }
    if (flags.prune === "false") {
      params.prune = false;
    }
  }
  if (flags["dry-run"] === "true") {
    params.dryRun = true;
  }
  var result = await setRelatedLists(createClient({}), params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatLayoutResult("related lists", result) + "\n");
}

/**
 * dove-sn mcp — run the MCP stdio server. With --smoke, list the registered
 * tools and exit. Otherwise the process stays alive until the transport closes.
 */
/**
 * dove-sn view-flow:
 *   --sys-id <sys_id>   Required. sys_hub_flow sys_id (flow or subflow).
 *   --json              Optional. Emit the structured ReadFlowResult.
 *   --raw               Optional (with --json). Include the full processflow model.
 *
 * Reads the compiled flow headlessly via GET /api/now/processflow/flow/{id} and
 * prints the ordered, nesting-aware step graph + flow variables. Read-only.
 */
async function runViewFlow(flags: Record<string, string>): Promise<number> {
  var sysId = flags["sys-id"] || flags.sysId;
  if (!sysId) {
    process.stderr.write("view-flow: --sys-id <sys_id> is required\n");
    return 1;
  }
  var client = createClient({});
  var result = await readFlow({
    client: client,
    sysId: sysId,
    raw: flags.raw === "true",
  });
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(formatReadFlowResult(result) + "\n");
  return 0;
}

/**
 * dove-sn view-action:
 *   --sys-id <sys_id>   Required. sys_hub_action_type_definition sys_id.
 *   --scope <sys_id>    Required. Application scope (sysparm_transaction_scope).
 *   --json [--raw]      Optional. Structured ReadActionTypeResult / full model.
 *
 * Reads a Custom Action Type's compiled model (identity, inputs, outputs). Read-only.
 */
async function runViewAction(flags: Record<string, string>): Promise<number> {
  var sysId = flags["sys-id"] || flags.sysId;
  var scope = flags.scope || flags.scopeSysId;
  if (!sysId || !scope) {
    process.stderr.write(
      "view-action: --sys-id <sys_id> and --scope <sys_id> are required\n",
    );
    return 1;
  }
  var client = createClient({});
  var result = await readActionType({
    client: client,
    sysId: sysId,
    scopeSysId: scope,
    raw: flags.raw === "true",
  });
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(formatReadActionTypeResult(result) + "\n");
  return 0;
}

/**
 * dove-sn publish-flow:
 *   --sys-id <sys_id>   Required. sys_hub_flow sys_id (flow or subflow) to publish.
 *   --scope <sys_id>    Optional. sysparm_transaction_scope (defaults to the model's scope).
 *   --json              Optional. Emit the structured PublishFlowResult.
 *
 * Compiles the flow's snapshot via POST /api/now/processflow/flow/{id}/snapshot —
 * a WRITE that recompiles the current design. Use the Designer to edit, then this
 * to publish. (For edited content, the library publishFlow accepts a model.)
 */
async function runPublishFlow(flags: Record<string, string>): Promise<number> {
  var sysId = flags["sys-id"] || flags.sysId;
  if (!sysId) {
    process.stderr.write("publish-flow: --sys-id <sys_id> is required\n");
    return 1;
  }
  var params: { client: any; sysId: string; scopeSysId?: string } = {
    client: createClient({}),
    sysId: sysId,
  };
  if (flags.scope || flags.scopeSysId) {
    params.scopeSysId = flags.scope || flags.scopeSysId;
  }
  var result = await publishFlow(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    "Published flow " +
      sysId +
      " (HTTP " +
      result.httpStatus +
      ")" +
      (result.snapshotSysId ? " — snapshot " + result.snapshotSysId : "") +
      "\n",
  );
  return 0;
}

/**
 * dove-sn copy-flow:
 *   --sys-id <sys_id>   Required. Source sys_hub_flow sys_id (flow or subflow).
 *   --name <name>       Required. Name for the copy.
 *   --scope <sys_id>    Optional. Target scope (defaults to the source's scope).
 *   --json              Optional. Emit the structured CopyFlowResult.
 *
 * Copies the flow via the Designer's own Copy endpoint — a complete, faithful
 * clone created as an INACTIVE DRAFT. Publish it with publish-flow when ready.
 * (Do NOT publish + activate a copy of a triggered production flow unless you
 * intend it to fire.)
 */
async function runCopyFlow(flags: Record<string, string>): Promise<number> {
  var sysId = flags["sys-id"] || flags.sysId;
  var name = flags.name;
  if (!sysId || !name) {
    process.stderr.write(
      "copy-flow: --sys-id <sys_id> and --name <name> are required\n",
    );
    return 1;
  }
  var params: any = {
    client: createClient({}),
    sourceSysId: sysId,
    newName: name,
  };
  if (flags.scope || flags.scopeSysId) {
    params.scopeSysId = flags.scope || flags.scopeSysId;
  }
  var result = await copyFlow(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    "Copied to '" +
      result.name +
      "' (sys_id " +
      result.sysId +
      ", scope " +
      result.scopeSysId +
      ") — inactive draft. Publish with: dove-sn publish-flow --sys-id " +
      result.sysId +
      "\n",
  );
  return 0;
}

/**
 * dove-sn create-flow:
 *   --name <name>           Required. Name for the new flow.
 *   --template <sys_id>     Required. Published sys_hub_flow whose trigger+action graph is grafted.
 *   --scope <sys_id>        Required. Target scope (sysparm_transaction_scope).
 *   --internal-name <name>  Optional. internal_name (defaults to a slug of --name).
 *   --description <text>    Optional.
 *   --trigger-table <table> Optional. Patch the trigger's table input (e.g. customer_contact).
 *   --trigger-condition <q> Optional. Patch the trigger's condition (encoded query).
 *   --log-message <text>    Optional. Patch the action's message / short_description.
 *   --dry-run               Optional. Print the plan + template graph counts; write nothing.
 *   --json                  Optional. Emit the structured CreateFlowResult.
 *
 * Creates a NEW flow from scratch and PUBLISHES it: POST /processflow/flow mints an
 * initialised envelope, the template's trigger+action graph is grafted on (ids remapped,
 * values patched), then the snapshot is compiled. The result is a published flow — a
 * published triggered flow can fire on its trigger, so do NOT graft a production send
 * template you don't intend to fire (the result's `active` flag reports whether it's live).
 *
 * Exit codes: 0 published OR dry-run; 2 created-but-not-published (snapshot didn't compile).
 */
async function runCreateFlow(flags: Record<string, string>): Promise<number> {
  var name = flags.name;
  var templateSysId =
    flags.template || flags["template-sys-id"] || flags.templateSysId;
  var scope = flags.scope || flags.scopeSysId;
  if (!name || !templateSysId || !scope) {
    process.stderr.write(
      "create-flow: --name, --template <sys_id> and --scope <sys_id> are required\n",
    );
    return 1;
  }
  var params: any = {
    client: createClient({}),
    name: name,
    templateSysId: templateSysId,
    scopeSysId: scope,
  };
  if (flags["internal-name"] || flags.internalName) {
    params.internalName = flags["internal-name"] || flags.internalName;
  }
  if (flags.description) {
    params.description = flags.description;
  }
  if (flags["trigger-table"] || flags.triggerTable) {
    params.triggerTable = flags["trigger-table"] || flags.triggerTable;
  }
  if (
    flags["trigger-condition"] !== undefined ||
    flags.triggerCondition !== undefined
  ) {
    params.triggerCondition =
      flags["trigger-condition"] !== undefined
        ? flags["trigger-condition"]
        : flags.triggerCondition;
  }
  if (flags["log-message"] || flags.logMessage) {
    params.logMessage = flags["log-message"] || flags.logMessage;
  }
  if (flags["dry-run"] === "true") {
    params.dryRun = true;
  }

  var result = await createFlow(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.status === "dry-run") {
    process.stdout.write(
      "[dry-run] would create '" +
        result.name +
        "' (internal " +
        result.internalName +
        ") in scope " +
        result.scopeSysId +
        " — grafting " +
        result.graph.triggers +
        " trigger + " +
        result.graph.actions +
        " action + " +
        result.graph.logic +
        " logic from template\n",
    );
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] '" +
        result.name +
        "' sys_id " +
        result.sysId +
        (result.snapshotSysId ? " — snapshot " + result.snapshotSysId : "") +
        (result.active === undefined
          ? ""
          : result.active
          ? " — ACTIVE (will fire)"
          : " — inactive") +
        "\n",
    );
  }
  if (result.status === "not-published") {
    return 2;
  }
  return 0;
}

/**
 * dove-sn test-flow:
 *   --sys-id <sys_id>   Required. sys_hub_flow sys_id (flow or subflow).
 *   --execute           Optional. Actually run it (default is validate-only).
 *   --confirm           Required with --execute. A deliberate run-for-real gate.
 *   --inputs <json>     Optional. JSON object of inputs (or --inputs-json <path>).
 *   --json              Optional. Emit the structured TestFlowResult.
 *
 * Default (no --execute) is a safe pre-flight: published? readable? inputs match
 * declared variables? --execute POSTs the FlowAPI runner endpoint (see
 * resources/runFlow.md). Executing a flow can cause real side effects.
 */
async function runTestFlow(flags: Record<string, string>): Promise<number> {
  var sysId = flags["sys-id"] || flags.sysId;
  if (!sysId) {
    process.stderr.write("test-flow: --sys-id <sys_id> is required\n");
    return 1;
  }
  var inputs: Record<string, any> = {};
  if (flags["inputs-json"]) {
    inputs = JSON.parse(fs.readFileSync(flags["inputs-json"], "utf8"));
  } else if (flags.inputs) {
    inputs = JSON.parse(flags.inputs);
  }
  var params: any = {
    client: createClient({}),
    sysId: sysId,
    mode: flags.execute === "true" ? "execute" : "validate",
    inputs: inputs,
    confirm: flags.confirm === "true",
  };
  if (flags.runner) {
    params.runnerPath = flags.runner;
  }
  var result = await testFlow(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write("[" + result.mode + "] ok=" + result.ok + "\n");
  for (var i = 0; i < result.notes.length; i += 1) {
    process.stdout.write("  " + result.notes[i] + "\n");
  }
  return result.ok ? 0 : 2;
}

/**
 * dove-sn edit-flow:
 *   --sys-id <sys_id>     Required. sys_hub_flow sys_id (flow or subflow).
 *   --from-json <path>    Required. JSON EditFlowOps { rename?, description?, patchStepInputs? }.
 *   --apply               Optional. Persist the edit (default is a dry-run diff).
 *   --scope <sys_id>      Optional. sysparm_transaction_scope for the publish.
 *   --update-set <sys_id> Required with --apply when ops include rename/description.
 *   --json                Optional. Emit the structured EditFlowResult.
 *
 * Reads the model, applies the declarative edits, and (with --apply) persists them:
 * rename/description via the update-set-aware record write, step inputs via a
 * snapshot recompile. Without --apply it prints the would-be changes.
 */
async function runEditFlow(flags: Record<string, string>): Promise<number> {
  var sysId = flags["sys-id"] || flags.sysId;
  if (!sysId) {
    process.stderr.write("edit-flow: --sys-id <sys_id> is required\n");
    return 1;
  }
  if (!flags["from-json"]) {
    process.stderr.write(
      "edit-flow: --from-json <path> (EditFlowOps) is required\n",
    );
    return 1;
  }
  var ops = JSON.parse(fs.readFileSync(flags["from-json"], "utf8"));
  var params: any = {
    client: createClient({}),
    sysId: sysId,
    ops: ops,
    apply: flags.apply === "true",
  };
  if (flags.scope || flags.scopeSysId) {
    params.scopeSysId = flags.scope || flags.scopeSysId;
  }
  if (flags["update-set"] || flags.updateSetSysId) {
    params.updateSetSysId = flags["update-set"] || flags.updateSetSysId;
  }
  var result = await editFlow(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    "[" +
      result.status +
      "] " +
      result.changes.length +
      " change(s)" +
      (result.snapshotSysId ? " — snapshot " + result.snapshotSysId : "") +
      "\n",
  );
  for (var i = 0; i < result.changes.length; i += 1) {
    process.stdout.write("  + " + result.changes[i] + "\n");
  }
  for (var w = 0; w < result.warnings.length; w += 1) {
    process.stdout.write("  ! " + result.warnings[w] + "\n");
  }
  return 0;
}

/**
 * dove-sn edit-action:
 *   --sys-id <sys_id>                  Required. sys_hub_action_type_definition sys_id.
 *   --scope <sys_id>                   Required. sysparm_transaction_scope (app scope sys_id).
 *   --from-json <path>                 Optional. JSON EditActionTypeOps — the full surface, incl.
 *                                      per-step ops: patchStepScripts / addStepOutputs / addStepInputs.
 *   --patch-script "<find>::<replace>" Optional. Find/replace in the auto-detected script step value.
 *   --set-script <path>                Optional. Replace the auto-detected script step value from a file.
 *   --merge-outputs <path>             Optional. JSON file: an output-variable object/array to merge by name.
 *   --script-input <name>              Optional. Input name holding the script (default: auto-detect).
 *   --update-set <sys_id>              Optional. Capture the republish into this update set.
 *   --apply                            Optional. Republish (POST /snapshot). Omit for dry-run.
 *   --json                             Optional. Emit the structured EditActionTypeResult.
 *
 * Edits a published Custom Action Type and republishes through the snapshot POST.
 * Dry-run (read-only) by default; --apply writes.
 *
 * The flag form handles the single-script case. For anything structural — patching
 * several steps' scripts, adding a step-level output, adding a step-level input
 * pill-wired to another step's output — use --from-json:
 *
 *   {
 *     "patchStepScripts": [{ "step": "Parse Response", "scriptFile": "./parse.js" }],
 *     "addStepOutputs":   [{ "step": "Parse Response", "name": "isRetryable", "type": "boolean" }],
 *     "addStepInputs":    [{ "step": "Handle Error", "name": "isRetryable", "type": "boolean",
 *                            "pillFrom": { "step": "Parse Response", "output": "isRetryable" } }]
 *   }
 *
 * `step` is a step cid or label. `scriptFile` is sugar for `setScript` and is
 * resolved RELATIVE TO THE OPS FILE, so an ops file can sit next to its scripts.
 */

/** Resolve `scriptFile` sugar in patchStepScripts, relative to the ops file's own dir. */
function resolveScriptFiles(ops: any, opsPath: string): void {
  var stepScripts = ops.patchStepScripts;
  if (!Array.isArray(stepScripts)) {
    return;
  }
  var opsDir = path.dirname(path.resolve(opsPath));
  for (var i = 0; i < stepScripts.length; i += 1) {
    var op = stepScripts[i];
    if (!op || typeof op !== "object" || typeof op.scriptFile !== "string") {
      continue;
    }
    if (typeof op.setScript === "string") {
      throw new Error(
        "edit-action: step '" +
          String(op.step) +
          "' sets both scriptFile and setScript — pick one.",
      );
    }
    op.setScript = fs.readFileSync(path.resolve(opsDir, op.scriptFile), "utf8");
    delete op.scriptFile;
  }
}

async function runEditAction(flags: Record<string, string>): Promise<number> {
  var sysId = flags["sys-id"] || flags.sysId;
  var scope = flags.scope || flags.scopeSysId;
  if (!sysId || !scope) {
    process.stderr.write(
      "edit-action: --sys-id <sys_id> and --scope <sys_id> are required\n",
    );
    return 1;
  }
  var ops: any = {};
  if (flags["from-json"]) {
    ops = JSON.parse(fs.readFileSync(flags["from-json"], "utf8"));
    if (!ops || typeof ops !== "object" || Array.isArray(ops)) {
      process.stderr.write(
        "edit-action: --from-json must contain an EditActionTypeOps object\n",
      );
      return 1;
    }
    resolveScriptFiles(ops, flags["from-json"]);
  }
  if (flags["patch-script"]) {
    var parts = String(flags["patch-script"]).split("::");
    if (parts.length !== 2) {
      process.stderr.write(
        'edit-action: --patch-script must be "<find>::<replace>"\n',
      );
      return 1;
    }
    ops.patchScript = { find: parts[0], replace: parts[1] };
  }
  if (flags["set-script"]) {
    ops.setScript = fs.readFileSync(flags["set-script"], "utf8");
  }
  if (flags["merge-outputs"]) {
    var parsedOutputs = JSON.parse(
      fs.readFileSync(flags["merge-outputs"], "utf8"),
    );
    ops.mergeOutputs = Array.isArray(parsedOutputs)
      ? parsedOutputs
      : [parsedOutputs];
  }
  if (flags["script-input"]) {
    ops.scriptInputName = flags["script-input"];
  }
  var result = await editActionType({
    client: createClient({}),
    sysId: sysId,
    scopeSysId: scope,
    ops: ops,
    apply: flags.apply === "true",
    updateSetSysId: flags["update-set"] || flags.updateSetSysId,
  });
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    "[" +
      result.status +
      "] " +
      result.changes.length +
      " change(s)" +
      (result.snapshotSysId ? " — snapshot " + result.snapshotSysId : "") +
      "\n",
  );
  for (var ci = 0; ci < result.changes.length; ci += 1) {
    process.stdout.write("  + " + result.changes[ci] + "\n");
  }
  for (var wi = 0; wi < result.warnings.length; wi += 1) {
    process.stdout.write("  ! " + result.warnings[wi] + "\n");
  }

  // Per-step before/after — the dry-run's whole job is to make this inspectable.
  if (result.stepsBefore && result.stepsAfter) {
    process.stdout.write("\n--- steps (before -> after) ---\n");
    for (var si = 0; si < result.stepsAfter.length; si += 1) {
      var after = result.stepsAfter[si];
      var before = result.stepsBefore[si];
      var io = function (
        label: string,
        list: Array<{ name: string; value: string }>,
      ): string {
        if (list.length === 0) {
          return "";
        }
        var rendered = list
          .map(function (e) {
            return e.name + (e.value ? "=" + e.value : "");
          })
          .join(", ");
        return "\n      " + label + ": " + rendered;
      };
      process.stdout.write(
        "  " +
          after.label +
          " (" +
          after.cid +
          ")\n" +
          "      script: " +
          String(before ? before.scriptChars : "?") +
          " -> " +
          String(after.scriptChars) +
          " chars" +
          io("in ", after.extendedInputs) +
          io("out", after.extendedOutputs) +
          "\n",
      );
    }
  }

  if (result.verified) {
    process.stdout.write("\n--- verify (read back from the instance) ---\n");
    process.stdout.write("  " + (result.verified.ok ? "OK" : "FAILED") + "\n");
    for (var vi = 0; vi < result.verified.notes.length; vi += 1) {
      process.stdout.write(
        "  " +
          (result.verified.ok ? "+ " : "! ") +
          result.verified.notes[vi] +
          "\n",
      );
    }
    if (!result.verified.ok) {
      return 2;
    }
  }

  if (
    result.status === "preview" &&
    result.scriptAfter !== undefined &&
    result.scriptAfter !== result.scriptBefore
  ) {
    process.stdout.write(
      "\n--- script after ---\n" + result.scriptAfter + "\n",
    );
  }
  return 0;
}

/**
 * dove-sn clone-action:
 *   --from <sys_id>            Required. Source sys_hub_action_type_definition sys_id.
 *   --name <name>              Required. Display name of the clone (idempotency key with --scope).
 *   --scope <name|sys_id>      Required. Target scope — a scope name (x_cadso_email_spok) or 32-hex sys_id.
 *   --internal-name <name>     Optional. Default: slug of --name.
 *   --description <text>       Optional.
 *   --ops <path>               Optional. JSON StepOps applied to the cloned steps before publish:
 *                              patchStepScripts / setStepInputs / addStepOutputs / addStepInputs.
 *   --update-set <sys_id>      Required with --confirm. Every write + the publish land here.
 *   --confirm                  Execute (write the graph, publish, verify). WITHOUT it: dry-run.
 *   --dry-run                  Force a dry-run even with --confirm.
 *   --json                     Emit the structured CloneActionTypeResult.
 *
 * Clones a Custom Action Type — parent, inputs, outputs, every step instance and
 * its step-level ext inputs/outputs — into the target scope, then publishes it
 * headlessly through the snapshot path (multi-step capable) and reads the steps
 * back to verify. Idempotent on (name, scope). DRY-RUN BY DEFAULT.
 *
 * --ops shape:
 *   {
 *     "setStepInputs":    [{ "step": "REST Step", "input": "http_method", "value": "post" }],
 *     "patchStepScripts": [{ "step": "Parse", "patchScript": { "find": "a", "replace": "b" } }],
 *     "addStepOutputs":   [{ "step": "Parse", "name": "isRetryable", "type": "boolean" }],
 *     "addStepInputs":    [{ "step": "Handle", "name": "isRetryable", "type": "boolean",
 *                            "pillFrom": { "step": "Parse", "output": "isRetryable" } }]
 *   }
 * `step` is a step cid or label; `scriptFile` (resolved relative to the ops file)
 * is sugar for `setScript` in patchStepScripts.
 */
var CLONE_OPS_KEYS = ["patchStepScripts", "setStepInputs", "addStepOutputs", "addStepInputs"];

async function runCloneAction(
  flags: Record<string, string>,
  bare: Record<string, boolean>,
): Promise<number> {
  var bareErr = bareStringFlagError("clone-action", bare);
  if (bareErr) {
    process.stderr.write(bareErr);
    return 1;
  }
  var from = flags.from;
  var name = flags.name;
  var scope = flags.scope;
  if (!from || !name || !scope) {
    process.stderr.write(
      "clone-action: --from <sys_id>, --name <name> and --scope <scope name|sys_id> are required\n",
    );
    return 1;
  }
  var confirm = flags.confirm === "true";
  var dryRun = flags["dry-run"] === "true";
  var updateSet = flags["update-set"] || flags.updateSetSysId;
  if (confirm && !dryRun && !updateSet) {
    process.stderr.write(
      "clone-action: --update-set <sys_id> is required with --confirm\n",
    );
    return 1;
  }

  var stepOps: Record<string, unknown> | undefined;
  if (flags.ops) {
    var parsedOps: unknown = JSON.parse(fs.readFileSync(flags.ops, "utf8"));
    if (!parsedOps || typeof parsedOps !== "object" || Array.isArray(parsedOps)) {
      process.stderr.write("clone-action: --ops must contain a StepOps object\n");
      return 1;
    }
    var opsObj = parsedOps as Record<string, unknown>;
    var opsKeys = Object.keys(opsObj);
    for (var k = 0; k < opsKeys.length; k += 1) {
      if (CLONE_OPS_KEYS.indexOf(opsKeys[k]) === -1) {
        process.stderr.write(
          "clone-action: unknown --ops key '" +
            opsKeys[k] +
            "' (allowed: " +
            CLONE_OPS_KEYS.join(", ") +
            ")\n",
        );
        return 1;
      }
    }
    resolveScriptFiles(opsObj, flags.ops);
    stepOps = opsObj;
  }

  var result = await cloneActionType({
    client: createClient({}),
    sourceSysId: from,
    newName: name,
    internalName: flags["internal-name"],
    newScope: scope,
    updateSetSysId: updateSet,
    description: flags.description,
    stepOps: stepOps as StepOps | undefined,
    confirm: confirm,
    dryRun: dryRun,
  });

  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.verify && !result.verify.ok ? 1 : 0;
  }

  process.stdout.write(
    "[" + result.action + "] " + name + " (" + result.internalName + ") -> " + result.sysId + "\n",
  );
  if (result.action === "unchanged") {
    process.stdout.write(
      "  an action with this name already exists in the target scope — nothing written\n",
    );
    return 0;
  }
  if (result.plan) {
    process.stdout.write(
      "  scope: " +
        result.plan.scope.name +
        " (" +
        result.plan.scope.sysId +
        ")  source scope: " +
        result.plan.sourceScopeSysId +
        "\n  records: " +
        result.plan.total +
        "\n",
    );
    var tables = Object.keys(result.plan.counts);
    for (var t = 0; t < tables.length; t += 1) {
      process.stdout.write("    " + tables[t] + ": " + result.plan.counts[tables[t]] + "\n");
    }
  }
  if (result.steps) {
    process.stdout.write("\n--- steps (as published) ---\n");
    for (var si = 0; si < result.steps.after.length; si += 1) {
      var step = result.steps.after[si];
      process.stdout.write(
        "  " +
          step.label +
          " (" +
          step.cid +
          ")" +
          (step.scriptChars !== null ? " script " + step.scriptChars + " chars" : "") +
          (step.extendedInputs.length ? " in:" + step.extendedInputs.length : "") +
          (step.extendedOutputs.length ? " out:" + step.extendedOutputs.length : "") +
          "\n",
      );
    }
    for (var ci = 0; ci < result.steps.changes.length; ci += 1) {
      process.stdout.write("  + " + result.steps.changes[ci] + "\n");
    }
    for (var wi = 0; wi < result.steps.warnings.length; wi += 1) {
      process.stdout.write("  ! " + result.steps.warnings[wi] + "\n");
    }
  }
  if (result.action === "planned") {
    process.stdout.write(
      "\nDRY RUN — nothing written. Re-run with --confirm --update-set <sys_id> to clone + publish.\n",
    );
    return 0;
  }
  process.stdout.write(
    "\nwritten: " +
      result.written.length +
      " record(s)" +
      (result.publish
        ? "; published (HTTP " +
          result.publish.httpStatus +
          (result.publish.snapshotSysId ? ", snapshot " + result.publish.snapshotSysId : "") +
          ")"
        : "") +
      "\n",
  );
  if (result.verify) {
    process.stdout.write("\n--- verify (read back from the instance) ---\n");
    process.stdout.write("  " + (result.verify.ok ? "OK" : "FAILED") + "\n");
    for (var vi = 0; vi < result.verify.notes.length; vi += 1) {
      process.stdout.write(
        "  " + (result.verify.ok ? "+ " : "! ") + result.verify.notes[vi] + "\n",
      );
    }
    if (!result.verify.ok) {
      return 1;
    }
  }
  return 0;
}

/**
 * dove-sn define-action:
 *   --sys-id <sys_id>          Required. The sys_hub_action_type_definition to define (the shell must
 *                              exist — make it with clone-action or the Flow Designer).
 *   --scope <name|sys_id>      Required. The action's own scope (x_cadso_email_spok or a 32-hex sys_id).
 *   --spec <spec.json>         Required. The definition — action inputs, outputs, steps (see below).
 *   --update-set <sys_id>      Optional. Pin the REST session to this update set before the save/publish.
 *   --publish                  With --confirm: also publish (snapshot) after the save.
 *   --confirm                  Execute (PUT the model, verify, optionally publish). WITHOUT it: dry-run.
 *   --dry-run                  Force a dry-run even with --confirm.
 *   --json                     Emit the structured DefineActionTypeResult.
 *
 * Saves the action the way the Flow Designer's Save does: GET the model + the
 * step graph, merge the spec, PUT the FULL model back to
 * /api/now/processflow/action/action_types/{id}, read it back to verify.
 * DRY-RUN BY DEFAULT: prints the planned diff, writes nothing. Idempotent: a
 * spec already in effect is "unchanged" and makes no PUT.
 *
 * --spec shape (every part optional — incremental edits are fine):
 *   {
 *     "action":  { "name": "...", "description": "...", "access": "public" | "package_private" },
 *     "inputs":  [{ "name": "host", "type": "choice", "mandatory": true, "default": "api",
 *                   "choices": [{ "value": "api", "label": "API" }] }],      // upsert by name; "remove": true
 *     "outputs": [{ "name": "status_code", "value": "{{steps.call.status_code}}" }],
 *     "steps": [
 *       { "ref": "guard", "type": "script", "label": "Guard", "scriptFile": "guard.js",
 *         "inputs":  { "host_1": "{{action.host}}" }, "outputs": [{ "name": "base_url" }] },
 *       { "ref": "call", "type": "rest", "label": "Call", "values": { "base_url": "{{steps.guard.base_url}}",
 *         "http_method": "get", "headers": [{ "name": "Accept", "value": "application/json" }] } }
 *     ]
 *   }
 * `scriptFile` (resolved relative to the spec file) is sugar for `script`.
 */
async function runDefineAction(
  flags: Record<string, string>,
  bare: Record<string, boolean>,
): Promise<number> {
  var bareErr = bareStringFlagError("define-action", bare);
  if (bareErr) {
    process.stderr.write(bareErr);
    return 1;
  }
  var sysId = flags["sys-id"] || flags.sysId;
  var scope = flags.scope;
  var specPath = flags.spec;
  if (!sysId || !scope || !specPath) {
    process.stderr.write(
      "define-action: --sys-id <sys_id>, --scope <scope name|sys_id> and --spec <spec.json> are required\n",
    );
    return 1;
  }
  var rawSpec: unknown = JSON.parse(fs.readFileSync(specPath, "utf8"));
  if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
    process.stderr.write("define-action: --spec must contain a JSON object\n");
    return 1;
  }
  resolveStepScriptFiles(rawSpec as Record<string, unknown>, specPath);

  var result = await defineActionType({
    client: createClient({}),
    sysId: sysId,
    scope: scope,
    spec: rawSpec as DefineActionSpec,
    confirm: flags.confirm === "true",
    dryRun: flags["dry-run"] === "true",
    publish: flags.publish === "true",
    updateSetSysId: flags["update-set"],
  });

  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.verify && !result.verify.ok ? 1 : 0;
  }

  var d = result.diff;
  process.stdout.write(
    "[" + result.status + "] " + result.after.action.name + " (" + result.sysId + ") in " +
      result.scope.name + "\n",
  );
  d.action.forEach(function (c) {
    process.stdout.write("  action." + c.field + ": '" + c.before + "' -> '" + c.after + "'\n");
  });
  var named = function (kind: string, part: DefineActionTypeResult["diff"]["inputs"]): void {
    part.added.forEach(function (n) {
      process.stdout.write("  + " + kind + " " + n + "\n");
    });
    part.changed.forEach(function (c) {
      process.stdout.write(
        "  ~ " + kind + " " + c.name + ": " +
          c.changes.map(function (f) {
            return f.field + " '" + f.before + "' -> '" + f.after + "'";
          }).join(", ") + "\n",
      );
    });
    part.removed.forEach(function (n) {
      process.stdout.write("  - " + kind + " " + n + "\n");
    });
  };
  named("input", d.inputs);
  named("output", d.outputs);
  var stepLine = function (sign: string, s: DefineActionTypeResult["diff"]["steps"]["added"][number]): void {
    process.stdout.write(
      "  " + sign + " step " + s.order + " '" + s.label + "' [" + s.type + "] " + s.cid +
        (s.ref ? " (ref " + s.ref + (s.matchedBy ? ", matched by " + s.matchedBy : "") + ")" : "") + "\n",
    );
    s.changes.forEach(function (c) {
      process.stdout.write("      " + c + "\n");
    });
  };
  d.steps.added.forEach(function (s) { stepLine("+", s); });
  d.steps.changed.forEach(function (s) { stepLine("~", s); });
  d.steps.removed.forEach(function (s) { stepLine("-", s); });
  if (d.empty) {
    process.stdout.write("  no changes — the spec is already in effect\n");
  }
  result.warnings.forEach(function (w) {
    process.stdout.write("  ! " + w + "\n");
  });
  if (result.status === "planned") {
    process.stdout.write(
      "\nDRY RUN — nothing written. Re-run with --confirm (and --publish to snapshot) to save.\n",
    );
    return 0;
  }
  if (result.verify) {
    process.stdout.write("\n--- verify (read back from the instance) ---\n  " + (result.verify.ok ? "OK" : "FAILED") + "\n");
    result.verify.notes.forEach(function (n) {
      process.stdout.write("  " + (result.verify && result.verify.ok ? "+ " : "! ") + n + "\n");
    });
  }
  if (result.publish) {
    process.stdout.write(
      "published (HTTP " + result.publish.httpStatus +
        (result.publish.snapshotSysId ? ", snapshot " + result.publish.snapshotSysId : "") + ")\n",
    );
  }
  return result.verify && !result.verify.ok ? 1 : 0;
}

/** Replace each step's `scriptFile` with `script`, read relative to the spec file. */
function resolveStepScriptFiles(spec: Record<string, unknown>, specPath: string): void {
  var steps = spec.steps;
  if (!Array.isArray(steps)) {
    return;
  }
  var specDir = path.dirname(path.resolve(specPath));
  for (var i = 0; i < steps.length; i += 1) {
    var step = steps[i];
    if (!step || typeof step !== "object" || typeof step.scriptFile !== "string") {
      continue;
    }
    if (typeof step.script === "string") {
      throw new Error("define-action: step '" + String(step.ref) + "' sets both scriptFile and script — pick one.");
    }
    step.script = fs.readFileSync(path.resolve(specDir, step.scriptFile), "utf8");
    delete step.scriptFile;
  }
}

async function runMcp(flags: Record<string, string>): Promise<number> {
  if (flags.smoke === "true") {
    await runSmoke();
    return 0;
  }
  await runStdio();
  await new Promise(function () {
    /* keep the MCP server alive */
  });
  return 0;
}

/** Parse inline `--columns "Label:type:max, Other:choice, ..."` into ColumnSpec[]. */
function parseColumnsInline(input: string): Array<ColumnSpec> {
  var out: Array<ColumnSpec> = [];
  if (!input) return out;
  var parts = input.split(",");
  for (var i = 0; i < parts.length; i += 1) {
    var piece = parts[i].trim();
    if (!piece) continue;
    var seg = piece.split(":");
    var label = (seg[0] || "").trim();
    var type = (seg[1] || "string").trim();
    var max = (seg[2] || "").trim();
    if (!label) continue;
    var col: ColumnSpec = { label: label, type: type };
    if (max) col.max_length = max;
    out.push(col);
  }
  return out;
}

/**
 * dove-sn create-table:
 *   --name x_cadso_core_error --label Error --scope x_cadso_core
 *   --columns "Key:string:255, Severity:choice:50, Occurence Count:integer:5"
 *   [--extends sys_metadata] [--number-prefix ERR] [--user-role x_cadso_core.user]
 *   [--no-acls] [--no-menu] [--update-set <sys_id>] [--save-action <sys_id>]
 *   [--from-json <spec.json>] [--dry-run] [--json]
 */
async function runCreateTable(flags: Record<string, string>): Promise<number> {
  var spec: Partial<CreateTableParams> = {};
  if (flags["from-json"]) {
    spec = JSON.parse(
      fs.readFileSync(path.resolve(flags["from-json"]), "utf8"),
    ) as Partial<CreateTableParams>;
  }
  var name = flags.name || spec.name;
  var label = flags.label || spec.label;
  var scope = flags.scope || spec.scope;
  var columns: Array<ColumnSpec> = flags.columns
    ? parseColumnsInline(flags.columns)
    : spec.columns || [];
  if (!name || !label || !scope || columns.length === 0) {
    process.stderr.write(
      "create-table: --name, --label, --scope and --columns (or --from-json) are required\n",
    );
    return 1;
  }
  var params: CreateTableParams = {
    client: createClient({}),
    name: name,
    label: label,
    scope: scope,
    columns: columns,
  };
  var ext = flags.extends || spec.extendsTable;
  if (ext) params.extendsTable = ext;
  var prefix = flags["number-prefix"] || spec.numberPrefix;
  if (prefix) params.numberPrefix = prefix;
  var role = flags["user-role"] || spec.userRole;
  if (role) params.userRole = role;
  if (flags["no-acls"] === "true" || spec.createAccessControls === false)
    params.createAccessControls = false;
  if (flags["no-menu"] === "true" || spec.showInMenu === false)
    params.showInMenu = false;
  var us = flags["update-set"] || spec.updateSetSysId;
  if (us) params.updateSetSysId = us;
  var sa = flags["save-action"] || spec.saveActionSysId;
  if (sa) params.saveActionSysId = sa;
  var relId = flags["columns-rel-id"] || spec.columnsRelId;
  if (relId) params.columnsRelId = relId;
  if (flags["dry-run"] === "true" || spec.dryRun === true) params.dryRun = true;
  if (flags.debug === "true" || spec.debug === true) params.debug = true;

  var result = await createTable(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.name +
        " (" +
        result.label +
        ") scope=" +
        result.scopeSysId +
        " — " +
        result.columns +
        " columns, projected graph " +
        result.graph.total +
        " records" +
        (result.tableSysId ? " — sys_id " + result.tableSysId : "") +
        "\n" +
        result.note +
        "\n",
    );
  }
  if (result.status === "failed") return 2;
  return 0;
}

/**
 * dove-sn add-column:
 *   --table x_cadso_journey --label URL --type url
 *   [--name url] [--max-length 1024] [--reference <table>]
 *   [--mandatory] [--default <value>] [--dependent-on-field <element>]
 *   [--scope x_cadso_journey] [--cross-scope] [--update-set <sys_id>]
 *   [--from-json <spec.json>] [--dry-run] [--debug] [--json]
 * --update-set is required unless --dry-run. --cross-scope opts in to a column
 * OWNED by --scope when that differs from the table's scope.
 */
async function runAddColumn(flags: Record<string, string>): Promise<number> {
  var spec: Partial<AddColumnParams> = {};
  if (flags["from-json"]) {
    spec = JSON.parse(
      fs.readFileSync(path.resolve(flags["from-json"]), "utf8"),
    ) as Partial<AddColumnParams>;
  }
  var table = flags.table || spec.table;
  var column: ColumnSpec | undefined = spec.column;
  if (flags.label || flags.type) {
    column = { label: flags.label || "", type: flags.type || "string" };
    if (flags.name) column.name = flags.name;
    if (flags["max-length"]) column.max_length = flags["max-length"];
    if (flags.reference) column.reference = flags.reference;
    if (flags.mandatory === "true") column.mandatory = true;
    if (flags["default"] !== undefined) column.default = flags["default"];
    if (flags["dependent-on-field"] !== undefined) {
      column.dependent_on_field = flags["dependent-on-field"];
    }
  }
  if (!table || !column || !column.label) {
    process.stderr.write(
      "add-column: --table and --label (with --type) are required (or --from-json)\n",
    );
    return 1;
  }
  var params: AddColumnParams = {
    client: createClient({}),
    table: table,
    column: column,
  };
  var scope = flags.scope || spec.scope;
  if (scope) params.scope = scope;
  if (flags["cross-scope"] === "true" || spec.crossScope === true) {
    params.crossScope = true;
  }
  var us = flags["update-set"] || spec.updateSetSysId;
  if (us) params.updateSetSysId = us;
  if (flags["dry-run"] === "true" || spec.dryRun === true) params.dryRun = true;
  if (flags.debug === "true" || spec.debug === true) params.debug = true;

  // Fail fast with a targeted message + exit 1 instead of falling through to the
  // top-level fatal handler — the live path cannot proceed without a target update set.
  if (!params.dryRun && !params.updateSetSysId) {
    process.stderr.write(
      "add-column: --update-set is required on the live path (only --dry-run works without one)\n",
    );
    return 1;
  }

  var result = await addColumn(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.table +
        "." +
        result.element +
        " (" +
        result.internalType +
        ")" +
        (result.verified ? " — verified" : "") +
        "\n" +
        result.note +
        "\n",
    );
  }
  if (result.status === "failed") return 2;
  return 0;
}

/**
 * dove-sn add-index:
 *   --table x_cadso_journey_instance --columns occurrence_key --unique
 *   --update-set <sys_id> [--confirm] [--scope x_cadso_journey] [--debug] [--json]
 *
 * DRY-RUN BY DEFAULT — nothing is written without --confirm (--dry-run forces a
 * dry-run even with it). --update-set is required on the live path and is checked
 * here, before a client is built or a single request goes out.
 *
 * Exit codes: 0 created / skipped / dry-run, 1 bad args, 2 failed (which includes
 * "the dictionary flag is set but no index was read back" — the lying-row case).
 */
async function runAddIndex(flags: Record<string, string>): Promise<number> {
  var table = flags.table;
  var columns = (flags.columns || "")
    .split(",")
    .map(function (c) {
      return c.trim();
    })
    .filter(function (c) {
      return c.length > 0;
    });
  if (!table || columns.length === 0) {
    process.stderr.write(
      "add-index: --table and --columns <column> are required " +
        "(--unique too, and --update-set unless this is a dry-run)\n",
    );
    return 1;
  }
  // The only headless lever is sys_dictionary.unique. Refuse a non-unique request by
  // name instead of building something else and calling it done.
  if (flags.unique !== "true") {
    process.stderr.write(
      "add-index: --unique is required — the only headless lever is " +
        "sys_dictionary.unique, which has no equivalent for a plain (non-unique) " +
        "index. Create that one in the platform UI.\n",
    );
    return 1;
  }
  // DRY-RUN BY DEFAULT: --confirm is what sends; --dry-run forces a plan even with it.
  var dryRun = flags["dry-run"] === "true" || flags.confirm !== "true";
  if (!dryRun && !flags["update-set"]) {
    process.stderr.write(
      "add-index: --update-set is required on the live path (only a dry-run works without one)\n",
    );
    return 1;
  }

  var params: AddIndexParams = {
    client: createClient({}),
    table: table,
    columns: columns,
    unique: true,
    dryRun: dryRun,
  };
  if (flags.scope) params.scope = flags.scope;
  if (flags["update-set"]) params.updateSetSysId = flags["update-set"];
  if (flags.debug === "true") params.debug = true;

  var result = await addIndex(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.table +
        "." +
        result.columns.join(",") +
        (result.indexName ? " -> " + result.indexName : "") +
        "\n" +
        result.note +
        "\nUNVERIFIED: " +
        result.unverified.join(", ") +
        "\n",
    );
  }
  if (result.status === "failed") return 2;
  return 0;
}

/**
 * dove-sn index-list:
 *   --table x_cadso_automate_message_batch_recipient [--json]
 *
 * Read-only. Lists the table's database indexes from the v_db_index view — the only
 * index read surface an instance exposes (sys_index is API-level-ACL 403,
 * sys_index_column does not exist).
 *
 * Exit codes: 0 read, 1 bad args.
 */
async function runIndexList(flags: Record<string, string>): Promise<number> {
  if (!flags.table) {
    process.stderr.write("index-list: --table <name> is required\n");
    return 1;
  }
  var result = await listIndexes({
    client: createClient({}),
    table: flags.table,
  });
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    result.table + " — " + result.indexes.length + " index(es)\n",
  );
  for (var i = 0; i < result.indexes.length; i += 1) {
    var idx = result.indexes[i];
    process.stdout.write(
      "  " +
        (idx.name || "(unnamed)") +
        "  [" +
        idx.columns.join(", ") +
        "]  " +
        (idx.type || "(no access_method)") +
        "\n",
    );
  }
  process.stdout.write(
    result.note + "\nUNVERIFIED: " + result.unverified.join(", ") + "\n",
  );
  return 0;
}

/**
 * dove-sn index-create:
 *   --table x_cadso_core_u_smoke --columns a,b --update-set <sys_id> [--unique]
 *   [--access-method <m>] [--confirm] [--dry-run] [--poll-attempts <n>]
 *   [--poll-interval-ms <n>] [--debug] [--json]
 *
 * DRY-RUN BY DEFAULT — nothing is sent (and nothing is even READ) without --confirm;
 * --dry-run forces a plan even with it. --update-set is REQUIRED on the live path:
 * the build job captures the index definition (sys_update_xml type=Indexes) into the
 * user's CURRENT update set, so the verb pins that set first and reads the capture
 * row back from it afterwards.
 *
 * Exit codes: 0 created / already-exists / dry-run, 1 bad args, 2 failed (which
 * includes "scheduled but no index was read back") — and 2 when the index was read
 * back but its capture row was NOT found in the pinned set.
 */
async function runIndexCreate(flags: Record<string, string>): Promise<number> {
  var columns = splitList(flags.columns || "");
  if (!flags.table || columns.length === 0) {
    process.stderr.write(
      "index-create: --table <name> and --columns <a[,b,...]> are required\n",
    );
    return 1;
  }
  // DRY-RUN BY DEFAULT: --confirm is what sends; --dry-run forces a plan even with it.
  var indexDryRun = flags["dry-run"] === "true" || flags.confirm !== "true";
  if (!indexDryRun && !flags["update-set"]) {
    process.stderr.write(
      "index-create: --update-set is required on the live path — the index " +
        "definition is captured into the user's CURRENT update set, so it must be " +
        "pinned first (only a dry-run works without one)\n",
    );
    return 1;
  }
  var params: CreateIndexParams = {
    client: createClient({}),
    table: flags.table,
    columns: columns,
    unique: flags.unique === "true",
    confirm: flags.confirm === "true",
    dryRun: flags["dry-run"] === "true",
  };
  if (flags.name !== undefined) params.name = flags.name;
  if (flags["access-method"]) params.accessMethod = flags["access-method"];
  if (flags["update-set"]) params.updateSetSysId = flags["update-set"];
  if (flags.debug === "true") params.debug = true;
  // A non-integer poll setting would make the bounded wait unbounded (or zero).
  // Reject it here with a named message instead of letting NaN reach the loop.
  var numeric: Array<[string, "pollAttempts" | "pollIntervalMs"]> = [
    ["poll-attempts", "pollAttempts"],
    ["poll-interval-ms", "pollIntervalMs"],
  ];
  for (var n = 0; n < numeric.length; n += 1) {
    var raw = flags[numeric[n][0]];
    if (raw === undefined) continue;
    var value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      process.stderr.write(
        "index-create: --" +
          numeric[n][0] +
          " must be a positive integer (got '" +
          raw +
          "')\n",
      );
      return 1;
    }
    params[numeric[n][1]] = value;
  }

  var result = await createIndex(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.table +
        " [" +
        result.columns.join(", ") +
        "]" +
        (result.name ? " -> " + result.name : "") +
        (result.instance ? " on " + result.instance : "") +
        (result.verified ? " — verified" : "") +
        (result.updateSet
          ? " [update set " +
            (result.updateSet.name || result.updateSet.sysId) +
            (result.captured ? " — captured" : " — capture NOT verified") +
            "]"
          : "") +
        "\n" +
        result.note +
        "\nUNVERIFIED: " +
        result.unverified.join(", ") +
        "\n",
    );
  }
  if (result.status === "failed") return 2;
  // An index that exists but whose definition was not captured will not travel —
  // surface that as a non-zero exit, the same way an unread-back index is.
  if (result.status === "created" && !result.captured) return 2;
  return 0;
}

/** Parse a CLI boolean flag. Bare `--mandatory` means true; `--mandatory false` means
 *  false. Anything else is rejected rather than quietly coerced to `true`. */
function parseBoolFlag(
  name: string,
  raw: string,
  verb: string = "set-column",
): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    verb + ": --" + name + " must be true or false (got '" + raw + "').",
  );
}

/**
 * dove-sn set-column:
 *   --table x_cadso_journey --column description --update-set <sys_id>
 *   [--label "Description"] [--mandatory true|false] [--default <v>]
 *   [--read-only true|false] [--max-length 4000] [--dependent-on-field <element>]
 *   [--dry-run] [--json]
 *
 * Updates an EXISTING column's schema. `internal_type` and a rename are refused —
 * ServiceNow silently ignores both on an existing column. To CREATE one, use add-column;
 * to set a RECORD's value, use set-field.
 */
async function runSetColumn(
  flags: Record<string, string>,
  bare: Record<string, boolean>,
): Promise<number> {
  var bareErr = bareStringFlagError("set-column", bare);
  if (bareErr) {
    process.stderr.write(bareErr);
    return 1;
  }
  var table = flags.table;
  var column = flags.column;
  if (!table || !column) {
    process.stderr.write(
      "set-column: --table and --column are required " +
        "(--update-set is required too, unless --dry-run)\n",
    );
    return 1;
  }
  var attributes: ColumnAttributes = {};
  // Accepted so that setColumn can REFUSE them by name with the reason. Dropping them
  // silently would leave someone who asked for a rename believing it happened.
  if (flags.element !== undefined) attributes.element = flags.element;
  if (flags["internal-type"] !== undefined) {
    attributes.internalType = flags["internal-type"];
  }
  if (flags.label !== undefined) attributes.label = flags.label;
  if (flags.default !== undefined) attributes.default = flags.default;
  if (flags.mandatory !== undefined) {
    attributes.mandatory = parseBoolFlag("mandatory", flags.mandatory);
  }
  if (flags["read-only"] !== undefined) {
    attributes.readOnly = parseBoolFlag("read-only", flags["read-only"]);
  }
  // An explicit empty string clears the dependency; a bare flag is refused above.
  if (flags["dependent-on-field"] !== undefined) {
    attributes.dependentOnField = flags["dependent-on-field"].trim();
  }
  if (flags["max-length"] !== undefined) {
    var len = Number(flags["max-length"]);
    // sys_dictionary.max_length is an integer; the MCP schema enforces int() too.
    if (!Number.isInteger(len) || len < 1) {
      process.stderr.write(
        "set-column: --max-length must be a positive integer\n",
      );
      return 1;
    }
    attributes.maxLength = len;
  }

  var params: SetColumnParams = {
    client: createClient({}),
    table: table,
    column: column,
    attributes: attributes,
  };
  // Accept the same alias pair as the other verbs (create-view, set-list-layout, …).
  var setColumnUs = flags["update-set"] || flags.updateSetSysId;
  if (setColumnUs) params.updateSetSysId = setColumnUs;
  if (flags["dry-run"] === "true") params.dryRun = true;

  var result = await setColumn(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.table +
        "." +
        result.column +
        // Say when the change went to an override rather than the column's own row. The
        // caller asked for a table + column; without this they have no reason to expect
        // the write landed on a different record type entirely.
        (result.via === "override"
          ? " — override (inherited from " + result.definedOn + ")"
          : "") +
        (result.verified && result.status === "applied" ? " — verified" : "") +
        (result.status === "applied" && !result.capturedInUpdateSet
          ? " — NOT CAPTURED"
          : "") +
        "\n" +
        result.note +
        "\n",
    );
  }
  // 2 = the write landed but the instance does not reflect it (or it was not captured),
  // which must not read as success to a script.
  if (result.status === "failed") return 2;
  if (result.status === "applied" && !result.capturedInUpdateSet) return 2;
  return 0;
}

/**
 * dove-sn set-table:
 *   --table x_cadso_core_setting --audit true --update-set <sys_id>
 *   [--dry-run] [--json]
 *
 * Updates the TABLE's own dictionary row (the `internal_type=collection` row, whose
 * `element` is empty) — not a column's. Column attributes belong to set-column; a
 * record's values belong to set-field.
 */
async function runSetTable(
  flags: Record<string, string>,
  bare: Record<string, boolean>,
): Promise<number> {
  // Guard the string flags AND the updateSetSysId alias: a value-less string flag
  // arrives as the literal "true", so --update-set (or its alias) with nothing after
  // it would silently become the sys_id "true" and later fail as "not found".
  var bareErr = bareStringFlagError("set-table", bare);
  if (bareErr) {
    process.stderr.write(bareErr);
    return 1;
  }
  var table = flags.table;
  if (!table) {
    process.stderr.write(
      "set-table: --table is required " +
        "(--update-set is required too, unless --dry-run)\n",
    );
    return 1;
  }
  var attributes: TableAttributes = {};
  if (flags.audit !== undefined) {
    attributes.audit = parseBoolFlag("audit", flags.audit, "set-table");
  }

  var params: SetTableParams = {
    client: createClient({}),
    table: table,
    attributes: attributes,
  };
  var setTableUs = flags["update-set"] || flags.updateSetSysId;
  if (setTableUs) params.updateSetSysId = setTableUs;
  if (flags["dry-run"] === "true") params.dryRun = true;

  var result = await setTable(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.table +
        (result.verified && result.status === "applied" ? " — verified" : "") +
        (result.status === "applied" && !result.capturedInUpdateSet
          ? " — NOT CAPTURED"
          : "") +
        "\n" +
        result.note +
        "\n",
    );
  }
  // 2 = the write landed but the instance does not reflect it (or it was not
  // captured), which must not read as success to a script.
  if (result.status === "failed") return 2;
  if (result.status === "applied" && !result.capturedInUpdateSet) return 2;
  return 0;
}

/**
 * Thunk handed to resolveRecordFields so process.stdin is dereferenced ONLY when a verb
 * was told to read it (`--from-stdin` / `--from-json -`). No other dove-sn verb touches
 * stdin: an open-but-idle non-TTY pipe (an agent harness launching us in the background)
 * must never be awaited — see #299.
 */
function getProcessStdin(): NodeJS.ReadStream {
  return process.stdin;
}

/**
 * dove-sn set-field:
 *   --table x_cadso_core_metric_point_type
 *   --sys-id <id>  |  --query "name=send_size"   (query must resolve to exactly 1 row)
 *   [--fields "order=20"]                        (comma-separated key=value pairs)
 *   [--from-json <path>]                         (JSON { field: value }; carries large or
 *                                                 multiline values the inline form can't;
 *                                                 overrides --fields on a shared key)
 *   [--from-stdin | --from-json -]               (same JSON object, read from stdin — the ONLY
 *                                                 way stdin is ever read; never implicit)
 *                                                — at least one field source is required
 *   --update-set <sys_id>                        (required — the change is captured here)
 *   [--dry-run] [--json]
 * Exit codes: 0 applied/dry-run, 1 bad args, 2 write landed but read-back unverified.
 */
async function runSetField(flags: Record<string, string>): Promise<number> {
  var table = flags.table;
  var fields: Record<string, string>;
  try {
    fields = await resolveRecordFields(flags, getProcessStdin);
  } catch (err) {
    process.stderr.write(
      "set-field: " + (err instanceof Error ? err.message : String(err)) + "\n",
    );
    return 1;
  }
  var hasTarget = Boolean(flags["sys-id"] || flags.query);
  if (
    !table ||
    Object.keys(fields).length === 0 ||
    !hasTarget ||
    !flags["update-set"]
  ) {
    process.stderr.write(
      'set-field: --table, one of --sys-id/--query, --update-set, and at least one field (--fields "k=v", --from-json <path>, or --from-stdin) are required\n',
    );
    return 1;
  }
  var params: SetFieldParams = {
    client: createClient({}),
    table: table,
    fields: fields,
    updateSetSysId: flags["update-set"],
  };
  if (flags["sys-id"]) params.sysId = flags["sys-id"];
  if (flags.query) params.query = flags.query;
  if (flags["dry-run"] === "true") params.dryRun = true;

  var result = await setField(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.table +
        "/" +
        result.sysId +
        " " +
        JSON.stringify(result.fields) +
        (result.verified ? " — verified" : "") +
        "\n" +
        result.note +
        "\n",
    );
  }
  if (result.status === "failed") return 2;
  return 0;
}

/**
 * dove-sn create-record:
 *   --table x_cadso_core_metric_point_type
 *   [--fields "name=avg_message_parts,label=Avg. Message Parts,order=35"]
 *   [--from-json <path>]                         (JSON { field: value }; carries large or
 *                                                 multiline values the inline form can't)
 *   [--from-stdin | --from-json -]               (same JSON object, read from stdin — the ONLY
 *                                                 way stdin is ever read; never implicit)
 *                                                — at least one field source is required
 *   --scope x_cadso_core                         (the app that owns the new record)
 *   --update-set <sys_id>                        (required — the insert is captured here)
 *   [--if-absent "name=avg_message_parts"]       (skip the insert when this query already matches)
 *   [--dry-run] [--json]
 * Exit codes: 0 created/skipped-in-sync/dry-run, 1 bad args, 2 write landed but read-back unverified
 * (or skipped with drift).
 */
async function runCreateRecord(flags: Record<string, string>): Promise<number> {
  var table = flags.table;
  var fields: Record<string, string>;
  try {
    fields = await resolveRecordFields(flags, getProcessStdin);
  } catch (err) {
    process.stderr.write(
      "create-record: " +
        (err instanceof Error ? err.message : String(err)) +
        "\n",
    );
    return 1;
  }
  if (
    !table ||
    Object.keys(fields).length === 0 ||
    !flags.scope ||
    !flags["update-set"]
  ) {
    process.stderr.write(
      'create-record: --table, --scope, --update-set, and at least one field (--fields "k=v", --from-json <path>, or --from-stdin) are required\n',
    );
    return 1;
  }
  var params: CreateRecordParams = {
    client: createClient({}),
    table: table,
    fields: fields,
    scope: flags.scope,
    updateSetSysId: flags["update-set"],
  };
  if (flags["if-absent"]) params.ifAbsentQuery = flags["if-absent"];
  if (flags["dry-run"] === "true") params.dryRun = true;

  var result = await createRecord(params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.table +
        "/" +
        (result.sysId || "(new)") +
        " " +
        JSON.stringify(result.fields) +
        (result.verified ? " — verified" : "") +
        "\n" +
        result.note +
        "\n",
    );
  }
  if (result.status === "failed") return 2;
  if (result.status === "skipped" && !result.verified) return 2;
  return 0;
}

/**
 * dove-sn delete-record:
 *   --table x_cadso_core_metric_point_type
 *   --sys-id <32-hex sys_id>                     (the record to delete)
 *   --update-set <sys_id>                        (required — the delete is captured here, never the
 *                                                 session default; server honours it once #297 ships)
 *   [--apply]                                    (DRY-RUN BY DEFAULT — nothing is deleted without it)
 *   [--dry-run] [--json]                         (--dry-run wins over --apply)
 * Reads the record BEFORE (a missing record is an error, not a no-op delete) and AFTER
 * (success is only reported once the record is confirmed gone).
 * Exit codes: 0 deleted/dry-run, 1 bad args or missing record, 2 delete returned but the
 * record is STILL PRESENT on read-back.
 */
async function runDeleteRecord(flags: Record<string, string>): Promise<number> {
  var table = flags.table;
  var sysId = flags["sys-id"];
  var updateSet = flags["update-set"];
  // A forgotten value lands as the literal "true" (see parseArgs) — treat it as missing.
  if (
    !table || table === "true" ||
    !sysId || sysId === "true" ||
    !updateSet || updateSet === "true"
  ) {
    process.stderr.write(
      "delete-record: --table <t>, --sys-id <32-hex> and --update-set <sys_id> are all required\n",
    );
    return 1;
  }
  var params: DeleteRecordParams = {
    client: createClient({}),
    table: table,
    sysId: sysId,
    updateSetSysId: updateSet,
    confirm: flags.apply === "true",
  };
  if (flags["dry-run"] === "true") params.dryRun = true;

  var result: Awaited<ReturnType<typeof deleteRecord>>;
  try {
    result = await deleteRecord(params);
  } catch (err) {
    var message = err instanceof Error ? err.message : String(err);
    // deleteRecord's own errors already carry the verb prefix — don't double it.
    if (message.indexOf("delete-record: ") !== 0) message = "delete-record: " + message;
    process.stderr.write(message + "\n");
    return 1;
  }
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      "[" +
        result.status +
        "] " +
        result.table +
        "/" +
        result.sysId +
        " → update set " +
        result.updateSetSysId +
        (result.verified ? " — verified gone" : "") +
        "\n" +
        result.note +
        "\n",
    );
    if (result.status === "dry-run") {
      process.stdout.write("Record snapshot:\n" + JSON.stringify(result.before, null, 2) + "\n");
    }
  }
  if (result.status === "failed") return 2;
  return 0;
}

/**
 * dove-sn host-assets:
 *   --dir <dist>            Required. Path to the pre-built dist/ directory.
 *   --app <sys_id>          Required. Application record sys_id (m2m `application`).
 *   --scope <namespace>     Required. Carrier scope, e.g. x_cadso_app_shell.
 *   --update-set <sys_id>   Optional. Defaults to the scope's current update set.
 *   --max-bytes <n>         Optional. Per-chunk serve cap (default ~5 MB).
 *   --allow-oversize        Optional. Warn instead of failing on an oversize chunk.
 *   --dry-run               Optional. Plan only; no writes/uploads/prunes.
 *   --json                  Optional. Emit the structured HostAssetsResult.
 *
 * Exit codes: 0 done/dry-run, 1 bad args, 2 a write landed but read-back is unverified.
 */
async function runHostAssets(flags: Record<string, string>): Promise<number> {
  var dir = flags.dir;
  var app = flags.app;
  var scope = flags.scope;
  if (!dir || !app || !scope) {
    process.stderr.write(
      "host-assets: --dir, --app and --scope are required\n",
    );
    return 1;
  }
  var params: HostAssetsParams = {
    dir: path.resolve(dir),
    app: app,
    scope: scope,
  };
  var us = flags["update-set"] || flags.updateSetSysId;
  if (us) params.updateSetSysId = us;
  if (flags["max-bytes"]) params.maxBytes = Number(flags["max-bytes"]);
  if (flags["allow-oversize"] === "true") params.allowOversize = true;
  if (flags["dry-run"] === "true") params.dryRun = true;

  var client = createClient({});
  var result = await hostAssets(client, params);
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatHostAssetsResult(result) + "\n");
  }
  var unverified =
    !result.dryRun &&
    result.chunks.some(function (c) {
      return !c.verified;
    });
  return unverified ? 2 : 0;
}

/**
 * dove-sn invoke-rest:
 *   --method <GET|POST|PUT|DELETE>  Required.
 *   --path </api/...>       Required. Instance-relative; must start with /api/.
 *   --body '<json>'         Optional inline JSON body (or --body-json <path>).
 *   --confirm               Send for real. WITHOUT it the command is a DRY-RUN.
 *   --dry-run               Force a dry-run even with --confirm.
 *   --json                  Emit the structured InvokeRestResult.
 *   --out <file>            Also write the full structured result to a file
 *                           (pretty JSON, atomic temp+rename, OVERWRITES an
 *                           existing file; parent dir must exist). The reliable
 *                           channel for large response bodies - piped stdout is
 *                           flush-guarded but a file needs no downstream reader.
 *
 * Invoke an arbitrary authenticated REST operation (Scripted REST included).
 * Dry-run by default; --confirm sends and returns { httpStatus, ok, body } with
 * the response passed through verbatim (non-2xx included — the transport still
 * retries 429/5xx first). Bodies are NEVER printed in human output — request or
 * response, dry-run or sent: method, path and status only. The structured
 * --json result is the one channel that carries them (a dry-run's requestBody
 * echo satisfies the #212 "echo the plan" gate there).
 * Exit codes: 0 dry-run or 2xx, 1 bad args, 2 sent but non-2xx.
 */
async function runInvokeRest(flags: Record<string, string>): Promise<number> {
  if (!flags.method || !flags.path) {
    process.stderr.write(
      "invoke-rest: --method <GET|POST|PUT|DELETE> and --path </api/...> are required\n",
    );
    return 1;
  }
  var body: unknown;
  if (flags["body-json"]) {
    try {
      body = JSON.parse(fs.readFileSync(flags["body-json"], "utf8"));
    } catch (err: any) {
      process.stderr.write(
        "invoke-rest: --body-json must point to a readable JSON file: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
      return 1;
    }
  } else if (flags.body !== undefined) {
    try {
      body = JSON.parse(flags.body);
    } catch (err: any) {
      process.stderr.write(
        "invoke-rest: --body must be valid JSON: " + err.message + "\n",
      );
      return 1;
    }
  }
  var params: InvokeRestParams = {
    method: flags.method,
    path: flags.path,
    confirm: flags.confirm === "true",
    dryRun: flags["dry-run"] === "true",
  };
  if (body !== undefined) {
    params.body = body;
  }
  var result = await invokeRest(params);
  if (flags.out) {
    try {
      writeInvokeRestResultFile(flags.out, result);
    } catch (err) {
      process.stderr.write(
        "invoke-rest: --out write failed: " +
          (err instanceof Error ? err.message : String(err)) +
          "\n",
      );
      return 1;
    }
  }
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.status === "dry-run") {
    process.stdout.write(
      "[dry-run] " +
        result.method +
        " " +
        result.path +
        "\n" +
        (result.requestBody !== undefined
          ? "Request body withheld from human output — use --json to view.\n"
          : "") +
        result.note +
        "\n",
    );
  } else {
    // Bodies are never logged: human output is method + path + status only.
    process.stdout.write(
      "[sent] " +
        result.method +
        " " +
        result.path +
        " -> HTTP " +
        result.httpStatus +
        (result.ok ? "" : " (non-2xx)") +
        "\n" +
        "Response body withheld from human output — use --json for { httpStatus, ok, body }.\n",
    );
  }
  if (result.status === "sent" && result.ok !== true) {
    return 2;
  }
  return 0;
}

/**
 * dove-sn publish-app:
 *   --app <scope|sys_id|name>   Required. The sys_app to publish.
 *   --version <v>               Required. Version to publish (e.g. 6.0.20260716).
 *   --target <t[,t...]>         Required. store | repo | repo-ui | update-set |
 *                               both (= store,repo). STORE IS EXTERNALLY VISIBLE.
 *                               repo   = CI/CD REST API (needs the sn_cicd plugin)
 *                               repo-ui= same destination over the UI uploader,
 *                                        for instances without sn_cicd
 *                               update-set = publish the app INTO a new update set
 *   [--dev-notes <text>]        Optional developer notes (uploader targets).
 *   [--update-set-name <name>]  update-set only. Defaults to the app's name.
 *   [--update-set-description <text>]
 *                               update-set only. Tenon convention is the release
 *                               date stamp (YYYYMMDD) so a release is one query.
 *   [--include-data]            update-set only. Include demo data (default off,
 *                               matching the observed wire value).
 *   [--store-user <email>]      Store account email (else SN_STORE_USERNAME).
 *                               The password comes ONLY from SN_STORE_PASSWORD —
 *                               there is no flag for it, ever.
 *   [--timeout-ms <n>]          Progress-poll budget (default 120000).
 *   [--dry-run] [--json] [--confirm]
 *
 * DRY-RUN unless --confirm: without it the resolved plan is printed and the
 * command exits 1 (a deliberate refusal, not success). Multiple targets run
 * sequentially with the same version and short-circuit on the first failure;
 * --json emits an array of per-target results.
 * Exit codes: 0 published/dry-run, 1 bad args/unconfirmed, 2 failed/timeout.
 */
async function runPublishApp(flags: Record<string, string>): Promise<number> {
  var app = flags.app;
  var version = flags.version;
  var target = flags.target;
  if (!app || !version || !target) {
    process.stderr.write(
      "publish-app: --app, --version and --target <" +
        PUBLISH_TARGETS.join("|") +
        "|both> are required\n",
    );
    return 1;
  }
  var parsedTargets = parsePublishTargets(target);
  if (parsedTargets.error) {
    process.stderr.write("publish-app: " + parsedTargets.error + "\n");
    return 1;
  }
  var targets: Array<PublishTarget> = parsedTargets.targets;
  var dryRun = flags["dry-run"] === "true";
  var confirmed = flags.confirm === "true";
  var client = createClient({});

  var results: Array<PublishAppResult> = [];
  var exitCode = 0;
  for (var i = 0; i < targets.length; i += 1) {
    var params: PublishAppParams = {
      client: client,
      app: app,
      version: version,
      target: targets[i],
      confirm: confirmed,
      dryRun: dryRun,
    };
    if (flags["dev-notes"]) params.devNotes = flags["dev-notes"];
    if (flags["store-user"]) params.storeUsername = flags["store-user"];
    if (flags["update-set-name"]) {
      params.updateSetName = flags["update-set-name"];
    }
    // Read with !== undefined, not truthiness: an intentionally empty
    // description must stay empty rather than silently fall back.
    if (flags["update-set-description"] !== undefined) {
      params.updateSetDescription = flags["update-set-description"];
    }
    if (flags["include-data"] === "true") params.includeData = true;
    if (flags["timeout-ms"]) {
      // A NaN timeout would make the poll-loop budget check always false —
      // an infinite loop. Validate here, exit 1 on garbage.
      var timeoutMs = Number(flags["timeout-ms"]);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        process.stderr.write(
          "publish-app: --timeout-ms must be a positive integer (got '" +
            flags["timeout-ms"] +
            "')\n",
        );
        return 1;
      }
      params.timeoutMs = timeoutMs;
    }
    var result = await publishApp(params);
    results.push(result);
    if (flags.json !== "true") {
      process.stdout.write(
        "[" +
          result.status +
          "] " +
          result.target +
          " — " +
          result.appName +
          " (" +
          result.appScope +
          ") v" +
          result.version +
          (result.appLink ? " — " + result.appLink : "") +
          (result.updateSetSysId
            ? " — update set " + result.updateSetSysId
            : "") +
          "\n" +
          result.note +
          "\n",
      );
    }
    if (result.status === "failed" || result.status === "timeout") {
      exitCode = 2;
      break; // Short-circuit: never repo-publish after a failed store leg.
    }
  }
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  }
  if (exitCode === 0 && !dryRun && !confirmed) {
    process.stderr.write(
      "publish-app: refusing to publish without --confirm (the plan above is a dry-run).\n",
    );
    return 1;
  }
  return exitCode;
}

/**
 * dove-sn export-update-set:
 *   --update-set <sys_id|name>  Required. The set to export.
 *   [--mode assemble|complete]  assemble (default) is READ-ONLY; complete marks
 *                               the set complete on the instance first, which is
 *                               a real write and needs --confirm.
 *   [--out <file>]              Write the XML here (default: stdout is NOT used —
 *                               a document this size belongs in a file).
 *   [--rules <file>]            JSON overrides for the secret rules.
 *   [--page-size <n>] [--max-rows <n>]
 *   [--dry-run] [--json] [--confirm]
 *
 * Secret values are ALWAYS replaced with __SET_DURING_INSTALL__; there is no
 * opt-out flag. A field that looks secret and is covered by no rule fails the
 * run, and nothing is written.
 * Exit codes: 0 exported/dry-run, 1 bad args/unconfirmed, 2 failed.
 */
async function runExportUpdateSet(
  flags: Record<string, string>,
): Promise<number> {
  var selector = flags["update-set"];
  if (!selector) {
    process.stderr.write(
      "export-update-set: --update-set <sys_id|name> is required\n",
    );
    return 1;
  }
  var mode = flags.mode || "assemble";
  if (mode !== "assemble" && mode !== "complete") {
    process.stderr.write(
      "export-update-set: --mode must be assemble or complete\n",
    );
    return 1;
  }
  var outPath = flags.out;
  if (!outPath && flags["dry-run"] !== "true") {
    process.stderr.write(
      "export-update-set: --out <file> is required for a real export\n",
    );
    return 1;
  }
  var pageSize = undefined;
  if (flags["page-size"]) {
    pageSize = Number(flags["page-size"]);
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      process.stderr.write(
        "export-update-set: --page-size must be a positive integer\n",
      );
      return 1;
    }
  }
  var maxRows = undefined;
  if (flags["max-rows"]) {
    maxRows = Number(flags["max-rows"]);
    if (!Number.isInteger(maxRows) || maxRows < 1) {
      process.stderr.write(
        "export-update-set: --max-rows must be a positive integer\n",
      );
      return 1;
    }
  }

  var result = await exportUpdateSet({
    updateSet: selector,
    mode: mode as ExportMode,
    confirm: flags.confirm === "true",
    dryRun: flags["dry-run"] === "true",
    rulesPath: flags.rules,
    pageSize: pageSize,
    maxRows: maxRows,
  });

  if (result.status === "exported" && result.xml && outPath) {
    fs.writeFileSync(path.resolve(outPath), result.xml, "utf8");
  }
  writeExportReceipt(flags, result, outPath);
  if (result.status === "failed") {
    return 2;
  }
  if (result.status === "dry-run" && flags["dry-run"] !== "true") {
    return 1;
  }
  return 0;
}

/** Shared receipt for both export verbs. */
function writeExportReceipt(
  flags: Record<string, string>,
  result: {
    status: string;
    note: string;
    secretFields: Array<{ table: string; field: string }>;
  },
  outPath?: string,
): void {
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    "[" +
      result.status +
      "]" +
      (outPath && result.status === "exported"
        ? " " + path.resolve(outPath)
        : "") +
      "\n" +
      result.note +
      "\n",
  );
  if (result.secretFields.length > 0) {
    process.stdout.write("Set these after loading the package:\n");
    for (var i = 0; i < result.secretFields.length; i += 1) {
      process.stdout.write(
        "  " +
          result.secretFields[i].table +
          "." +
          result.secretFields[i].field +
          "\n",
      );
    }
  }
}

/**
 * dove-sn export-app:
 *   --app <scope|sys_id|name>   Required. The sys_app to publish and export.
 *   [--version <v>]             Publish version (default: the app's current one).
 *   [--description <text>]      Recorded on the update set.
 *   [--include-data]            Ship table DATA as well as schema (off by default).
 *   --out <file>                Where to write the XML.
 *   [--rules <file>] [--timeout-ms <n>]
 *   [--dry-run] [--json] [--confirm]
 *
 * PUBLISHING IS A REAL INSTANCE WRITE — a new update set and ~1000+ records.
 * DRY-RUN BY DEFAULT. Secret values are always stripped before the file lands.
 * Exit codes: 0 exported/dry-run, 1 bad args/unconfirmed, 2 failed/timeout.
 */
async function runExportApp(flags: Record<string, string>): Promise<number> {
  var app = flags.app;
  if (!app) {
    process.stderr.write("export-app: --app <scope|sys_id|name> is required\n");
    return 1;
  }
  var outPath = flags.out;
  if (!outPath && flags["dry-run"] !== "true") {
    process.stderr.write(
      "export-app: --out <file> is required for a real export\n",
    );
    return 1;
  }
  var timeoutMs = undefined;
  if (flags["timeout-ms"]) {
    timeoutMs = Number(flags["timeout-ms"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      process.stderr.write(
        "export-app: --timeout-ms must be a positive integer\n",
      );
      return 1;
    }
  }

  var result = await exportApp({
    app: app,
    version: flags.version,
    description: flags.description,
    includeData: flags["include-data"] === "true",
    keepSet: flags["keep-set"] !== "false",
    confirm: flags.confirm === "true",
    dryRun: flags["dry-run"] === "true",
    rulesPath: flags.rules,
    timeoutMs: timeoutMs,
  });

  if (result.status === "exported" && result.xml && outPath) {
    fs.writeFileSync(path.resolve(outPath), result.xml, "utf8");
  }
  writeExportReceipt(flags, result, outPath);
  if (result.status === "failed" || result.status === "timeout") {
    return 2;
  }
  if (result.status === "dry-run" && flags["dry-run"] !== "true") {
    return 1;
  }
  return 0;
}

/**
 * dove-sn strip-secrets:
 *   --in <file>                 Required. An unload XML exported earlier.
 *   --out <file>                Required unless --report.
 *   [--rules <file>]            JSON overrides for the secret rules.
 *   [--report]                  List what WOULD be stripped and what needs review;
 *                               writes nothing.
 *   [--json]
 *
 * Exists for documents produced outside these verbs. Exit codes: 0 clean,
 * 1 bad args, 2 blocked (a field needs review, or a secret survived).
 */
async function runStripSecrets(flags: Record<string, string>): Promise<number> {
  var inPath = flags.in;
  if (!inPath) {
    process.stderr.write("strip-secrets: --in <file> is required\n");
    return 1;
  }
  var report = flags.report === "true";
  var outPath = flags.out;
  if (!report && !outPath) {
    process.stderr.write(
      "strip-secrets: --out <file> is required (or pass --report)\n",
    );
    return 1;
  }
  var xml = "";
  try {
    xml = fs.readFileSync(path.resolve(inPath), "utf8");
  } catch (e) {
    process.stderr.write("strip-secrets: cannot read " + inPath + "\n");
    return 1;
  }
  var rules = loadSecretRules(flags.rules);
  var result;
  try {
    result = stripSecrets(xml, rules, { allowUnreviewed: report });
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    return 2;
  }
  if (!report && outPath) {
    fs.writeFileSync(path.resolve(outPath), result.xml, "utf8");
  }
  if (flags.json === "true") {
    process.stdout.write(
      JSON.stringify(
        {
          recordsScanned: result.recordsScanned,
          secretFields: result.secretFields,
          reviewFindings: result.reviewFindings,
          written: report ? null : path.resolve(outPath as string),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      "[" +
        (report ? "report" : "stripped") +
        "] " +
        result.recordsScanned +
        " record(s), " +
        result.secretFields.length +
        " secret value(s)" +
        (report ? "" : " → " + path.resolve(outPath as string)) +
        "\n",
    );
    for (var i = 0; i < result.reviewFindings.length; i += 1) {
      process.stdout.write(
        "  NEEDS REVIEW " +
          result.reviewFindings[i].table +
          "." +
          result.reviewFindings[i].field +
          " (matched '" +
          result.reviewFindings[i].matched +
          "')\n",
      );
    }
  }
  return report && result.reviewFindings.length > 0 ? 2 : 0;
}

/**
 * Which help, if any, the invocation asks for. `null` means "run the verb".
 *   dove-sn / dove-sn help / dove-sn --help            → { verb: "" }   (index)
 *   dove-sn help <verb> / dove-sn --help <verb>        → { verb }
 *   dove-sn <verb> --help                              → { verb }
 */
function resolveHelpRequest(parsed: ParsedArgs): { verb: string } | null {
  if (parsed.command === "help") {
    return { verb: parsed.positional.length > 0 ? parsed.positional[0] : "" };
  }
  if (parsed.flags.help !== undefined) {
    if (parsed.command) return { verb: parsed.command };
    // `--help add-choices`: the parser read the verb as the flag's value.
    return { verb: parsed.flags.help === "true" ? "" : parsed.flags.help };
  }
  if (!parsed.command) return { verb: "" };
  return null;
}

/** Print the index or one verb's usage. Unknown verb → closest matches on stderr, exit 1. */
function runHelp(rawVerb: string): number {
  if (!rawVerb) {
    process.stdout.write(formatVerbIndex());
    return 0;
  }
  var verb = normalizeVerbInput(rawVerb);
  if (!isKnownVerb(verb)) {
    process.stderr.write(formatUnknownVerb(rawVerb));
    return 1;
  }
  process.stdout.write(formatVerbUsage(verb));
  return 0;
}

/**
 * A thrown bad-args error — the `Missing required flags: ...` family and its
 * `<verb>: --x and --y are required` cousins. These get the verb's usage block appended;
 * anything else (auth, HTTP, verify) is reported as before.
 */
function isUsageError(err: Error): boolean {
  return /\brequired\b|\binvalid --/i.test(err.message);
}

export async function main(argv: Array<string>): Promise<number> {
  var parsed = parseArgs(argv);
  // Help never needs credentials: answer it BEFORE the env file is read or any verb can
  // build a client, so `<verb> --help` is provably offline.
  var help = resolveHelpRequest(parsed);
  if (help) return runHelp(help.verb);
  if (!isKnownVerb(parsed.command)) {
    process.stderr.write(formatUnknownVerb(parsed.command));
    return 1;
  }
  // Load credentials before any command runs. `--env`/`--env-file` (or the
  // DOVETAIL_ENV_FILE env var) selects a specific file so one checkout can
  // target multiple instances; otherwise the cwd `.env` is used.
  loadEnvFile(parsed.flags.env || parsed.flags["env-file"]);
  var code: number;
  try {
    code = await dispatch(parsed);
  } catch (err) {
    if (!(err instanceof Error) || !isUsageError(err)) throw err;
    process.stderr.write(
      "dove-sn error: " + err.message + "\n\n" + formatVerbUsage(parsed.command),
    );
    return 1;
  }
  // Exit 1 is the verbs' bad-args code (a missing flag, a refused value, an unconfirmed
  // run). The verb already said what was wrong; point at where the fix is documented.
  if (code === 1) {
    process.stderr.write(
      "Run `dove-sn help " + parsed.command + "` for flags, value formats and an example.\n",
    );
  }
  return code;
}

async function dispatch(parsed: ParsedArgs): Promise<number> {
  if (parsed.command === "add-choices") {
    return await runAddChoices(parsed.flags, parsed.bare);
  }
  if (parsed.command === "remove-choices") {
    return await runRemoveChoices(parsed.flags, parsed.bare);
  }
  if (parsed.command === "build-flow") {
    return await runBuildFlowCmd(parsed.flags);
  }
  if (parsed.command === "view-flow") {
    return await runViewFlow(parsed.flags);
  }
  if (parsed.command === "view-action") {
    return await runViewAction(parsed.flags);
  }
  if (parsed.command === "publish-flow") {
    return await runPublishFlow(parsed.flags);
  }
  if (parsed.command === "copy-flow") {
    return await runCopyFlow(parsed.flags);
  }
  if (parsed.command === "create-flow") {
    return await runCreateFlow(parsed.flags);
  }
  if (parsed.command === "create-table") {
    return await runCreateTable(parsed.flags);
  }
  if (parsed.command === "invoke-rest") {
    return await runInvokeRest(parsed.flags);
  }
  if (parsed.command === "add-column") {
    return await runAddColumn(parsed.flags);
  }
  if (parsed.command === "add-index") {
    return await runAddIndex(parsed.flags);
  }
  if (parsed.command === "index-list") {
    return await runIndexList(parsed.flags);
  }
  if (parsed.command === "index-create") {
    return await runIndexCreate(parsed.flags);
  }
  if (parsed.command === "set-column") {
    return await runSetColumn(parsed.flags, parsed.bare);
  }
  if (parsed.command === "set-table") {
    return await runSetTable(parsed.flags, parsed.bare);
  }
  if (parsed.command === "set-field") {
    return await runSetField(parsed.flags);
  }
  if (parsed.command === "create-record") {
    return await runCreateRecord(parsed.flags);
  }
  if (parsed.command === "delete-record") {
    return await runDeleteRecord(parsed.flags);
  }
  if (parsed.command === "host-assets") {
    return await runHostAssets(parsed.flags);
  }
  if (parsed.command === "test-flow") {
    return await runTestFlow(parsed.flags);
  }
  if (parsed.command === "edit-flow") {
    return await runEditFlow(parsed.flags);
  }
  if (parsed.command === "edit-action") {
    return await runEditAction(parsed.flags);
  }
  if (parsed.command === "clone-action") {
    return await runCloneAction(parsed.flags, parsed.bare);
  }
  if (parsed.command === "define-action") {
    return await runDefineAction(parsed.flags, parsed.bare);
  }
  if (parsed.command === "create-view") {
    await runCreateView(parsed.flags);
    return 0;
  }
  if (parsed.command === "set-list-layout") {
    await runSetListLayout(parsed.flags);
    return 0;
  }
  if (parsed.command === "set-form-layout") {
    await runSetFormLayout(parsed.flags);
    return 0;
  }
  if (parsed.command === "set-related-lists") {
    await runSetRelatedLists(parsed.flags);
    return 0;
  }
  if (parsed.command === "publish-app") {
    return await runPublishApp(parsed.flags);
  }
  if (parsed.command === "export-update-set") {
    return await runExportUpdateSet(parsed.flags);
  }
  if (parsed.command === "export-app") {
    return await runExportApp(parsed.flags);
  }
  if (parsed.command === "strip-secrets") {
    return await runStripSecrets(parsed.flags);
  }
  if (parsed.command === "mcp") {
    return await runMcp(parsed.flags);
  }
  if (parsed.command === "help") {
    return runHelp(parsed.positional.length > 0 ? parsed.positional[0] : "");
  }
  // main() already rejected an unknown verb; reaching here means a dispatch site is
  // missing for a verb that IS in VERB_USAGE (cliHelp.test.ts catches that too).
  throw new Error("No dispatch site for verb: " + normalizeVerbInput(parsed.command));
}

/**
 * process.exit() discards buffered stdout/stderr - when stdout is a PIPE,
 * anything past the OS pipe buffer (~64KB) is silently dropped, which is how
 * `invoke-rest --json` used to truncate large bodies mid-string. Queue an
 * empty chunk behind any pending data on each stream and exit only when both
 * callbacks confirm the flush. The barrier is queued UNCONDITIONALLY (not
 * gated on writableLength) so the exit never races stream internals about
 * whether a prior write is still in flight.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  var pending = 0;
  var finish = function (): void {
    pending -= 1;
    if (pending <= 0) {
      process.exit(code);
    }
  };
  [process.stdout, process.stderr].forEach(function (stream) {
    if (stream.destroyed || !stream.writable) {
      return;
    }
    pending += 1;
    try {
      stream.write("", finish);
    } catch (writeErr) {
      // A stream that rejects the barrier write has nothing left to flush.
      pending -= 1;
    }
  });
  if (pending === 0) {
    process.exit(code);
  }
}

// Only the `dove-sn` binary runs main(); importing this module (tests) must not.
if (require.main === module) {
  // A closed downstream pipe (e.g. `dove-sn ... --json | head`) surfaces as an
  // EPIPE on stdout. Exit quietly with the code already set instead of crashing
  // with an unhandled stream error.
  process.stdout.on("error", function (err: NodeJS.ErrnoException) {
    if (err && err.code === "EPIPE") {
      process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    }
    throw err;
  });

  main(process.argv.slice(2))
    .then(function (code) {
      exitAfterFlush(code);
    })
    .catch(function (err) {
      process.stderr.write(
        "dove-sn error: " +
          (err && err.message ? err.message : String(err)) +
          "\n",
      );
      exitAfterFlush(1);
    });
}
