/**
 * ClickUp read-only MCP tools.
 *
 * Imports only read functions from @tenonhq/dovetail-clickup. createTask,
 * updateTask, updateTaskStatus, deleteTask, addComment are forbidden by ESLint
 * (.eslintrc.json) and asserted absent by tests/readonly-imports.test.ts.
 */

import type { AxiosInstance } from "axios";
import {
  createClient,
  getTask,
  listMyTasks,
  listTeamTasks
} from "@tenonhq/dovetail-clickup";
import type { ClickUpConfig } from "../config";
import {
  ClickupListTasksInput,
  ClickupGetTaskInput,
  ClickupSearchTasksInput,
  ClickupGetTeamSyncInput
} from "../schemas/clickup";
import { buildTeamSyncJson, TeamSyncJson } from "./teamsync";

export interface ClickUpDeps {
  config: ClickUpConfig;
  clientFactory?: (config: ClickUpConfig) => AxiosInstance;
  // Phase-2 master gate (mirrors SincMcpConfig.writesEnabled). Read tools ignore it.
  writesEnabled?: boolean;
}

export function resolveClient(deps: ClickUpDeps): AxiosInstance {
  var factory = deps.clientFactory || (function (cfg) {
    return createClient({ token: cfg.token });
  });
  return factory(deps.config);
}

function requireTeamId(deps: ClickUpDeps, override?: string): string {
  var teamId = override || deps.config.defaultTeamId;
  if (!teamId) {
    throw new Error(
      "teamId is required — pass it in the tool args or set CLICKUP_TEAM_ID."
    );
  }
  return teamId;
}

export async function clickupListTasks(
  args: ClickupListTasksInput,
  deps: ClickUpDeps
): Promise<{ tasks: any[]; byStatus: Record<string, any[]>; total: number }> {
  var client = resolveClient(deps);
  var teamId = requireTeamId(deps, args.teamId);
  var result = await listMyTasks({
    client: client,
    teamId: teamId,
    statuses: args.statuses
  });
  return {
    tasks: result.tasks,
    byStatus: result.byStatus,
    total: result.total
  };
}

// A ClickUp custom id looks like "DEV-506": a letter-led prefix, a hyphen, then
// digits. Internal ids (e.g. "86e1xmmpp") are hyphen-free lowercase alphanumerics,
// so a match is an unambiguous signal to take the custom-id path.
var CUSTOM_TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export async function clickupGetTask(
  args: ClickupGetTaskInput,
  deps: ClickUpDeps
): Promise<any> {
  var client = resolveClient(deps);
  // Explicit customTaskIds wins; otherwise infer from the id shape. Without this,
  // a custom id like "DEV-506" hits ClickUp's internal-id endpoint and 401s —
  // which the client used to mislabel as an auth failure.
  var useCustomId =
    args.customTaskIds !== undefined
      ? args.customTaskIds
      : CUSTOM_TASK_ID_PATTERN.test(args.taskId);
  var teamId = useCustomId ? requireTeamId(deps, args.teamId) : args.teamId;
  return await getTask({
    client: client,
    taskId: args.taskId,
    customTaskIds: useCustomId,
    teamId: teamId
  });
}

export async function clickupSearchTasks(
  args: ClickupSearchTasksInput,
  deps: ClickUpDeps
): Promise<{ tasks: any[]; total: number; query: string }> {
  var client = resolveClient(deps);
  var teamId = requireTeamId(deps, args.teamId);
  var result = await listTeamTasks({
    client: client,
    teamId: teamId,
    spaceIds: args.spaceIds,
    statuses: args.statuses,
    includeClosed: false
  });
  var needle = args.query.toLowerCase();
  var matched: any[] = [];
  for (var i = 0; i < result.tasks.length; i++) {
    var task = result.tasks[i];
    if ((task.name || "").toLowerCase().indexOf(needle) !== -1) {
      matched.push(task);
      continue;
    }
    if ((task.description || "").toLowerCase().indexOf(needle) !== -1) {
      matched.push(task);
    }
  }
  return { tasks: matched, total: matched.length, query: args.query };
}

export async function clickupGetTeamSync(
  args: ClickupGetTeamSyncInput,
  deps: ClickUpDeps
): Promise<TeamSyncJson> {
  var client = resolveClient(deps);
  var teamId = requireTeamId(deps, args.teamId);
  return await buildTeamSyncJson({ client: client, teamId: teamId });
}
