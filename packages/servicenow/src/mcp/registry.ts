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
  registerKitTools
} from "@tenonhq/dovetail-mcp-kit";
import type { ToolAnnotations } from "@tenonhq/dovetail-mcp-kit";

import { createClient } from "../client";
import type { ServiceNowClient } from "../client";
import { createView } from "../layout/views";
import { setListLayout } from "../layout/listLayout";
import { setFormLayout } from "../layout/formLayout";
import { setRelatedLists } from "../layout/relatedLists";
import { addChoicesToField } from "../choices";
import { readFlow } from "../flowDesigner/readFlow";
import { readActionType } from "../flowDesigner/readActionType";
import { publishFlow } from "../flowDesigner/publishFlow";
import { copyFlow } from "../flowDesigner/copyFlow";
import { createFlow } from "../flowDesigner/createFlow";
import { editFlow } from "../flowDesigner/editFlow";
import { testFlow } from "../flowDesigner/testFlow";
import { createTable, addColumn } from "../table";
import { hostAssets } from "../hostAssets";
import { setField } from "../setField";
import { createRecord } from "../createRecord";
import {
  createViewSchema,
  setListLayoutSchema,
  setFormLayoutSchema,
  setRelatedListsSchema,
  addChoicesToFieldSchema,
  viewFlowSchema,
  viewActionSchema,
  publishFlowSchema,
  copyFlowSchema,
  createFlowSchema,
  testFlowSchema,
  editFlowSchema,
  createTableSchema,
  addColumnSchema,
  setFieldSchema,
  createRecordSchema,
  hostAssetsSchema
} from "./schemas";

export var TOOL_NAMES = [
  "create_view",
  "set_list_layout",
  "set_form_layout",
  "set_related_lists",
  "add_choices_to_field",
  "flow_view",
  "action_view",
  "flow_publish",
  "flow_copy",
  "flow_create",
  "flow_test",
  "flow_edit",
  "create_table",
  "add_column",
  "set_field",
  "create_record",
  "host_assets"
] as const;

export type ToolName = typeof TOOL_NAMES[number];

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

