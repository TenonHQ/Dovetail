/**
 * MCP tool registration for @tenonhq/dovetail-servicenow. Mirrors the descriptor
 * + handler pattern from @tenonhq/dovetail-claude-plans. Handlers stay thin —
 * validation lives in the zod schemas, behaviour in the layout/choices modules.
 *
 * Each handler builds a ServiceNowClient from the environment (SN_* vars) unless
 * a client is injected via RegistryDeps (used by tests).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  READ_ONLY,
  WRITE_ADDITIVE_IDEMPOTENT,
  WRITE_CREATE,
  WRITE_OVERWRITE,
  WRITE_EXECUTE,
  registerKitTools,
} from "@tenonhq/dovetail-mcp-kit";
import type { ToolAnnotations } from "@tenonhq/dovetail-mcp-kit";

import { createClient } from "../client";
import type { ServiceNowClient } from "../client";
import { createView } from "../layout/views";
import { setListLayout } from "../layout/listLayout";
import { setFormLayout } from "../layout/formLayout";
import { setRelatedLists } from "../layout/relatedLists";
import { addChoicesToField, removeChoicesFromField } from "../choices";
import { readFlow } from "../flowDesigner/readFlow";
import { readActionType } from "../flowDesigner/readActionType";
import { publishFlow } from "../flowDesigner/publishFlow";
import { copyFlow } from "../flowDesigner/copyFlow";
import { createFlow } from "../flowDesigner/createFlow";
import { editFlow } from "../flowDesigner/editFlow";
import { editActionType } from "../flowDesigner/editActionType";
import { cloneActionType } from "../flowDesigner/cloneActionType";
import { defineActionType } from "../flowDesigner/defineActionType";
import type { DefineActionSpec } from "../flowDesigner/defineActionType";
import { testFlow } from "../flowDesigner/testFlow";
import {
  createTable,
  addColumn,
  ensureDesignAccess,
  addIndex,
  listIndexes,
  createIndex,
  setColumn,
  setTable,
} from "../table";
import { hostAssets } from "../hostAssets";
import { setField } from "../setField";
import { createRecord } from "../createRecord";
import { syncUxEvents } from "../uxEvents";
import * as fs from "fs";
import * as path from "path";
import { deleteRecord } from "../deleteRecord";
import { invokeRest } from "../invokeRest";
import type { InvokeRestParams } from "../invokeRest";
import { publishApp } from "../publishApp";
import { exportUpdateSet } from "../exportUpdateSet";
import type { ExportUpdateSetParams } from "../exportUpdateSet";
import { exportApp } from "../exportApp";
import type { ExportAppParams } from "../exportApp";
import type { PublishAppParams } from "../publishApp";
import {
  createViewSchema,
  setListLayoutSchema,
  setFormLayoutSchema,
  setRelatedListsSchema,
  addChoicesToFieldSchema,
  removeChoicesFromFieldSchema,
  viewFlowSchema,
  viewActionSchema,
  editActionSchema,
  cloneActionSchema,
  defineActionSchema,
  publishFlowSchema,
  copyFlowSchema,
  createFlowSchema,
  testFlowSchema,
  editFlowSchema,
  createTableSchema,
  addColumnSchema,
  designAccessSchema,
  addIndexSchema,
  listIndexesSchema,
  createIndexSchema,
  setColumnSchema,
  setTableSchema,
  setFieldSchema,
  createRecordSchema,
  syncUxEventsSchema,
  deleteRecordSchema,
  hostAssetsSchema,
  invokeRestSchema,
  publishAppSchema,
  exportUpdateSetSchema,
  exportAppSchema,
} from "./schemas";

export var TOOL_NAMES = [
  "create_view",
  "set_list_layout",
  "set_form_layout",
  "set_related_lists",
  "add_choices_to_field",
  "remove_choices_from_field",
  "flow_view",
  "action_view",
  "action_edit",
  "action_clone",
  "action_define",
  "flow_publish",
  "flow_copy",
  "flow_create",
  "flow_test",
  "flow_edit",
  "create_table",
  "add_column",
  "design_access",
  "add_index",
  "index_list",
  "index_create",
  "set_column",
  "set_table",
  "set_field",
  "create_record",
  "delete_record",
  "sync_ux_events",
  "host_assets",
  "invoke_rest",
  "app_publish",
  "update_set_export",
  "app_export",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface RegistryDeps {
  /** Optional client injection for tests; defaults to createClient({}). */
  client?: ServiceNowClient;
}

export interface ToolDescriptor {
  name: ToolName;
  description: string;
  shape: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: any) => Promise<any>;
}

// Annotation presets (READ_ONLY / WRITE_ADDITIVE_IDEMPOTENT / WRITE_CREATE /
// WRITE_OVERWRITE / WRITE_EXECUTE) come from @tenonhq/dovetail-mcp-kit.
// openWorldHint is left at its spec default (true) — every tool reaches a ServiceNow instance.

