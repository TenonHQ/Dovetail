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

import { flowViewOutput, actionViewOutput } from "./outputSchemas";

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
  editFlowSchema
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
  "flow_edit"
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
  outputSchema?: z.ZodRawShape;
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
      outputSchema: flowViewOutput.shape,
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
      outputSchema: actionViewOutput.shape,
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
    }
  ];
}

export function registerAllTools(server: McpServer, deps: RegistryDeps = {}): void {
  // registerKitTools owns serialization + the { error, retryable, tool } contract.
  // No telemetry recorder is injected here (telemetry parity is a P2 follow-on).
  registerKitTools(server, buildDescriptors(deps));
}