export function buildDescriptors(deps: RegistryDeps = {}): Array<ToolDescriptor> {
  function client(): ServiceNowClient {
    return deps.client || createClient({});
  }
  return [
    {
      name: "create_view",
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
      description:
        "Create a ServiceNow custom view (sys_ui_view). Idempotent — an existing view of the "
        + "same name is returned unchanged. Every write is captured in the supplied update set.",
      shape: createViewSchema.shape,
      handler: async function (args: any) {
        return createView(client(), createViewSchema.parse(args));
      }
    },
    {
      name: "set_list_layout",
      annotations: WRITE_OVERWRITE,
      description:
        "Declaratively set a ServiceNow list layout — which columns appear in a list, and their "
        + "order — for a table + view. Idempotent; prune (default true) removes columns not in "
        + "the spec; dryRun previews without writing. Writes are captured in the update set.",
      shape: setListLayoutSchema.shape,
      handler: async function (args: any) {
        return setListLayout(client(), setListLayoutSchema.parse(args));
      }
    },
    {
      name: "set_form_layout",
      annotations: WRITE_OVERWRITE,
      description:
        "Declaratively set a ServiceNow form layout — sections and the fields within them — for "
        + "a table + view. The first section is the primary section (omit its caption). "
        + "Idempotent; prune (default true) removes sections/fields not in the spec; dryRun "
        + "previews without writing. Writes are captured in the update set.",
      shape: setFormLayoutSchema.shape,
      handler: async function (args: any) {
        return setFormLayout(client(), setFormLayoutSchema.parse(args));
      }
    },
    {
      name: "set_related_lists",
      annotations: WRITE_OVERWRITE,
      description:
        "Declaratively set which related lists appear on a ServiceNow form for a table + view. "
        + "Related-list ids are \"<table>.<field>\" or \"REL:<sys_relationship>\". Idempotent; "
        + "prune (default true); dryRun previews. Writes are captured in the update set.",
      shape: setRelatedListsSchema.shape,
      handler: async function (args: any) {
        return setRelatedLists(client(), setRelatedListsSchema.parse(args));
      }
    },
    {
      name: "add_choices_to_field",
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
      description:
        "Upsert sys_choice values for a ServiceNow table.column and (optionally) flip "
        + "sys_dictionary.choice so the field renders as a dropdown. Idempotent. Writes are "
        + "captured in the supplied update set.",
      shape: addChoicesToFieldSchema.shape,
      handler: async function (args: any) {
        return addChoicesToField(client(), addChoicesToFieldSchema.parse(args));
      }
    },
    {
      name: "flow_view",
      annotations: READ_ONLY,
      description:
        "Read a ServiceNow Flow Designer flow or subflow's compiled step graph, headless. "
        + "Returns the ordered, nesting-aware list of action + flow-logic steps plus the flow "
        + "variables, via GET /api/now/processflow/flow/{sysId}. Read-only. Pass raw:true to "
        + "include the full processflow model. sysId is the sys_hub_flow sys_id.",
      shape: viewFlowSchema.shape,
      handler: async function (args: any) {
        var p = viewFlowSchema.parse(args);
        return readFlow({ client: client(), sysId: p.sysId, raw: p.raw });
      }
    },
    {
      name: "action_view",
      annotations: READ_ONLY,
      description:
        "Read a ServiceNow Custom Action Type's compiled model (identity, inputs, outputs), "
        + "headless, via GET /api/now/processflow/action/action_types/{sysId}. Read-only. "
        + "sysId is the sys_hub_action_type_definition sys_id; scopeSysId is the application "
        + "scope (sysparm_transaction_scope). Pass raw:true for the full model.",
      shape: viewActionSchema.shape,
      handler: async function (args: any) {
        var p = viewActionSchema.parse(args);
        return readActionType({ client: client(), sysId: p.sysId, scopeSysId: p.scopeSysId, raw: p.raw });
      }
    },
    {
      name: "flow_publish",
      annotations: WRITE_OVERWRITE,
      description:
        "Publish (compile the snapshot of) a ServiceNow Flow Designer flow or subflow via "
        + "POST /api/now/processflow/flow/{sysId}/snapshot. This is a WRITE that recompiles the "
        + "flow's current design — use after editing in the Designer. sysId is the sys_hub_flow "
        + "sys_id; scopeSysId defaults to the flow's own scope.",
      shape: publishFlowSchema.shape,
      handler: async function (args: any) {
        var p = publishFlowSchema.parse(args);
        return publishFlow({ client: client(), sysId: p.sysId, scopeSysId: p.scopeSysId });
      }
    },
    {
      name: "flow_copy",
      annotations: WRITE_CREATE,
      description:
        "Copy a ServiceNow flow/subflow via the Designer's Copy endpoint — a complete, faithful "
        + "clone created as an INACTIVE DRAFT in the target scope. sourceSysId is the sys_hub_flow "
        + "to copy; newName is the copy's name; scopeSysId defaults to the source's scope. Publish "
        + "with flow_publish when ready. Do NOT publish + activate a copy of a triggered production "
        + "flow unless you intend it to fire.",
      shape: copyFlowSchema.shape,
      handler: async function (args: any) {
        var p = copyFlowSchema.parse(args);
        return copyFlow({ client: client(), sourceSysId: p.sourceSysId, newName: p.newName, scopeSysId: p.scopeSysId });
      }
    },
    {
      name: "flow_create",
      annotations: WRITE_CREATE,
      description:
        "Create a NEW ServiceNow Flow Designer flow (sys_hub_flow, type=flow) from scratch and "
        + "PUBLISH it, headless. Mints a fresh flow via POST /processflow/flow, grafts the trigger + "
        + "action graph from an existing published template flow (templateSysId), then compiles the "
        + "snapshot — leaving a published flow (the result's `active` flag reports whether it will "
        + "fire). Unlike flow_copy (which duplicates a flow), "
        + "this creates a new flow you can re-point at a different trigger table / message. "
        + "name + templateSysId + scopeSysId are required; triggerTable / triggerCondition / "
        + "logMessage patch the grafted graph; dryRun:true returns the plan + template graph counts "
        + "without writing. WARNING: a published triggered flow can fire on its trigger — do not graft "
        + "a production send template you don't intend to fire.",
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
          dryRun: p.dryRun
        });
      }
    },
    {
      name: "flow_test",
      annotations: WRITE_EXECUTE,
      description:
        "Test or run a ServiceNow flow/subflow. mode='validate' (default) is a safe, read-only "
        + "pre-flight — checks the flow is published and that supplied inputs match its declared "
        + "variables; it never runs the flow. mode='execute' actually runs it via the server-side "
        + "FlowAPI runner and REQUIRES confirm=true (running a flow can cause real side effects, "
        + "e.g. sending an SMS). sysId is the sys_hub_flow sys_id.",
      shape: testFlowSchema.shape,
      handler: async function (args: any) {
        var p = testFlowSchema.parse(args);
        return testFlow({
          client: client(),
          sysId: p.sysId,
          mode: p.mode,
          inputs: p.inputs,
          confirm: p.confirm,
          runnerPath: p.runnerPath
        });
      }
    },
    {
      name: "flow_edit",
      annotations: WRITE_OVERWRITE,
      description:
        "Edit a ServiceNow flow/subflow in place. Supports rename (name/internalName), description, "
        + "and patchStepInputs (set named input values on steps by uiId or label). apply=false "
        + "(default) is a dry-run that returns the diff; apply=true persists the edit (a write). "
        + "Rename/description require updateSetSysId (they write sys_hub_flow via the update-set-aware "
        + "API); patchStepInputs ride a snapshot recompile. sysId is the sys_hub_flow sys_id.",
      shape: editFlowSchema.shape,
      handler: async function (args: any) {
        var p = editFlowSchema.parse(args);
        return editFlow({
          client: client(),
          sysId: p.sysId,
          ops: p.ops,
          apply: p.apply,
          scopeSysId: p.scopeSysId,
          updateSetSysId: p.updateSetSysId
        });
      }
    },
    {
      name: "create_table",
      annotations: WRITE_CREATE,
      description:
        "Create a NEW ServiceNow table (sys_db_object) WITH its columns, headless and faithfully. "
        + "A table create is a privileged platform op — a REST/createRecord insert ORPHANS the table "
        + "(metadata row, no physical table, no ACLs). This replays the Studio form save "
        + "(POST /sys_db_object.do) so the real 36-record graph + the physical table + seeded ACLs "
        + "are created. name (x_scope_*), label, scope, and columns[] are required; extendsTable "
        + "defaults to sys_metadata; friendly column types are mapped to internal types "
        + "(string -> string_full_utf8). dryRun:true returns the plan + the column XML + the projected "
        + "graph with no session and no writes. NOTE: the live write path is pending a validated-live "
        + "spike — prefer dryRun until confirmed, and always verify the sys_update_xml landed in the "
        + "intended update set.",
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
          dryRun: p.dryRun
        });
      }
    },
    {
      name: "add_column",
      annotations: WRITE_CREATE,
      description:
        "Add ONE column to an EXISTING ServiceNow table, headless. Creating a column is a sys_dictionary "
        + "insert; this uses the scope-aware createRecord op (switches app scope + update set server-side, "
        + "inserts, restores) so the column lands in the right scope and update set, then READS THE COLUMN "
        + "BACK from sys_dictionary to prove it materialised (a returned sys_id with no column is reported "
        + "failed, not created). table is the table name or its sys_db_object sys_id; column is "
        + "{ label, type, name?, max_length?, reference?, mandatory?, default? } with friendly types mapped to "
        + "internal types (string -> string_full_utf8) and reference = the target table NAME; element is "
        + "derived from label unless column.name is given. updateSetSysId is required on the live path. "
        + "dryRun:true returns the plan with no writes.",
      shape: addColumnSchema.shape,
      handler: async function (args: any) {
        var p = addColumnSchema.parse(args);
        return addColumn({
          client: client(),
          table: p.table,
          column: p.column,
          scope: p.scope,
          updateSetSysId: p.updateSetSysId,
          dryRun: p.dryRun,
          debug: p.debug
        });
      }
    },
    {
      name: "set_field",
      annotations: WRITE_OVERWRITE,
      description:
        "Set scalar field value(s) on an EXISTING ServiceNow data record, captured into a specified "
        + "update set, then READ BACK to verify each value landed. Wraps the update-set-aware "
        + "pushWithUpdateSet core op (no sys_user_preference mutation). Target the record by sysId, or "
        + "by a query that resolves to EXACTLY one row. REFUSES schema tables (sys_db_object / "
        + "sys_dictionary) — use add_column / create_table for those. fields is a flat name->string map "
        + "(sent as strings; ServiceNow coerces); updateSetSysId is required so the change is tracked; "
        + "dryRun:true reads the current values and returns the plan without writing. To INSERT a new "
        + "record use create_record.",
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
          dryRun: p.dryRun
        });
      }
    },
    {
      name: "create_record",
      annotations: WRITE_CREATE,
      description:
        "Create ONE new ServiceNow data record, owned by an explicit app scope and captured into a "
        + "specified update set, then READ BACK to verify. Wraps the scope- and update-set-aware "
        + "createRecord core op (switches app scope + update set server-side, inserts, restores both — "
        + "so the record lands in the right scope without sys_user_preference mutation). REFUSES schema "
        + "tables (sys_db_object / sys_dictionary) — use create_table / add_column for those. fields is a "
        + "flat name->string map; scope and updateSetSysId are required; ifAbsentQuery makes re-runs "
        + "idempotent (skips the insert when it already matches a row); dryRun:true returns the plan "
        + "without writing. To UPDATE an existing record use set_field.",
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
          dryRun: p.dryRun
        });
      }
    },
    {
      name: "host_assets",
      annotations: WRITE_OVERWRITE,
      description:
        "Deploy a pre-built front-end dist/ bundle to ServiceNow. For each chunk (index.html + "
        + "assets/*.{js,css}) upserts a carrier sys_ui_script named app_shell_asset:<vite-relative-path> "
        + "(the rotating hash is part of the name on purpose — the Scripted REST serving resource resolves "
        + "an asset by this exact name), stores the chunk bytes as a sys_attachment (the script field caps "
        + "at 65 KB), and wires an x_cadso_app_shell_m2m_app_script row (application, script, chunk_role, "
        + "order). PRUNES carriers + m2m rows for chunks no longer in the build (hashes rotate per build). "
        + "Idempotent — identical bytes (by SHA-256) are left in place. Fails fast on any chunk at/over the "
        + "~5 MB serve cap (glide.scriptable.excel.max_file_size) unless allowOversize. app is the application "
        + "record sys_id; dir is a local dist path on the server running this tool; script + m2m writes are "
        + "captured in the update set; dryRun previews without writing.",
      shape: hostAssetsSchema.shape,
      handler: async function (args: any) {
        return hostAssets(client(), hostAssetsSchema.parse(args));
      }
    }
  ];
}

export function registerAllTools(server: McpServer, deps: RegistryDeps = {}): void {
  // registerKitTools owns serialization + the { error, retryable, tool } contract.
  // No telemetry recorder is injected here (telemetry parity is a P2 follow-on).
  registerKitTools(server, buildDescriptors(deps));
}