export function buildDescriptors(
  deps: RegistryDeps = {},
): Array<ToolDescriptor> {
  function client(): ServiceNowClient {
    return deps.client || createClient({});
  }
  return [
    {
      name: "create_view",
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
      description:
        "Create a ServiceNow custom view (sys_ui_view). Idempotent — an existing view of the " +
        "same name is returned unchanged. Every write is captured in the supplied update set.",
      shape: createViewSchema.shape,
      handler: async function (args: any) {
        return createView(client(), createViewSchema.parse(args));
      },
    },
    {
      name: "set_list_layout",
      annotations: WRITE_OVERWRITE,
      description:
        "Declaratively set a ServiceNow list layout — which columns appear in a list, and their " +
        "order — for a table + view. Idempotent; prune (default true) removes columns not in " +
        "the spec; dryRun previews without writing. Writes are captured in the update set.",
      shape: setListLayoutSchema.shape,
      handler: async function (args: any) {
        return setListLayout(client(), setListLayoutSchema.parse(args));
      },
    },
    {
      name: "set_form_layout",
      annotations: WRITE_OVERWRITE,
      description:
        "Declaratively set a ServiceNow form layout — sections and the fields within them — for " +
        "a table + view. The first section is the primary section (omit its caption). " +
        "Idempotent; prune (default true) removes sections/fields not in the spec; dryRun " +
        "previews without writing. Writes are captured in the update set.",
      shape: setFormLayoutSchema.shape,
      handler: async function (args: any) {
        return setFormLayout(client(), setFormLayoutSchema.parse(args));
      },
    },
    {
      name: "set_related_lists",
      annotations: WRITE_OVERWRITE,
      description:
        "Declaratively set which related lists appear on a ServiceNow form for a table + view. " +
        'Related-list ids are "<table>.<field>" or "REL:<sys_relationship>". Idempotent; ' +
        "prune (default true); dryRun previews. Writes are captured in the update set.",
      shape: setRelatedListsSchema.shape,
      handler: async function (args: any) {
        return setRelatedLists(client(), setRelatedListsSchema.parse(args));
      },
    },
    {
      name: "add_choices_to_field",
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
      description:
        "Upsert sys_choice values for a ServiceNow table.column and (optionally) flip " +
        "sys_dictionary.choice so the field renders as a dropdown. Idempotent. Writes are " +
        "captured in the supplied update set. dryRun:true verifies the field + update set " +
        "and reports each row as would-create / would-update / unchanged with NO write sent " +
        "(result.dryRun is true). Result envelope: field {table, column, language, scope, " +
        "dictionarySysId}, dictionary {choiceWas, choiceNow}, updateSet, dryRun, choices[].",
      shape: addChoicesToFieldSchema.shape,
      handler: async function (args: any) {
        return addChoicesToField(client(), addChoicesToFieldSchema.parse(args));
      },
    },
    {
      name: "remove_choices_from_field",
      annotations: WRITE_OVERWRITE,
      description:
        "Soft-delete sys_choice values for a ServiceNow table.column by setting inactive=true " +
        "(the row is kept, so it is reversible and historical values still resolve). Never a " +
        "hard delete. Idempotent: an already-inactive value is 'unchanged', an absent value is " +
        "'missing', and a value repeated in the request causes no extra writes — it collapses " +
        "to one result row. A single value CAN write more than once when the field holds " +
        "duplicate rows for it; every live one is deactivated. sys_dictionary.choice is left " +
        "alone. Matching is scoped by LANGUAGE (defaults to 'en'), so a value that exists only " +
        "in another language reports 'missing' and is left untouched — pass `language` to target " +
        "it. Matching is also scoped to this table, so a choice INHERITED from a parent table " +
        "reports 'missing' rather than being deactivated. Matching is CASE-SENSITIVE (choice " +
        "values are); a 'missing' row whose value exists on the field in a different case " +
        "carries nearMatches with the stored spelling(s). dryRun:true verifies the field + " +
        "update set and reports each live row as would-deactivate with NO write sent " +
        "(result.dryRun is true). Writes are captured in the supplied update set. Result " +
        "envelope: field {table, column, language, scope, dictionarySysId}, updateSet, dryRun, " +
        "choices[].",
      shape: removeChoicesFromFieldSchema.shape,
      handler: async function (args: any) {
        return removeChoicesFromField(
          client(),
          removeChoicesFromFieldSchema.parse(args),
        );
      },
    },
    {
      name: "flow_view",
      annotations: READ_ONLY,
      description:
        "Read a ServiceNow Flow Designer flow or subflow's compiled step graph, headless. " +
        "Returns the ordered, nesting-aware list of action + flow-logic steps plus the flow " +
        "variables, via GET /api/now/processflow/flow/{sysId}. Read-only. Pass raw:true to " +
        "include the full processflow model. sysId is the sys_hub_flow sys_id.",
      shape: viewFlowSchema.shape,
      handler: async function (args: any) {
        var p = viewFlowSchema.parse(args);
        return readFlow({ client: client(), sysId: p.sysId, raw: p.raw });
      },
    },
    {
      name: "action_view",
      annotations: READ_ONLY,
      description:
        "Read a ServiceNow Custom Action Type's compiled model (identity, inputs, outputs), " +
        "headless, via GET /api/now/processflow/action/action_types/{sysId}. Read-only. " +
        "sysId is the sys_hub_action_type_definition sys_id; scopeSysId is the application " +
        "scope (sysparm_transaction_scope). Pass raw:true for the full model.",
      shape: viewActionSchema.shape,
      handler: async function (args: any) {
        var p = viewActionSchema.parse(args);
        return readActionType({
          client: client(),
          sysId: p.sysId,
          scopeSysId: p.scopeSysId,
          raw: p.raw,
        });
      },
    },
    {
      name: "action_edit",
      annotations: WRITE_OVERWRITE,
      description:
        "Structurally edit a published Custom Action Type and republish it as one snapshot. " +
        "Ops: patchStepScripts (per-step script edits, step addressed by cid or label), " +
        "addStepOutputs (step-level extended_outputs), addStepInputs (step-level extended_inputs " +
        "wired to another step's output via pillFrom {step, output} — the pill format and the " +
        "entry shape are handled for you). Also supports the action-level patchScript / setScript / " +
        "mergeOutputs. DRY-RUN BY DEFAULT: without apply:true it returns the per-step before/after " +
        "diff and writes nothing. With apply:true it POSTs /snapshot, captures into updateSetSysId " +
        "when given, then reads the steps back and verifies the edit actually landed. " +
        "sysId is the sys_hub_action_type_definition sys_id; scopeSysId is the app scope.",
      shape: editActionSchema.shape,
      handler: async function (args: any) {
        var p = editActionSchema.parse(args);
        return editActionType({
          client: client(),
          sysId: p.sysId,
          scopeSysId: p.scopeSysId,
          ops: p.ops,
          apply: p.apply === true,
          updateSetSysId: p.updateSetSysId,
        });
      },
    },
    {
      name: "action_clone",
      annotations: WRITE_OVERWRITE,
      description:
        "Clone a ServiceNow Custom Action Type (sys_hub_action_type_definition) into a scope and " +
        "publish it headlessly — multi-step capable. Clones the parent, its inputs/outputs, every " +
        "step instance and each step's ext inputs/outputs (fresh sys_ids, target scope), writes them " +
        "through Dovetail createRecord pinned to updateSetSysId, then grafts the SOURCE's step graph " +
        "(remapped onto the clone) onto the model and POSTs /snapshot, and reads the steps back to " +
        "verify. Optional ops (inline StepOps) patch the cloned steps first: setStepInputs " +
        "[{step, input, value}] sets an existing input (e.g. a REST step's http_method), plus " +
        "patchStepScripts / addStepOutputs / addStepInputs as in action_edit. Idempotent: an existing " +
        "(name, scope) returns action 'unchanged' with no writes. DRY-RUN BY DEFAULT: without " +
        "confirm:true it reads everything and returns the plan (records per table, step summary, ops " +
        "effects) and writes nothing; dryRun:true forces a dry-run even with confirm. from is the " +
        "source sys_id; scope is the target scope name (e.g. x_cadso_email_spok) or sys_id; " +
        "updateSetSysId is required with confirm.",
      shape: cloneActionSchema.shape,
      handler: async function (args: any) {
        var p = cloneActionSchema.parse(args);
        return cloneActionType({
          client: client(),
          sourceSysId: p.from,
          newName: p.name,
          internalName: p.internalName,
          newScope: p.scope,
          updateSetSysId: p.updateSetSysId,
          description: p.description,
          stepOps: p.ops,
          confirm: p.confirm === true,
          dryRun: p.dryRun === true,
        });
      },
    },
    {
      name: "action_define",
      annotations: WRITE_OVERWRITE,
      description:
        "Define a Custom Action Type's body — action inputs, outputs and steps (script and REST " +
        "steps wired with data pills) — headlessly, the way the Flow Designer's Save does: GET the " +
        "model + /step_instances, merge the spec, PUT the FULL model back to " +
        "/api/now/processflow/action/action_types/{sysId}, read it back to verify; publish:true also " +
        "snapshots it. spec: { action?: {name, description, access}, inputs?: [{name, type, mandatory, " +
        "choices, default, remove}], outputs?: [{name, value: '{{steps.<ref>.<output>}}'}], steps?: [{ref, " +
        "type: 'script'|'rest', label, match?, script?, inputs? (script vars, name -> value/pill), " +
        "outputs? (script vars), values? (step-type inputs, e.g. REST base_url / http_method / headers " +
        "[{name,value}] / connection_alias sys_id)}] }. Pills: {{action.<input>}}, " +
        "{{steps.<ref>.<output>}} (resolved to {{step[<cid>].<output>}}). Steps match existing ones by " +
        "match (cid/label), label, then position; new steps get fresh cids, existing cids are kept. " +
        "Unknown keys, bad names and unknown/dangling pill references are refused before any write. " +
        "DRY-RUN BY DEFAULT: without confirm:true it returns the planned diff (inputs/outputs/steps " +
        "added/changed/removed, per-step input values) and writes nothing; dryRun:true forces a " +
        "dry-run. Idempotent: a spec already in effect returns status 'unchanged' with no PUT. The " +
        "action shell must already exist (action_clone or the Designer). sysId is the " +
        "sys_hub_action_type_definition sys_id; scope is the action's scope name or sys_id.",
      shape: defineActionSchema.shape,
      handler: async function (args: any) {
        var p = defineActionSchema.parse(args);
        return defineActionType({
          client: client(),
          sysId: p.sysId,
          scope: p.scope,
          spec: p.spec as DefineActionSpec,
          updateSetSysId: p.updateSetSysId,
          publish: p.publish === true,
          confirm: p.confirm === true,
          dryRun: p.dryRun === true,
        });
      },
    },
    {
      name: "flow_publish",
      annotations: WRITE_OVERWRITE,
      description:
        "Publish (compile the snapshot of) a ServiceNow Flow Designer flow or subflow via " +
        "POST /api/now/processflow/flow/{sysId}/snapshot. This is a WRITE that recompiles the " +
        "flow's current design — use after editing in the Designer. sysId is the sys_hub_flow " +
        "sys_id; scopeSysId defaults to the flow's own scope.",
      shape: publishFlowSchema.shape,
      handler: async function (args: any) {
        var p = publishFlowSchema.parse(args);
        return publishFlow({
          client: client(),
          sysId: p.sysId,
          scopeSysId: p.scopeSysId,
        });
      },
    },
    {
      name: "flow_copy",
      annotations: WRITE_CREATE,
      description:
        "Copy a ServiceNow flow/subflow via the Designer's Copy endpoint — a complete, faithful " +
        "clone created as an INACTIVE DRAFT in the target scope. sourceSysId is the sys_hub_flow " +
        "to copy; newName is the copy's name; scopeSysId defaults to the source's scope. Publish " +
        "with flow_publish when ready. Do NOT publish + activate a copy of a triggered production " +
        "flow unless you intend it to fire.",
      shape: copyFlowSchema.shape,
      handler: async function (args: any) {
        var p = copyFlowSchema.parse(args);
        return copyFlow({
          client: client(),
          sourceSysId: p.sourceSysId,
          newName: p.newName,
          scopeSysId: p.scopeSysId,
        });
      },
    },
    {
      name: "flow_create",
      annotations: WRITE_CREATE,
      description:
        "Create a NEW ServiceNow Flow Designer flow (sys_hub_flow, type=flow) from scratch and " +
        "PUBLISH it, headless. Mints a fresh flow via POST /processflow/flow, grafts the trigger + " +
        "action graph from an existing published template flow (templateSysId), then compiles the " +
        "snapshot — leaving a published flow (the result's `active` flag reports whether it will " +
        "fire). Unlike flow_copy (which duplicates a flow), " +
        "this creates a new flow you can re-point at a different trigger table / message. " +
        "name + templateSysId + scopeSysId are required; triggerTable / triggerCondition / " +
        "logMessage patch the grafted graph; dryRun:true returns the plan + template graph counts " +
        "without writing. WARNING: a published triggered flow can fire on its trigger — do not graft " +
        "a production send template you don't intend to fire.",
      shape: createFlowSchema.shape,
      handler: async function (args: any) {
        var p = createFlowSchema.parse(args);
        return createFlow({
          client: client(),
          name: p.name,
          templateSysId: p.templateSysId,
          scopeSysId: p.scopeSysId,
          internalName: p.internalName,
          description: p.description,
          triggerTable: p.triggerTable,
          triggerCondition: p.triggerCondition,
          logMessage: p.logMessage,
          dryRun: p.dryRun,
        });
      },
    },
    {
      name: "flow_test",
      annotations: WRITE_EXECUTE,
      description:
        "Test or run a ServiceNow flow/subflow. mode='validate' (default) is a safe, read-only " +
        "pre-flight — checks the flow is published and that supplied inputs match its declared " +
        "variables; it never runs the flow. mode='execute' actually runs it via the server-side " +
        "FlowAPI runner and REQUIRES confirm=true (running a flow can cause real side effects, " +
        "e.g. sending an SMS). sysId is the sys_hub_flow sys_id.",
      shape: testFlowSchema.shape,
      handler: async function (args: any) {
        var p = testFlowSchema.parse(args);
        return testFlow({
          client: client(),
          sysId: p.sysId,
          mode: p.mode,
          inputs: p.inputs,
          confirm: p.confirm,
          runnerPath: p.runnerPath,
        });
      },
    },
    {
      name: "flow_edit",
      annotations: WRITE_OVERWRITE,
      description:
        "Edit a ServiceNow flow/subflow in place. Supports rename (name/internalName), description, " +
        "and patchStepInputs (set named input values on steps by uiId or label). apply=false " +
        "(default) is a dry-run that returns the diff; apply=true persists the edit (a write). " +
        "Rename/description require updateSetSysId (they write sys_hub_flow via the update-set-aware " +
        "API); patchStepInputs ride a snapshot recompile. sysId is the sys_hub_flow sys_id.",
      shape: editFlowSchema.shape,
      handler: async function (args: any) {
        var p = editFlowSchema.parse(args);
        return editFlow({
          client: client(),
          sysId: p.sysId,
          ops: p.ops,
          apply: p.apply,
          scopeSysId: p.scopeSysId,
          updateSetSysId: p.updateSetSysId,
        });
      },
    },
    {
      name: "create_table",
      annotations: WRITE_CREATE,
      description:
        "Create a NEW ServiceNow table (sys_db_object) WITH its columns, headless and faithfully. " +
        "A table create is a privileged platform op — a REST/createRecord insert ORPHANS the table " +
        "(metadata row, no physical table, no ACLs). This replays the Studio form save " +
        "(POST /sys_db_object.do) so the real 36-record graph + the physical table + seeded ACLs " +
        "are created. name (x_scope_*), label, scope, and columns[] are required; extendsTable " +
        "defaults to sys_metadata; friendly column types are mapped to internal types " +
        "(string -> string_full_utf8). dryRun:true returns the plan + the column XML + the projected " +
        "graph with no session and no writes. NOTE: the live write path is pending a validated-live " +
        "spike — prefer dryRun until confirmed, and always verify the sys_update_xml landed in the " +
        "intended update set.",
      shape: createTableSchema.shape,
      handler: async function (args: any) {
        var p = createTableSchema.parse(args);
        return createTable({
          client: client(),
          name: p.name,
          label: p.label,
          scope: p.scope,
          columns: p.columns,
          extendsTable: p.extendsTable,
          numberPrefix: p.numberPrefix,
          userRole: p.userRole,
          createAccessControls: p.createAccessControls,
          access: p.access,
          showInMenu: p.showInMenu,
          updateSetSysId: p.updateSetSysId,
          saveActionSysId: p.saveActionSysId,
          dryRun: p.dryRun,
        });
      },
    },
    {
      name: "add_column",
      annotations: WRITE_CREATE,
      description:
        "Add ONE column to an EXISTING ServiceNow table, headless. Creating a column is a sys_dictionary " +
        "insert; this uses the scope-aware createRecord op (switches app scope + update set server-side, " +
        "inserts, restores) so the column lands in the right scope and update set, then READS THE COLUMN " +
        "BACK from sys_dictionary to prove it materialised (a returned sys_id with no column is reported " +
        "failed, not created). table is the table name or its sys_db_object sys_id; column is " +
        "{ label, type, name?, max_length?, reference?, mandatory?, default?, dependent_on_field? } with " +
        "friendly types mapped to internal types (string -> string_full_utf8) and reference = the target " +
        "table NAME; element is derived from label unless column.name is given. dependent_on_field names " +
        "the sibling column a document_id column resolves against (its table_name column) — it must " +
        "already exist on the table, is verified on the read-back, and is refused when absent. " +
        "scope must match the table's scope unless crossScope:true, which opts in to a column OWNED " +
        "by scope on another app's table (the platform's cross-scope field: element becomes " +
        "<scope>_<name>, the dictionary row and its update-set capture land in scope); the table " +
        "must allow new fields from other scopes (sys_db_object.alter_access) and updateSetSysId " +
        "must belong to scope and be in progress — all checked on dryRun too, and the stored element + sys_scope are " +
        "read back. A cross-scope result carries designAccess { present, sysId, created }: the " +
        "platform UI refuses cross-scope authoring without a sys_scope_design_access record " +
        "(scope -> the table's scope), so a missing one is FLAGGED (not blocking — the headless " +
        "insert works without it); ensureDesignAccess:true creates it first in the same update " +
        "set. updateSetSysId is required on the live path. dryRun:true returns the plan with " +
        "no writes.",
      shape: addColumnSchema.shape,
      handler: async function (args: any) {
        var p = addColumnSchema.parse(args);
        // The schema leaves updateSetSysId optional (dry-run doesn't need one), so
        // enforce the live-path requirement HERE — a tool-level error before any
        // work beats a failure surfacing from deep inside addColumn.
        if (
          p.dryRun !== true &&
          (!p.updateSetSysId || !p.updateSetSysId.trim())
        ) {
          throw new Error(
            "add_column: updateSetSysId is required on the live path so the " +
              "sys_dictionary insert is captured in a known update set — " +
              "set dryRun:true to plan without one.",
          );
        }
        return addColumn({
          client: client(),
          table: p.table,
          column: p.column,
          scope: p.scope,
          crossScope: p.crossScope,
          ensureDesignAccess: p.ensureDesignAccess,
          updateSetSysId: p.updateSetSysId,
          dryRun: p.dryRun,
          debug: p.debug,
        });
      },
    },
    {
      name: "design_access",
      annotations: WRITE_CREATE,
      description:
        "Ensure the sys_scope_design_access record that lets sourceScope (the AUTHORING app) " +
        "design in targetScope's tables (the app that OWNS them). The platform UI requires it " +
        "for cross-scope columns — the symptom is \"Invalid 'Table' selected on the Dictionary " +
        "Entry record ... can only select '<app>' tables with read access enabled\", and the " +
        "table's own access flags are NOT the gate. Scopes are names or sys_scope sys_ids. " +
        "Idempotent: an existing record returns status 'exists' and nothing is written. Live " +
        "creates it via the scope-aware createRecord op switched to sourceScope, captured in " +
        "updateSetSysId (must belong to sourceScope and be in progress), then reads it back and asserts " +
        "source/target and that it is owned by sourceScope. updateSetSysId is required on the live path; dryRun:true only reports " +
        "exists / missing.",
      shape: designAccessSchema.shape,
      handler: async function (args: unknown) {
        var p = designAccessSchema.parse(args);
        if (
          p.dryRun !== true &&
          (!p.updateSetSysId || !p.updateSetSysId.trim())
        ) {
          throw new Error(
            "design_access: updateSetSysId (an update set in sourceScope) is required on " +
              "the live path — set dryRun:true to only check whether the record exists.",
          );
        }
        return ensureDesignAccess({
          client: client(),
          sourceScope: p.sourceScope,
          targetScope: p.targetScope,
          updateSetSysId: p.updateSetSysId,
          dryRun: p.dryRun,
        });
      },
    },
    {
      name: "add_index",
      annotations: WRITE_OVERWRITE,
      description:
        "Create a single-column UNIQUE index on an EXISTING ServiceNow table, headless. The " +
        "ONLY headless lever is sys_dictionary.unique — sys_index fails an API-LEVEL ACL (403) " +
        "for every identity and sys_index_column does not exist — so this patches the column's " +
        "dictionary row through the update-set-aware write path and lets the platform build the " +
        "physical index off that flag, then READS IT BACK from the v_db_index view. columns is a " +
        "list but exactly one entry is supported: unique is a PER-COLUMN flag, so a composite " +
        "request is REFUSED rather than silently narrowed to a different index than the one asked " +
        "for, and unique:false is refused too (there is no dictionary lever for a plain index) — " +
        "both stay platform-UI work. Before writing, the column's values are scanned and the run " +
        "ABORTS on duplicates, EMPTY included: a unique index cannot build over them, and the " +
        "platform fails that ALTER SILENTLY, leaving a dictionary row claiming unique=true with no " +
        "index behind it (the x_cadso_core_metric_point.idempotency_key trap). That scan is paged " +
        "and capped, and a scan that hits the cap ABORTS TOO — an UNPROVEN scan is treated exactly " +
        "like a proven collision, because writing on a partly-read column is how this verb would " +
        "manufacture that trap on a table too big to have been checked. status is 'created' " +
        "only when a matching v_db_index row was read back; a flag with no index is 'failed', and " +
        "verified.indexPresent is null (UNKNOWN) when the view could not be read — never false, " +
        "because a blind instrument is not evidence of absence. 'uniqueness-enforced' is ALWAYS " +
        "reported in unverified: v_db_index carries no uniqueness field, so enforcement is provable " +
        "only by a duplicate-insert test. updateSetSysId is required on the live path; dryRun:true " +
        "returns the plan with no reads and no writes.",
      shape: addIndexSchema.shape,
      handler: async function (args: unknown) {
        var p = addIndexSchema.parse(args);
        // The schema leaves updateSetSysId optional (dry-run doesn't need one), so
        // enforce the live-path requirement HERE — a tool-level error before any
        // work beats a failure surfacing from deep inside addIndex. Same pattern as
        // add_column.
        if (
          p.dryRun !== true &&
          (!p.updateSetSysId || !p.updateSetSysId.trim())
        ) {
          throw new Error(
            "add_index: updateSetSysId is required on the live path so the " +
              "sys_dictionary change is captured in a known update set — " +
              "set dryRun:true to plan without one.",
          );
        }
        // `unique` is boolean at the boundary (unvalidated JSON arrives here), but only
        // true is buildable — refuse it by name rather than let a caller believe a plain
        // index was created.
        var unique = p.unique;
        if (unique !== true) {
          throw new Error(
            "add_index: only a unique index can be created headlessly — the sole " +
              "lever is sys_dictionary.unique, which has no equivalent for a plain " +
              "(non-unique) index. Pass unique:true, or create that index in the " +
              "platform UI.",
          );
        }
        return addIndex({
          client: client(),
          table: p.table,
          columns: p.columns,
          unique: unique,
          scope: p.scope,
          updateSetSysId: p.updateSetSysId,
          dryRun: p.dryRun,
          debug: p.debug,
        });
      },
    },
    {
      name: "index_list",
      annotations: READ_ONLY,
      description:
        "List the DATABASE INDEXES on a ServiceNow table. Read-only — no form session, no " +
        "writes. Reads the v_db_index VIEW, which is the only index read surface an instance " +
        "exposes: sys_index fails an API-LEVEL ACL (HTTP 403) for every identity including " +
        "admin (an ACL that refuses GET refuses POST), and sys_index_column does not exist at " +
        "all (HTTP 400 'Invalid table') — there is no two-table index model to join. Each row " +
        "returns { name, columns, type, rawColumns }: `columns` is v_db_index's bracketed " +
        "`column_names` cell ('[phone]', '[a;b]' — semicolon-separated when composite) PARSED into a list, never substring-matched, " +
        "and `type` is access_method (btree for essentially everything). UNIQUENESS IS NOT " +
        "READABLE: v_db_index carries no uniqueness field, so a unique index and an ordinary " +
        "one are indistinguishable in it — `unique` is therefore left ABSENT rather than " +
        "guessed, and 'uniqueness-enforced' is always reported in unverified. Only a " +
        "duplicate-insert test proves enforcement. A table stored in an ancestor's physical " +
        "table (table-per-hierarchy, e.g. anything extending task) has no rows of its own: its " +
        "super_class chain is walked and the storage root's indexes are listed, with " +
        "`storageTable` and the note naming the root. An empty result for a table that does " +
        "not exist says the name is wrong (every physical table has a PRIMARY).",
      shape: listIndexesSchema.shape,
      handler: async function (args: unknown) {
        var p = listIndexesSchema.parse(args);
        return listIndexes({ client: client(), table: p.table });
      },
    },
    {
      name: "index_create",
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
      description:
        "Create a DATABASE INDEX on an EXISTING ServiceNow table — including the COMPOSITE and " +
        "NON-UNIQUE indexes add_index cannot build. AN INDEX IS CAPTURED IN AN UPDATE SET: the " +
        "platform's build job writes a sys_update_xml row (type=Indexes, name " +
        "sys_index_<table>_<col>_…) into the session user's CURRENT update set, so " +
        "updateSetSysId is REQUIRED on the live path — the tool pins that set as current " +
        "(Dovetail changeUpdateSet, read back) BEFORE scheduling, refuses a set outside the " +
        "table's application scope or not 'in progress', and reads the capture row back " +
        "from that set afterwards. The physical index is still built per instance; committing " +
        "the set elsewhere rebuilds it. There is no record path to an index (sys_index is " +
        "API-level-ACL 403, sys_index_column does not exist, and sys_dictionary.unique — the " +
        "add_index lever — is per-column and unique-only), so this replays the two GlideAjax " +
        "calls the platform's own Database Indexes dialog makes on xmlhttp.do over a " +
        "form-login session: IndexCreatorErrorChecker.canCreate (the dialog's pre-flight; a " +
        "canCreate:false verdict is returned verbatim with its errorCode and nothing is " +
        "scheduled) then ScheduleCreator.createSchedule (sysparm_table, sysparm_fields, " +
        "sysparm_access_method — default btree — sysparm_unique true|false, no email, no " +
        "name). DRY-RUN BY DEFAULT: without confirm:true NOTHING is sent and nothing is read; " +
        "dryRun:true forces a dry-run even with confirm. IDEMPOTENT: on the live path " +
        "v_db_index is read first, and an index over exactly these columns returns " +
        "'already-exists' with no write. `columns` is ORDERED — order is part of an " +
        "index's identity and is preserved verbatim. `name` is REFUSED: the dialog has no " +
        "name input (ServiceNow names the index after its leading column), so accepting one " +
        "would mean reporting a name the instance does not carry — the real name comes back " +
        "in `name`. After scheduling, the index is polled for in v_db_index (default 10 " +
        "checks, 3s apart); if it never appears the result is 'failed', because an accepted " +
        "schedule is not evidence an ALTER ran — and a unique index cannot build over " +
        "duplicate values, EMPTY included. verified:true means a matching row was READ BACK; " +
        "captured:true means the sys_update_xml row was READ BACK from the pinned set (an " +
        "index that exists but was not captured is created:true, captured:false with " +
        "'update-set-capture' in unverified, and captureFoundIn names the set(s) the row " +
        "actually landed in). When the REST identity is not the form-login user the run " +
        "still proceeds and the note carries an IDENTITY WARNING, because the build " +
        "captures into the form user's current set. 'uniqueness-enforced' is ALWAYS in " +
        "unverified: v_db_index has no uniqueness field. Requires a username+password identity " +
        "that can form-log-in; xmlhttp.do ignores Basic auth and API keys, so an API-key-only " +
        "or SSO/MFA identity fails at the session with a diagnosis (TenonHQ/Dovetail#292).",
      shape: createIndexSchema.shape,
      handler: async function (args: unknown) {
        var p = createIndexSchema.parse(args);
        return createIndex({
          client: client(),
          table: p.table,
          columns: p.columns,
          updateSetSysId: p.updateSetSysId,
          unique: p.unique,
          name: p.name,
          accessMethod: p.accessMethod,
          confirm: p.confirm,
          dryRun: p.dryRun,
          pollAttempts: p.pollAttempts,
          pollIntervalMs: p.pollIntervalMs,
          debug: p.debug,
        });
      },
    },
    {
      name: "set_column",
      annotations: WRITE_OVERWRITE,
      description:
        "Update the SCHEMA of an EXISTING column on an EXISTING ServiceNow table — its label, " +
        "mandatory, default, readOnly, maxLength, or dependentOnField (the sibling column a " +
        "document_id resolves against; must exist on the table; \"\" clears it) — on an INHERITED " +
        "column, overridden for that table alone via sys_dictionary_override — captured into a " +
        "named update set, then READ " +
        "BACK from the instance to verify. This is the schema counterpart to set_field: set_field " +
        "changes a RECORD's value, set_column changes the COLUMN's definition (sys_dictionary). Use " +
        "add_column to CREATE a column. maxLength is PHYSICAL — changing it fires a real ALTER on the " +
        "table, and that works (verified live). internal_type and element (rename) are REFUSED, not " +
        "written: ServiceNow returns HTTP 200 and silently ignores both on an existing column, so a " +
        "write would report success while changing nothing — delete and recreate the column instead. " +
        "Attributes are a closed set, never an open field map. When every requested value already " +
        "matches, nothing is written and the status is 'unchanged' (an ALTER fires on a CHANGE, not a " +
        "write). A maxLength SHRINK is REFUSED while rows hold longer values: ServiceNow silently " +
        "refuses such a shrink (200 OK, column unchanged, data preserved), so the tool names the " +
        "blocking rows instead of issuing a write that would be quietly ignored. Clear those values " +
        "first, then re-run — there is no override, because forcing it would either do nothing or " +
        "destroy data. INHERITED COLUMNS ARE SUPPORTED: on an extended table the column is defined on " +
        "an ancestor, and set_column narrows it for THAT TABLE ALONE via sys_dictionary_override " +
        "(mandatory/default/readOnly) or sys_documentation (label) — the ancestor and every sibling " +
        "table are left untouched, and the result reports via:'override' with definedOn set. Do NOT " +
        "call set_column against the parent table to change a child's column: that changes it for " +
        "EVERY descendant. maxLength is the sole exception — it is the ancestor's physical column, has " +
        "no per-child override, and is refused with an explanation. dryRun:true diffs against the " +
        "instance, flags the blocking rows, and writes nothing.",
      shape: setColumnSchema.shape,
      handler: async function (args: any) {
        var p = setColumnSchema.parse(args);
        // The schema leaves updateSetSysId optional (dry-run doesn't need one), so
        // enforce the live-path requirement HERE — a tool-level error before any
        // work beats a failure surfacing from deep inside setColumn. Same pattern
        // as add_column.
        if (
          p.dryRun !== true &&
          (!p.updateSetSysId || !p.updateSetSysId.trim())
        ) {
          throw new Error(
            "set_column: updateSetSysId is required on the live path so the schema " +
              "change is captured in a known update set — set dryRun:true to plan " +
              "without one.",
          );
        }
        return setColumn({
          client: client(),
          table: p.table,
          column: p.column,
          attributes: p.attributes,
          updateSetSysId: p.updateSetSysId,
          dryRun: p.dryRun,
        });
      },
    },
    {
      name: "set_table",
      annotations: WRITE_OVERWRITE,
      description:
        "Update an EXISTING ServiceNow TABLE's own dictionary attributes — the row where " +
        "internal_type=collection and element is EMPTY — captured into a named update set, then " +
        "READ BACK from the instance to verify. Completes the trio: set_field changes a RECORD's " +
        "value, set_column changes a COLUMN's definition, set_table changes the TABLE's own. " +
        "Currently settable: audit. audit=true turns RECORD AUDITING on for the whole table — " +
        "ServiceNow then writes a sys_audit row per changed field on every insert and update, " +
        "which is a real storage and write cost on a high-volume table, so weigh it before " +
        "enabling. Attributes are a closed set, never an open field map; a COLUMN attribute " +
        "(label/mandatory/default/maxLength/readOnly/element/internalType) is refused by name and " +
        "redirected to set_column. When the requested value already matches, nothing is written " +
        "and the status is 'unchanged' — note that an identical-value write also captures " +
        "NOTHING, so there is no update-set row to promote. dryRun:true diffs against the " +
        "instance and writes nothing.",
      shape: setTableSchema.shape,
      handler: async function (args: any) {
        var p = setTableSchema.parse(args);
        // Same live-path guard as set_column: the schema leaves updateSetSysId
        // optional so dry-run works without one.
        if (
          p.dryRun !== true &&
          (!p.updateSetSysId || !p.updateSetSysId.trim())
        ) {
          throw new Error(
            "set_table: updateSetSysId is required on the live path so the schema " +
              "change is captured in a known update set — set dryRun:true to plan " +
              "without one.",
          );
        }
        return setTable({
          client: client(),
          table: p.table,
          attributes: p.attributes,
          updateSetSysId: p.updateSetSysId,
          dryRun: p.dryRun,
        });
      },
    },
    {
      name: "set_field",
      annotations: WRITE_OVERWRITE,
      description:
        "Set scalar field value(s) on an EXISTING ServiceNow data record, captured into a specified " +
        "update set, then READ BACK to verify each value landed. Wraps the update-set-aware " +
        "pushWithUpdateSet core op (no sys_user_preference mutation). Target the record by sysId, or " +
        "by a query that resolves to EXACTLY one row. REFUSES schema tables (sys_db_object / " +
        "sys_dictionary) — use add_column / create_table for those. fields is a flat name->string map " +
        "(sent as strings; ServiceNow coerces); updateSetSysId is required so the change is tracked; " +
        "dryRun:true reads the current values and returns the plan without writing. To INSERT a new " +
        "record use create_record.",
      shape: setFieldSchema.shape,
      handler: async function (args: any) {
        var p = setFieldSchema.parse(args);
        return setField({
          client: client(),
          table: p.table,
          sysId: p.sysId,
          query: p.query,
          fields: p.fields,
          updateSetSysId: p.updateSetSysId,
          dryRun: p.dryRun,
        });
      },
    },
    {
      name: "create_record",
      annotations: WRITE_CREATE,
      description:
        "Create ONE new ServiceNow data record, owned by an explicit app scope and captured into a " +
        "specified update set, then READ BACK to verify. Wraps the scope- and update-set-aware " +
        "createRecord core op (switches app scope + update set server-side, inserts, restores both — " +
        "so the record lands in the right scope without sys_user_preference mutation). REFUSES schema " +
        "tables (sys_db_object / sys_dictionary) — use create_table / add_column for those — and " +
        "sys_update_set (the op cannot set its application; use `dove createUpdateSet`). fields is a " +
        "flat name->string map; scope and updateSetSysId are required; ifAbsentQuery makes re-runs " +
        "idempotent (skips the insert when it already matches a row); dryRun:true returns the plan " +
        "without writing. To UPDATE an existing record use set_field.",
      shape: createRecordSchema.shape,
      handler: async function (args: any) {
        var p = createRecordSchema.parse(args);
        return createRecord({
          client: client(),
          table: p.table,
          fields: p.fields,
          scope: p.scope,
          updateSetSysId: p.updateSetSysId,
          ifAbsentQuery: p.ifAbsentQuery,
          dryRun: p.dryRun,
        });
      },
    },
    {
      name: "sync_ux_events",
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
      description:
        "Register a UI component's dispatched events: read a local now-ui.json, and for each component " +
        "with actions resolve its macroponent (sys_ux_macroponent whose root_component is the " +
        "sys_ux_lib_component with that tag), then diff every action against sys_ux_event and the " +
        "macroponent's dispatched_events. Each action is ok / create (no event record) / link (record " +
        "exists but is not listed) / drift (label or description differs — report only) / ambiguous " +
        "(several records — never written); linked-but-undeclared events are reported as orphans. " +
        "DRY-RUN BY DEFAULT — with confirm:true it creates the missing events in the macroponent's scope " +
        "via the scope-aware createRecord op and APPENDS their sys_ids to dispatched_events via " +
        "pushWithUpdateSet (never drops or reorders an entry), both captured into updateSetSysId " +
        "(required to confirm), then re-reads the macroponent to verify. Idempotent: a re-run is a no-op. " +
        "ok:false means an unresolved/ambiguous component or event, or an unverified write.",
      shape: syncUxEventsSchema.shape,
      handler: async function (args: unknown) {
        var p = syncUxEventsSchema.parse(args);
        var nowUi: unknown = JSON.parse(fs.readFileSync(path.resolve(p.file), "utf8"));
        return syncUxEvents({
          client: client(),
          nowUi: nowUi,
          component: p.component,
          updateSetSysId: p.updateSetSysId,
          apply: p.confirm === true && p.dryRun !== true,
        });
      },
    },
    {
      name: "delete_record",
      annotations: WRITE_OVERWRITE,
      description:
        "Delete ONE existing ServiceNow data record by table + sys_id, with the record READ BACK " +
        "BEFORE the delete (so the dry-run shows exactly what would go, and a missing record is an " +
        "error — never a 'successful' delete of nothing) and READ BACK AFTER (success is only " +
        "reported once the record is confirmed gone). DRY-RUN BY DEFAULT — without confirm:true " +
        "nothing is deleted and the before-snapshot is returned; dryRun:true forces a dry-run even " +
        "with confirm. updateSetSysId is REQUIRED and must be an existing in-progress update set " +
        "(checked on the dry-run too). Until TenonHQ/Dovetail#297 ships the server-side op ignores it " +
        "and captures into the session's CURRENT update set, so the tool pins the set as current " +
        "first (refusing to delete if the pin does not read back) and afterwards reads the DELETE " +
        "row back from sys_update_xml: captured:true only when it is in the requested set, " +
        "capturedInto names the set it actually landed in. A deleted record with captured:false " +
        "will NOT travel with that set. sysId must be a 32-char lowercase hex id; table a plain " +
        "table name. REFUSES schema tables (sys_db_object / sys_dictionary) — dropping a table or " +
        "column is a lifecycle op, not a record delete. Destructive and irreversible on apply: query " +
        "first and dry-run before confirming. To change a record use set_field; to add one use " +
        "create_record.",
      shape: deleteRecordSchema.shape,
      handler: async function (args: unknown) {
        var p = deleteRecordSchema.parse(args);
        return deleteRecord({
          client: client(),
          table: p.table,
          sysId: p.sysId,
          updateSetSysId: p.updateSetSysId,
          confirm: p.confirm,
          dryRun: p.dryRun,
        });
      },
    },
    {
      name: "host_assets",
      annotations: WRITE_OVERWRITE,
      description:
        "Deploy a pre-built front-end dist/ bundle to ServiceNow. For each chunk (index.html + " +
        "assets/*.{js,css}) upserts a carrier sys_ui_script named app_shell_asset:<vite-relative-path> " +
        "(the rotating hash is part of the name on purpose — the Scripted REST serving resource resolves " +
        "an asset by this exact name), stores the chunk bytes as a sys_attachment (the script field caps " +
        "at 65 KB), and wires an x_cadso_app_shell_m2m_app_script row (application, script, chunk_role, " +
        "order). PRUNES carriers + m2m rows for chunks no longer in the build (hashes rotate per build). " +
        "Idempotent — identical bytes (by SHA-256) are left in place. Fails fast on any chunk at/over the " +
        "~5 MB serve cap (glide.scriptable.excel.max_file_size) unless allowOversize. app is the application " +
        "record sys_id; dir is a local dist path on the server running this tool; script + m2m writes are " +
        "captured in the update set; dryRun previews without writing.",
      shape: hostAssetsSchema.shape,
      handler: async function (args: any) {
        return hostAssets(client(), hostAssetsSchema.parse(args));
      },
    },
    {
      name: "invoke_rest",
      annotations: WRITE_EXECUTE,
      description:
        "Invoke an arbitrary authenticated ServiceNow REST operation — including an application's " +
        "own Scripted REST endpoints (/api/<scope>/<service>/<resource>) — with GET, POST, PUT or " +
        "DELETE. A transport primitive: it can drive update and DELETE operations, so it is " +
        "destructive-capable and non-idempotent. DRY-RUN BY DEFAULT — without confirm:true nothing " +
        "is sent and the resolved method + path + body are echoed back; dryRun:true forces a " +
        "dry-run even with confirm. On send, returns { httpStatus, ok, body } with the response " +
        "passed through verbatim — non-2xx responses are returned, not thrown, so the operation's " +
        "own error contract is preserved (429/5xx are retried by the transport first). path must " +
        "be instance-relative and start with /api/. Request/response bodies are never logged — " +
        "they exist only in this result. For sys_* / x_* record CRUD use set_field / " +
        "create_record instead; this tool is for operations those fixed verbs cannot express.",
      shape: invokeRestSchema.shape,
      handler: async function (args: any) {
        var p = invokeRestSchema.parse(args);
        var params: InvokeRestParams = {
          method: p.method,
          path: p.path,
          body: p.body,
          confirm: p.confirm,
          dryRun: p.dryRun,
        };
        // Client resolution is lazy: a dry-run needs no credentials, so only
        // attach one when injected (tests) — invokeRest creates its own on send.
        if (deps.client) {
          params.client = deps.client;
        }
        return invokeRest(params);
      },
    },
    {
      name: "app_publish",
      annotations: WRITE_EXECUTE,
      description:
        "Publish a scoped ServiceNow application to ONE target per call, then poll the publish to " +
        "completion; call repeatedly to hit several targets. STORE PUBLISH IS EXTERNALLY VISIBLE " +
        "on the ServiceNow Store — treat it as a release. DRY-RUN BY DEFAULT: without confirm:true " +
        "the resolved plan (app, current version, target) is returned and nothing is published. " +
        "Targets: 'store' replays the sys_app form's upload flow over a form-login session and " +
        "requires SN_STORE_USERNAME/SN_STORE_PASSWORD in the server's env file — credentials never " +
        "transit tool arguments. 'repo' publishes to the company Application Repository via the " +
        "supported CI/CD REST API (/api/sn_cicd/app_repo/publish) and requires the sn_cicd plugin " +
        "and role. 'repo-ui' reaches the SAME company repository over the UI uploader instead — use " +
        "it on instances without sn_cicd, where 'repo' 404s. 'update-set' publishes the app INTO a " +
        "newly created update set via the two-call AppsAjaxProcessor flow (no REST equivalent " +
        "exists); updateSetName defaults to the app's name and updateSetDescription is conventionally " +
        "the release date stamp (YYYYMMDD) so a whole release is one sys_update_set query. " +
        "includeData (default false) is the dialog's 'Include demo data' box. app is a scope name, " +
        "sys_app sys_id, or app name; version must be above the currently published version. The " +
        "result carries the progress-tracker id, per-step states, the Store appLink, and the " +
        "update-set sys_id (for 'update-set' this is set as soon as the set is created, so it " +
        "survives a later failure).",
      shape: publishAppSchema.shape,
      handler: async function (args: any) {
        var p = publishAppSchema.parse(args);
        var params: PublishAppParams = {
          app: p.app,
          version: p.version,
          target: p.target,
          devNotes: p.devNotes,
          updateSetName: p.updateSetName,
          updateSetDescription: p.updateSetDescription,
          includeData: p.includeData,
          confirm: p.confirm,
          dryRun: p.dryRun,
          timeoutMs: p.timeoutMs,
        };
        if (deps.client) {
          params.client = deps.client;
        }
        return publishApp(params);
      },
    },
    {
      name: "update_set_export",
      annotations: READ_ONLY,
      description:
        "Export one update set to an importable <unload> XML document, with every secret value " +
        "replaced by the __SET_DURING_INSTALL__ sentinel. Two modes. mode 'assemble' (the default) " +
        "is READ-ONLY: it pages the set's sys_update_xml rows and builds the document, touching no " +
        "instance state, which is what packaging work wants against a shared instance. mode " +
        "'complete' marks the set complete on the instance (a REAL WRITE, so it needs confirm:true) " +
        "and reads the export servlet instead — the servlet answers an in-progress set with an " +
        "empty 200, which this handles rather than writing an empty file. The export REFUSES to " +
        "produce a document when the row count does not match the set, or when a field looks " +
        "secret and no rule covers it: adjudicate it in the rules file as a strip rule or as " +
        "notSecret with a reason. Secret stripping cannot be disabled. The result carries the XML, " +
        "the record count, and the table.field list of every value replaced, so the install runbook " +
        "can list what to set afterwards.",
      shape: exportUpdateSetSchema.shape,
      handler: async function (args: any) {
        var p = exportUpdateSetSchema.parse(args);
        var params: ExportUpdateSetParams = {
          updateSet: p.updateSet,
          mode: p.mode,
          rulesPath: p.rulesPath,
          pageSize: p.pageSize,
          maxRows: p.maxRows,
          confirm: p.confirm,
          dryRun: p.dryRun,
        };
        if (deps.client) {
          params.client = deps.client;
        }
        return exportUpdateSet(params);
      },
    },
    {
      name: "app_export",
      annotations: WRITE_EXECUTE,
      description:
        "Publish a scoped application into a NEW update set and export that set to importable " +
        "<unload> XML — the headless equivalent of the UI's Publish to Update Set then Export to " +
        "XML. PUBLISHING IS A REAL SHARED-INSTANCE WRITE: it creates an update set and can add " +
        "1000+ sys_update_xml rows, so DRY-RUN BY DEFAULT — without confirm:true the resolved plan " +
        "is returned and nothing is published. This is NOT the Store publish (that is app_publish, " +
        "which is externally visible); this one stays inside the instance. Secret values are always " +
        "replaced with the __SET_DURING_INSTALL__ sentinel before the document is returned, with no " +
        "opt-out. includeData ships table data as well as schema and is off by default. The result " +
        "carries the update set sys_id, the record count, the XML, and every stripped table.field.",
      shape: exportAppSchema.shape,
      handler: async function (args: any) {
        var p = exportAppSchema.parse(args);
        var params: ExportAppParams = {
          app: p.app,
          version: p.version,
          description: p.description,
          includeData: p.includeData,
          keepSet: p.keepSet,
          rulesPath: p.rulesPath,
          timeoutMs: p.timeoutMs,
          confirm: p.confirm,
          dryRun: p.dryRun,
        };
        if (deps.client) {
          params.client = deps.client;
        }
        return exportApp(params);
      },
    },
  ];
}

export function registerAllTools(
  server: McpServer,
  deps: RegistryDeps = {},
): void {
  // registerKitTools owns serialization + the { error, retryable, tool } contract.
  // No telemetry recorder is injected here (telemetry parity is a P2 follow-on).
  registerKitTools(server, buildDescriptors(deps));
}
