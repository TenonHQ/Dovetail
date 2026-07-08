import { z } from "zod";

export var clickupListTasksSchema = z.object({
  teamId: z.string().min(1).optional(),
  statuses: z.array(z.string()).optional()
}).strict();

// taskId may be a ClickUp internal id (e.g. "86e1xmmpp") OR a custom id
// (e.g. "DEV-506"). Custom-id lookups require custom_task_ids=true + a team_id;
// the tool auto-detects the custom-id shape and defaults the team, so callers
// normally pass only taskId. customTaskIds overrides the auto-detection.
export var clickupGetTaskSchema = z.object({
  taskId: z.string().min(1),
  customTaskIds: z.boolean().optional(),
  teamId: z.string().min(1).optional()
}).strict();

export var clickupSearchTasksSchema = z.object({
  query: z.string().min(1),
  teamId: z.string().min(1).optional(),
  statuses: z.array(z.string()).optional(),
  spaceIds: z.array(z.string()).optional()
}).strict();

export var clickupGetTeamSyncSchema = z.object({
  teamId: z.string().min(1).optional()
}).strict();

export type ClickupListTasksInput = z.infer<typeof clickupListTasksSchema>;
export type ClickupGetTaskInput = z.infer<typeof clickupGetTaskSchema>;
export type ClickupSearchTasksInput = z.infer<typeof clickupSearchTasksSchema>;
export type ClickupGetTeamSyncInput = z.infer<typeof clickupGetTeamSyncSchema>;

// --- Phase-2 gated write schemas ---
// Every write carries an optional confirm flag. Without confirm:true the tool
// returns a dry-run preview; with it, the write executes. customTaskIds:true
// treats taskId as a custom ID (e.g. "DEV-225") and requires teamId — that
// cross-field rule is enforced in clickup-write.ts (it can't live on the
// schema because the MCP SDK consumes .shape, which a ZodEffects from
// .refine() doesn't expose).

export var clickupUpdateTaskSchema = z.object({
  taskId: z.string().min(1),
  name: z.string().min(1).optional(),
  markdownContent: z.string().optional(),
  status: z.string().min(1).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  customTaskIds: z.boolean().optional(),
  teamId: z.string().min(1).optional(),
  confirm: z.boolean().optional()
}).strict();

export var clickupSetCustomFieldSchema = z.object({
  taskId: z.string().min(1),
  fieldId: z.string().min(1),
  value: z.unknown(),
  customTaskIds: z.boolean().optional(),
  teamId: z.string().min(1).optional(),
  confirm: z.boolean().optional()
}).strict();

export var clickupCreateTaskSchema = z.object({
  listId: z.string().min(1),
  name: z.string().min(1),
  markdownContent: z.string().optional(),
  status: z.string().min(1).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  assignees: z.array(z.number()).optional(),
  customFields: z.array(z.object({ id: z.string().min(1), value: z.unknown() })).optional(),
  confirm: z.boolean().optional()
}).strict();

export var clickupLinkTasksSchema = z.object({
  taskId: z.string().min(1),
  linksTo: z.string().min(1),
  customTaskIds: z.boolean().optional(),
  teamId: z.string().min(1).optional(),
  confirm: z.boolean().optional()
}).strict();

export type ClickupUpdateTaskInput = z.infer<typeof clickupUpdateTaskSchema>;
export type ClickupSetCustomFieldInput = z.infer<typeof clickupSetCustomFieldSchema>;
export type ClickupCreateTaskInput = z.infer<typeof clickupCreateTaskSchema>;
export type ClickupLinkTasksInput = z.infer<typeof clickupLinkTasksSchema>;
