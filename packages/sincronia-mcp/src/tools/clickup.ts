/**
 * ClickUp read-only MCP tools.
 *
 * Imports only read functions from @tenonhq/sincronia-clickup. createTask,
 * updateTask, updateTaskStatus, deleteTask, addComment are forbidden by ESLint
 * (.eslintrc.json) and asserted absent by tests/readonly-imports.test.ts.
 */

import type { AxiosInstance } from "axios";
import {
  createClient,
  getTask,
  listMyTasks,
  listTeamTasks
} from "@tenonhq/sincronia-clickup";
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
}

function resolveClient(deps: ClickUpDeps): AxiosInstance {
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

export async function clickupGetTask(
  args: ClickupGetTaskInput,
  deps: ClickUpDeps
): Promise<any> {
  var client = resolveClient(deps);
  return await getTask({ client: client, taskId: args.taskId });
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
