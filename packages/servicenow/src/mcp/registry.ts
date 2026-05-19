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

import { createClient } from "../client";
import type { ServiceNowClient } from "../client";
import { createView } from "../layout/views";
import { setListLayout } from "../layout/listLayout";
import { setFormLayout } from "../layout/formLayout";
import { setRelatedLists } from "../layout/relatedLists";
import { addChoicesToField } from "../choices";
import {
  createViewSchema,
  setListLayoutSchema,
  setFormLayoutSchema,
  setRelatedListsSchema,
  addChoicesToFieldSchema
} from "./schemas";

export var TOOL_NAMES = [
  "create_view",
  "set_list_layout",
  "set_form_layout",
  "set_related_lists",
  "add_choices_to_field"
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
  handler: (args: any) => Promise<any>;
}

export function buildDescriptors(deps: RegistryDeps = {}): Array<ToolDescriptor> {
  function client(): ServiceNowClient {
    return deps.client || createClient({});
  }
  return [
    {
      name: "create_view",
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
      description:
        "Upsert sys_choice values for a ServiceNow table.column and (optionally) flip "
        + "sys_dictionary.choice so the field renders as a dropdown. Idempotent. Writes are "
        + "captured in the supplied update set.",
      shape: addChoicesToFieldSchema.shape,
      handler: async function (args: any) {
        return addChoicesToField(client(), addChoicesToFieldSchema.parse(args));
      }
    }
  ];
}

export function registerAllTools(server: McpServer, deps: RegistryDeps = {}): void {
  var descriptors = buildDescriptors(deps);
  for (var i = 0; i < descriptors.length; i += 1) {
    registerOne(server, descriptors[i]);
  }
}

function registerOne(server: McpServer, desc: ToolDescriptor): void {
  (server.registerTool as any)(
    desc.name,
    { description: desc.description, inputSchema: desc.shape },
    async function (args: any) {
      try {
        var result = await desc.handler(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        var message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            { type: "text" as const, text: JSON.stringify({ error: message, tool: desc.name }) }
          ]
        };
      }
    }
  );
}
