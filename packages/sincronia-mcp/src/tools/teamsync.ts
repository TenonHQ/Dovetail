/**
 * Builds a structured JSON team sync from listTeamTasks output. Mirrors the
 * 7-stage pipeline in @tenonhq/sincronia-clickup formatter.ts so the JSON
 * tool output has the same semantics as the existing markdown formatter,
 * but as a structured object instead of a string.
 */

import type { AxiosInstance } from "axios";
import { listTeamTasks } from "@tenonhq/sincronia-clickup";

export var STATUS_MAP: Record<string, string> = {
  blocked: "Blocked",
  "in progress": "In Progress",
  "in review": "In Review",
  qa: "QA",
  uat: "UAT",
  "ready for release": "Ready for Release",
  done: "Done"
};

export var STAGE_ORDER = [
  "Blocked",
  "In Progress",
  "In Review",
  "QA",
  "UAT",
  "Ready for Release",
  "Done"
];

export interface TeamSyncTask {
  id: string;
  customId: string | null;
  name: string;
  status: string;
  url: string;
  list: string;
  assignees: string[];
  dueDate: string | null;
  dateUpdated: string;
}

export interface TeamSyncStage {
  stage: string;
  count: number;
  tasks: TeamSyncTask[];
}

export interface TeamSyncJson {
  syncTime: string;
  total: number;
  totalLists: number;
  stages: TeamSyncStage[];
  unmappedStatuses: Record<string, number>;
  unassigned: TeamSyncTask[];
}

export interface BuildTeamSyncDeps {
  client: AxiosInstance;
  teamId: string;
}

export async function buildTeamSyncJson(deps: BuildTeamSyncDeps): Promise<TeamSyncJson> {
  var result = await listTeamTasks({
    client: deps.client,
    teamId: deps.teamId,
    includeClosed: false
  });

  var stages: Record<string, TeamSyncTask[]> = {};
  var unmapped: Record<string, number> = {};
  var unassigned: TeamSyncTask[] = [];

  var listIds: Record<string, boolean> = {};

  for (var i = 0; i < result.tasks.length; i++) {
    var task = result.tasks[i];
    var statusName = task.status && task.status.status ? task.status.status : "unknown";
    var stageName = STATUS_MAP[statusName.toLowerCase()];
    var entry = toTeamSyncTask(task);

    if (entry.list) {
      listIds[entry.list] = true;
    }

    if (!stageName) {
      unmapped[statusName] = (unmapped[statusName] || 0) + 1;
      continue;
    }

    if (!stages[stageName]) {
      stages[stageName] = [];
    }
    stages[stageName].push(entry);
  }

  for (var u = 0; u < result.unassigned.length; u++) {
    unassigned.push(toTeamSyncTask(result.unassigned[u]));
  }

  var orderedStages: TeamSyncStage[] = [];
  for (var s = 0; s < STAGE_ORDER.length; s++) {
    var name = STAGE_ORDER[s];
    var tasks = stages[name] || [];
    tasks.sort(function (a, b) {
      return parseInt(b.dateUpdated, 10) - parseInt(a.dateUpdated, 10);
    });
    orderedStages.push({ stage: name, count: tasks.length, tasks: tasks });
  }

  return {
    syncTime: new Date().toISOString(),
    total: result.total,
    totalLists: Object.keys(listIds).length,
    stages: orderedStages,
    unmappedStatuses: unmapped,
    unassigned: unassigned
  };
}

function toTeamSyncTask(task: any): TeamSyncTask {
  var assignees: string[] = [];
  if (task.assignees && task.assignees.length > 0) {
    for (var i = 0; i < task.assignees.length; i++) {
      var a = task.assignees[i];
      assignees.push(a.username || a.email || String(a.id));
    }
  }
  return {
    id: task.id,
    customId: task.custom_id || null,
    name: task.name,
    status: task.status && task.status.status ? task.status.status : "unknown",
    url: task.url || "",
    list: task.list && task.list.name ? task.list.name : "",
    assignees: assignees,
    dueDate: task.due_date || null,
    dateUpdated: task.date_updated || "0"
  };
}
