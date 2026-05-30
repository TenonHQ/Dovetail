/**
 * Zod input schemas for the TODO MCP tools. Schemas live in their own file so
 * registry.ts stays focused on wiring.
 */

import { z } from "zod";

// One-line input: no newlines, bounded length. The trim happens in storage.
var todoText = z
  .string()
  .min(1)
  .max(280)
  .refine(function (s) { return s.indexOf("\n") === -1; }, { message: "todo text must be a single line" });

var todoId = z.string().min(1).max(64);

export var addTodoSchema = z.object({
  text: todoText,
  position: z.enum(["top", "bottom"]).optional()
});

export var listTodosSchema = z.object({
  include_done: z.boolean().optional()
});

export var toggleTodoSchema = z.object({
  id: todoId,
  done: z.boolean().optional()
});

export var updateTodoSchema = z.object({
  id: todoId,
  text: todoText
});

export var reorderTodosSchema = z.object({
  ids: z.array(todoId).min(1)
});

export var moveTodoSchema = z.object({
  id: todoId,
  to_index: z.number().int().min(0)
});

export var removeTodoSchema = z.object({
  id: todoId
});

export var clearDoneSchema = z.object({});
