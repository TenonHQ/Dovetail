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
import * as path from "path";
import { loadEnvFile } from "./loadEnv";
import { createClient } from "./client";
import { addChoicesToField } from "./choices";
import { formatAddChoicesResult } from "./formatter";
import { createView } from "./layout/views";
import { setListLayout } from "./layout/listLayout";
import { setFormLayout } from "./layout/formLayout";
import { setRelatedLists } from "./layout/relatedLists";
import { formatLayoutResult, formatCreateViewResult } from "./layout/formatter";
import { runStdio, runSmoke } from "./mcp/server";
import { runBuildFlow } from "./flowDesigner/buildFlowOrchestrator";
import { formatBuildFlowResult } from "./flowDesigner-formatter";
import { readFlow } from "./flowDesigner/readFlow";
import { readActionType } from "./flowDesigner/readActionType";
import { publishFlow } from "./flowDesigner/publishFlow";
import { copyFlow } from "./flowDesigner/copyFlow";
import { createFlow } from "./flowDesigner/createFlow";
import { editFlow } from "./flowDesigner/editFlow";
import { editActionType } from "./flowDesigner/editActionType";
import { testFlow } from "./flowDesigner/testFlow";
import { createTable, addColumn } from "./table";
import type { ColumnSpec, CreateTableParams, AddColumnParams } from "./table";
import { setField } from "./setField";
import type { SetFieldParams } from "./setField";
import { createRecord } from "./createRecord";
import type { CreateRecordParams } from "./createRecord";
import { hostAssets, formatHostAssetsResult } from "./hostAssets";
import {
  formatReadFlowResult,
  formatReadActionTypeResult,
} from "./flowDesigner-formatter";
import type {
  AddChoicesParams,
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

async function runAddChoices(flags: Record<string, string>): Promise<void> {
  var params = paramsFromFlags(flags);
  var client = createClient({});
  var result = await addChoicesToField(client, params);
  if (flags.json === "true") {
    process.stdout.write(
      JSON.stringify({ params: params, result: result }, null, 2) + "\n",
    );
    return;
  }
  process.stdout.write(
    formatAddChoicesResult(params.table, params.column, result) + "\n",
  );
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
 *   --patch-script "<find>::<replace>" Optional. Find/replace in the script step value.
 *   --set-script <path>                Optional. Replace the script step value from a file.
 *   --merge-outputs <path>             Optional. JSON file: an output-variable object/array to merge by name.
 *   --script-input <name>              Optional. Input name holding the script (default: auto-detect).
 *   --update-set <sys_id>              Optional. Capture the republish into this update set.
 *   --apply                            Optional. Republish (POST /snapshot). Omit for dry-run.
 *   --json                             Optional. Emit the structured EditActionTypeResult.
 *
 * Edits a published Custom Action Type's script and/or output variables and
 * republishes through the snapshot POST. Dry-run (read-only) by default; --apply writes.
 */
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

function printHelp(): void {
  process.stdout.write(
    "dove-sn — ServiceNow platform helpers\n\n" +
      "Commands:\n" +
      "  add-choices        Upsert sys_choice rows for a table.column\n" +
      "  create-view        Create a custom view (sys_ui_view)\n" +
      "                     (--name <n> --update-set <sys_id> [--title <t>] [--scope <s>] [--dry-run] [--json])\n" +
      "  set-list-layout    Set the columns of a list layout\n" +
      "                     (--from-json <path>  OR  --table <t> --columns a,b,c --update-set <sys_id>\n" +
      "                      [--view <v>] [--parent <t>] [--scope <s>] [--prune false] [--dry-run] [--json])\n" +
      "  set-form-layout    Set the sections + fields of a form layout\n" +
      "                     (--from-json <path> [--update-set <sys_id>] [--dry-run] [--json])\n" +
      "  set-related-lists  Set which related lists appear on a form\n" +
      "                     (--from-json <path>  OR  --table <t> --related-lists a,b --update-set <sys_id>\n" +
      "                      [--view <v>] [--scope <s>] [--prune false] [--dry-run] [--json])\n" +
      "  build-flow         Author Custom Action Types and Subflows from a JSON spec\n" +
      "                     (--from-json <path> [--update-set <sys_id>] [--dry-run] [--skip-publish] [--json])\n" +
      "  view-flow          Read a flow/subflow's compiled step graph (read-only)\n" +
      "                     (--sys-id <sys_id> [--json] [--raw])\n" +
      "  view-action        Read a Custom Action Type's model — inputs/outputs (read-only)\n" +
      "                     (--sys-id <sys_id> --scope <sys_id> [--json] [--raw])\n" +
      "  publish-flow       Compile a flow/subflow snapshot (write)\n" +
      "                     (--sys-id <sys_id> [--scope <sys_id>] [--json])\n" +
      "  copy-flow          Copy a flow/subflow (inactive draft) via the Designer Copy API\n" +
      "                     (--sys-id <sys_id> --name <name> [--scope <sys_id>] [--json])\n" +
      "  create-flow        Create a NEW flow (type=flow) from scratch + publish (grafts a template)\n" +
      "                     (--name <n> --template <sys_id> --scope <sys_id>\n" +
      "                      [--trigger-table <t>] [--trigger-condition <q>] [--log-message <m>]\n" +
      "                      [--internal-name <n>] [--description <d>] [--dry-run] [--json])\n" +
      "  create-table       Create a NEW table (sys_db_object) WITH columns, via the Studio form save\n" +
      "                     (--name <x_scope_t> --label <l> --scope <s>\n" +
      '                      --columns "Label:type:max, ..."  OR  --from-json <spec.json>\n' +
      "                      [--extends <t>] [--number-prefix <p>] [--user-role <r>]\n" +
      "                      [--no-acls] [--no-menu] [--update-set <sys_id>] [--dry-run] [--json])\n" +
      "  add-column         Add ONE column to an EXISTING table via a scope-aware sys_dictionary insert, then verify\n" +
      "                     (--table <name|sys_id> --label <l> --type <t> --update-set <sys_id>\n" +
      "                      [--name <element>] [--max-length <n>] [--reference <table>]\n" +
      "                      [--mandatory] [--default <v>] [--scope <s>] [--dry-run] [--json])\n" +
      "                     --update-set is REQUIRED on the live path (not for --dry-run).\n" +
      "  set-field          Set scalar field value(s) on an EXISTING record, into an update set, then verify\n" +
      '                     (--table <t> --sys-id <id>|--query <q> --fields "k=v,k2=v2"\n' +
      "                      --update-set <sys_id> [--dry-run] [--json])\n" +
      "  create-record      Create ONE NEW record in a data table, into an update set, then verify\n" +
      '                     (--table <t> --fields "k=v,k2=v2" --scope <s> --update-set <sys_id>\n' +
      "                      [--if-absent <encoded-query>] [--dry-run] [--json])\n" +
      "  host-assets        Deploy a built dist/ to ServiceNow (carrier sys_ui_script + attachment + m2m)\n" +
      "                     (--dir <dist> --app <sys_id> --scope <namespace>\n" +
      "                      [--update-set <sys_id>] [--max-bytes <n>] [--allow-oversize] [--dry-run] [--json])\n" +
      "  test-flow          Validate (default) or run a flow/subflow\n" +
      "                     (--sys-id <sys_id> [--execute --confirm] [--inputs <json>] [--json])\n" +
      "  edit-flow          Patch a flow/subflow (rename, description, step inputs)\n" +
      "                     (--sys-id <sys_id> --from-json <ops.json> [--apply] [--update-set <sys_id>] [--scope <sys_id>] [--json])\n" +
      "  mcp                Run the MCP stdio server (--smoke lists tools and exits)\n" +
      "\nGlobal flags:\n" +
      "  --env <path>       Load credentials from a specific .env file (also --env-file,\n" +
      "                     or the DOVETAIL_ENV_FILE env var). Default: .env in the cwd.\n",
  );
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
 *   [--mandatory] [--default <value>]
 *   [--scope x_cadso_journey] [--update-set <sys_id>]
 *   [--from-json <spec.json>] [--dry-run] [--debug] [--json]
 * --update-set is required unless --dry-run.
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
  var us = flags["update-set"] || spec.updateSetSysId;
  if (us) params.updateSetSysId = us;
  if (flags["dry-run"] === "true" || spec.dryRun === true) params.dryRun = true;
  if (flags.debug === "true" || spec.debug === true) params.debug = true;

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

/** Parse inline `--fields "k=v, k2=v2"` into a field map. */
function parseFieldsInline(input: string): Record<string, string> {
  var out: Record<string, string> = {};
  if (!input) return out;
  var parts = input.split(",");
  for (var i = 0; i < parts.length; i += 1) {
    var piece = parts[i].trim();
    if (!piece) continue;
    var eq = piece.indexOf("=");
    if (eq === -1) continue;
    var key = piece.slice(0, eq).trim();
    if (key) out[key] = piece.slice(eq + 1).trim();
  }
  return out;
}

/**
 * dove-sn set-field:
 *   --table x_cadso_core_metric_point_type
 *   --sys-id <id>  |  --query "name=send_size"   (query must resolve to exactly 1 row)
 *   --fields "order=20"                          (comma-separated key=value pairs)
 *   --update-set <sys_id>                        (required — the change is captured here)
 *   [--dry-run] [--json]
 * Exit codes: 0 applied/dry-run, 1 bad args, 2 write landed but read-back unverified.
 */
async function runSetField(flags: Record<string, string>): Promise<number> {
  var table = flags.table;
  var fields = parseFieldsInline(flags.fields || "");
  var hasTarget = Boolean(flags["sys-id"] || flags.query);
  if (
    !table ||
    Object.keys(fields).length === 0 ||
    !hasTarget ||
    !flags["update-set"]
  ) {
    process.stderr.write(
      'set-field: --table, --fields "k=v", one of --sys-id/--query, and --update-set are required\n',
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
 *   --fields "name=avg_message_parts,label=Avg. Message Parts,order=35"
 *   --scope x_cadso_core                         (the app that owns the new record)
 *   --update-set <sys_id>                        (required — the insert is captured here)
 *   [--if-absent "name=avg_message_parts"]       (skip the insert when this query already matches)
 *   [--dry-run] [--json]
 * Exit codes: 0 created/skipped-in-sync/dry-run, 1 bad args, 2 write landed but read-back unverified
 * (or skipped with drift).
 */
async function runCreateRecord(flags: Record<string, string>): Promise<number> {
  var table = flags.table;
  var fields = parseFieldsInline(flags.fields || "");
  if (
    !table ||
    Object.keys(fields).length === 0 ||
    !flags.scope ||
    !flags["update-set"]
  ) {
    process.stderr.write(
      'create-record: --table, --fields "k=v", --scope and --update-set are required\n',
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

async function main(): Promise<number> {
  var parsed = parseArgs(process.argv.slice(2));
  // Load credentials before any command runs. `--env`/`--env-file` (or the
  // DOVETAIL_ENV_FILE env var) selects a specific file so one checkout can
  // target multiple instances; otherwise the cwd `.env` is used.
  loadEnvFile(parsed.flags.env || parsed.flags["env-file"]);
  if (parsed.command === "add-choices") {
    await runAddChoices(parsed.flags);
    return 0;
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
  if (parsed.command === "add-column") {
    return await runAddColumn(parsed.flags);
  }
  if (parsed.command === "set-field") {
    return await runSetField(parsed.flags);
  }
  if (parsed.command === "create-record") {
    return await runCreateRecord(parsed.flags);
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
  if (parsed.command === "mcp") {
    return await runMcp(parsed.flags);
  }
  if (
    !parsed.command ||
    parsed.command === "help" ||
    parsed.flags.help === "true"
  ) {
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
    process.stderr.write(
      "sinc-sn error: " +
        (err && err.message ? err.message : String(err)) +
        "\n",
    );
    process.exit(1);
  });
