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

// --- Goals + Key Results ---
// Goal and key-result ids are UUIDs. Key-result steps are integers — the ClickUp
// v2 API rejects fractional values, so callers needing precision pick a finer
// unit (hours, not days). Cross-field rules (boolean 0→1, automatic needs
// taskIds/listIds, start ≠ end) are enforced in clickup-write.ts.

var goalIdSchema = z.string().min(1);
var dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dueDate must be YYYY-MM-DD");
var colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "color must be #RRGGBB");
var userIdsSchema = z.array(z.number().int().positive());

export var clickupGetGoalsSchema = z.object({
  teamId: z.string().min(1).optional(),
  includeCompleted: z.boolean().optional()
}).strict();

export var clickupGetGoalSchema = z.object({
  goalId: goalIdSchema
}).strict();

export var clickupCreateGoalSchema = z.object({
  name: z.string().min(1),
  dueDate: dueDateSchema,
  description: z.string().optional(),
  owners: userIdsSchema.optional(),
  color: colorSchema.optional(),
  teamId: z.string().min(1).optional(),
  confirm: z.boolean().optional()
}).strict();

export var clickupUpdateGoalSchema = z.object({
  goalId: goalIdSchema,
  name: z.string().min(1).optional(),
  dueDate: dueDateSchema.optional(),
  description: z.string().optional(),
  addOwners: userIdsSchema.optional(),
  remOwners: userIdsSchema.optional(),
  color: colorSchema.optional(),
  confirm: z.boolean().optional()
}).strict();

export var clickupCreateKeyResultSchema = z.object({
  goalId: goalIdSchema,
  name: z.string().min(1),
  type: z.enum(["number", "currency", "boolean", "percentage", "automatic"]),
  stepsStart: z.number().int(),
  stepsEnd: z.number().int(),
  unit: z.string().optional(),
  owners: userIdsSchema.optional(),
  taskIds: z.array(z.string().min(1)).optional(),
  listIds: z.array(z.string().min(1)).optional(),
  confirm: z.boolean().optional()
}).strict();

export var clickupEditKeyResultSchema = z.object({
  keyResultId: z.string().min(1),
  stepsCurrent: z.number().int(),
  note: z.string().trim().min(1, "note is required (period + evidence link)"),
  confirm: z.boolean().optional()
}).strict();

export type ClickupGetGoalsInput = z.infer<typeof clickupGetGoalsSchema>;
export type ClickupGetGoalInput = z.infer<typeof clickupGetGoalSchema>;
export type ClickupCreateGoalInput = z.infer<typeof clickupCreateGoalSchema>;
export type ClickupUpdateGoalInput = z.infer<typeof clickupUpdateGoalSchema>;
export type ClickupCreateKeyResultInput = z.infer<typeof clickupCreateKeyResultSchema>;
export type ClickupEditKeyResultInput = z.infer<typeof clickupEditKeyResultSchema>;
