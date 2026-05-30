/**
 * Tool registration glue for the TODO MCP server. Mirrors the descriptor +
 * handler pattern from @tenonhq/dovetail-claude-plans' registry.ts. Handlers
 * stay thin — validation lives in zod schemas, persistence in storage.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  addTodoSchema,
  listTodosSchema,
  toggleTodoSchema,
  updateTodoSchema,
  reorderTodosSchema,
  moveTodoSchema,
  removeTodoSchema,
  clearDoneSchema
} from "./schemas";
import {
  addTodo,
  listTodos,
  toggleTodo,
  updateTodo,
  reorderTodos,
  moveTodo,
  removeTodo,
  clearDone,
  loadList,
  StorageOptions
} from "./storage";

export var TOOL_NAMES = [
  "todo_add",
  "todo_list",
  "todo_toggle",
  "todo_update",
  "todo_reorder",
  "todo_move",
  "todo_remove",
  "todo_clear_done"
] as const;

export type ToolName = typeof TOOL_NAMES[number];

export interface RegistryDeps {
  storage?: StorageOptions;
}

interface ToolDescriptor {
  name: ToolName;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: any) => Promise<any>;
}

// Override the dashboard base via DOVE_DASHBOARD_URL if it runs on a non-default
// port/host. Trailing slashes are tolerated.
export function todosDashboardUrl(): string {
  var raw = process.env.DOVE_DASHBOARD_URL || "http://localhost:3456";
  var base = raw.replace(/\/+$/, "");
  return base + "/todos";
}

export function buildDescriptors(deps: RegistryDeps = {}): ToolDescriptor[] {
  var storageOpts = deps.storage || {};

  return [
    {
      name: "todo_add",
      description:
        "Add a one-line item to the priority TODO list shown in the Dovetail dashboard at /todos. " +
        "List order IS priority — index 0 is the top priority. position 'top' makes it the new " +
        "highest priority; 'bottom' (default) appends to the end.\n\n" +
        "Inputs:\n" +
        "  text (required, single line, <=280 chars) — the item.\n" +
        "  position (optional) — 'top' | 'bottom' (default 'bottom').\n\n" +
        "Returns { item, list, url }.",
      shape: addTodoSchema.shape,
      handler: async function (args: any) {
        var parsed = addTodoSchema.parse(args);
        var result = addTodo({ text: parsed.text, position: parsed.position }, storageOpts);
        return { item: result.item, list: result.list, url: todosDashboardUrl() };
      }
    },
    {
      name: "todo_list",
      description:
        "List TODO items in priority order (index 0 = top priority). Set include_done:false to " +
        "hide completed items. Returns { items, count }.",
      shape: listTodosSchema.shape,
      handler: async function (args: any) {
        var parsed = listTodosSchema.parse(args || {});
        var items = listTodos({ include_done: parsed.include_done, rootDir: storageOpts.rootDir });
        return { items: items, count: items.length };
      }
    },
    {
      name: "todo_toggle",
      description:
        "Check or uncheck a TODO item. Omit `done` to flip the current state; pass done:true/false " +
        "to set it explicitly. Returns the updated { item, list }.",
      shape: toggleTodoSchema.shape,
      handler: async function (args: any) {
        var parsed = toggleTodoSchema.parse(args);
        return toggleTodo({ id: parsed.id, done: parsed.done }, storageOpts);
      }
    },
    {
      name: "todo_update",
      description: "Edit the text of an existing TODO item. Returns the updated { item, list }.",
      shape: updateTodoSchema.shape,
      handler: async function (args: any) {
        var parsed = updateTodoSchema.parse(args);
        return updateTodo({ id: parsed.id, text: parsed.text }, storageOpts);
      }
    },
    {
      name: "todo_reorder",
      description:
        "Persist a full priority ordering. `ids` must be the COMPLETE set of current item ids in " +
        "their new order (index 0 = top priority) — a permutation of the existing ids. Any missing, " +
        "duplicate, or unknown id is rejected so a stale view can't drop items. This is the write " +
        "the dashboard issues on drag-end. Returns the reordered list.",
      shape: reorderTodosSchema.shape,
      handler: async function (args: any) {
        var parsed = reorderTodosSchema.parse(args);
        return reorderTodos({ ids: parsed.ids }, storageOpts);
      }
    },
    {
      name: "todo_move",
      description:
        "Move a single item to a new priority index (0 = top). Convenience over todo_reorder when " +
        "you only know one item's target slot. to_index is clamped to the list bounds. Returns the list.",
      shape: moveTodoSchema.shape,
      handler: async function (args: any) {
        var parsed = moveTodoSchema.parse(args);
        return moveTodo({ id: parsed.id, to_index: parsed.to_index }, storageOpts);
      }
    },
    {
      name: "todo_remove",
      description: "Delete a TODO item by id. Returns { removed, list }. removed=false if the id was absent.",
      shape: removeTodoSchema.shape,
      handler: async function (args: any) {
        var parsed = removeTodoSchema.parse(args);
        return removeTodo({ id: parsed.id }, storageOpts);
      }
    },
    {
      name: "todo_clear_done",
      description: "Remove every completed (done) item in one shot. Returns { removed, list }.",
      shape: clearDoneSchema.shape,
      handler: async function (_args: any) {
        return clearDone(storageOpts);
      }
    }
  ];
}

export function registerAllTools(server: McpServer, deps: RegistryDeps = {}): void {
  var descriptors = buildDescriptors(deps);
  for (var i = 0; i < descriptors.length; i++) registerOne(server, descriptors[i]);
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
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, tool: desc.name })
            }
          ]
        };
      }
    }
  );
}

// Re-export so loadList is reachable through the registry module in tests.
export { loadList };
