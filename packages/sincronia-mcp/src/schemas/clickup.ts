import { z } from "zod";

export var clickupListTasksSchema = z.object({
  teamId: z.string().min(1).optional(),
  statuses: z.array(z.string()).optional()
}).strict();

export var clickupGetTaskSchema = z.object({
  taskId: z.string().min(1)
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
