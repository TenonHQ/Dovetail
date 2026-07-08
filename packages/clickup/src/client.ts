import axios, { AxiosInstance } from "axios";
import {
  ClickUpClientConfig,
  ClickUpTask,
  ClickUpUser,
  ClickUpTeam,
  ClickUpSpace,
  ClickUpFolder,
  ClickUpList,
  ClickUpComment,
  ListMyTasksResult,
  ListTeamTasksResult,
  TasksByStatus,
  GetTaskParams,
  ListMyTasksParams,
  ListTeamTasksParams,
  CreateTaskParams,
  UpdateTaskParams,
  UpdateTaskStatusParams,
  DeleteTaskParams,
  SetCustomFieldParams,
  LinkTaskParams,
  AddCommentParams,
  GetSpacesParams,
  GetFoldersParams,
  GetListsParams,
  GetSpaceListsParams,
  GetListTasksParams,
  FindListByNameParams,
  FindListByNameResult,
} from "./types";

var CLICKUP_BASE_URL = "https://api.clickup.com";

/**
 * @description Creates a configured axios instance for the ClickUp API v2.
 * @param config - Client configuration with token and optional base URL.
 * @returns Configured axios instance.
 */
export function createClient(config: ClickUpClientConfig): AxiosInstance {
  var baseURL = config.baseUrl || CLICKUP_BASE_URL;
  return axios.create({
    baseURL: baseURL,
    headers: {
      "Authorization": config.token,
      "Content-Type": "application/json",
    },
  });
}

// --- Error Handling ---

function handleApiError(error: unknown, context: string): never {
  if (axios.isAxiosError(error)) {
    var response = error.response;
    if (response) {
      if (response.status === 401) {
        throw new Error(
          "ClickUp authentication failed. Check your CLICKUP_API_TOKEN. " +
            "Run 'dove clickup setup' or verify your .env file."
        );
      }
      if (response.status === 404) {
        throw new Error("ClickUp " + context + " not found. Verify the ID.");
      }
      if (response.status === 429) {
        throw new Error(
          "ClickUp API rate limit exceeded. Wait a moment and try again."
        );
      }
      var message =
        response.data && typeof response.data === "object" && "err" in response.data
          ? String((response.data as Record<string, unknown>).err)
          : "HTTP " + response.status;
      throw new Error("ClickUp API error (" + context + "): " + message);
    }
  }
  throw error;
}

// --- Helpers ---

/**
 * @description Builds the axios request config for custom-ID task lookups.
 *   ClickUp endpoints accept a task's custom ID (e.g. "DEV-225") only when
 *   "custom_task_ids=true&team_id=<id>" is supplied. Returns an empty config
 *   when custom IDs are not in use.
 * @param params - Object with optional customTaskIds flag and teamId.
 * @returns Axios config object (possibly empty).
 */
function buildIdQuery(params: {
  customTaskIds?: boolean;
  teamId?: string;
}): { params?: Record<string, unknown> } {
  if (params.customTaskIds) {
    return { params: { custom_task_ids: true, team_id: params.teamId } };
  }
  return {};
}

/**
 * @description Splits inline checkbox runs onto separate lines. ClickUp renders
 *   only the FIRST checkbox on a line, so "- [ ] A   - [ ] B" collapses the rest
 *   into plain text. Leading indentation is preserved and reapplied to every
 *   split-out line, so nested checklists keep their hierarchy. Idempotent;
 *   lines with 0-1 checkboxes are returned as-is.
 * @param markdown - Markdown body that may contain inline checkbox runs.
 * @returns Markdown with one checkbox per line.
 */
export function normalizeChecklistMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .map(function (line) {
      var boxes = line.match(/- \[[ xX]\]/g);
      if (!boxes || boxes.length < 2) {
        return line;
      }
      // Preserve leading indentation. Split only on whitespace BETWEEN checkboxes,
      // and reapply the same indent to each subsequent line so nested checklists
      // keep their hierarchy.
      var leadingMatch = line.match(/^([ \t]*)/);
      var indent = leadingMatch ? leadingMatch[1] : "";
      var rest = line.slice(indent.length);
      return indent + rest.replace(/\s+(- \[[ xX]\])/g, "\n" + indent + "$1");
    })
    .join("\n");
}

// --- User ---

/**
 * @description Gets the authenticated user from the API token.
 * @param params - Object with the axios client.
 * @returns The authenticated ClickUp user.
 */
export async function getAuthorizedUser(params: {
  client: AxiosInstance;
}): Promise<ClickUpUser> {
  try {
    var response = await params.client.get("/api/v2/user");
    return response.data.user;
  } catch (error) {
    return handleApiError(error, "user");
  }
}

// --- Tasks ---

/**
 * @description Fetches a single ClickUp task by ID.
 * @param params - Object with client and taskId.
 * @returns The ClickUp task.
 */
export async function getTask(params: {
  client: AxiosInstance;
  taskId: string;
  customTaskIds?: boolean;
  teamId?: string;
}): Promise<ClickUpTask> {
  // Fail fast on the cross-field requirement: a custom-id lookup needs a
  // team_id. Without this we'd send team_id=undefined and let ClickUp 401,
  // then re-label that 401 below — cheaper and clearer to reject it here.
  if (params.customTaskIds && !params.teamId) {
    throw new Error(
      "teamId is required for a custom task id lookup (taskId '" +
        params.taskId +
        "'): custom_task_ids requires a team_id."
    );
  }
  try {
    var response = await params.client.get(
      "/api/v2/task/" + params.taskId,
      buildIdQuery(params)
    );
    return response.data;
  } catch (error) {
    // A 401 on a custom-id lookup (where a team_id was supplied) most often
    // means a bad id/team rather than a bad token — but a genuinely invalid or
    // expired token can 401 here too, so steer toward id/team without asserting
    // the token is fine.
    if (
      params.customTaskIds &&
      axios.isAxiosError(error) &&
      error.response &&
      error.response.status === 401
    ) {
      throw new Error(
        "ClickUp returned 401 for custom task id '" +
          params.taskId +
          "'. Custom-id lookups require a valid team_id — first verify the " +
          "custom id and team_id; if those are correct, check the API token."
      );
    }
    return handleApiError(error, "task '" + params.taskId + "'");
  }
}

/**
 * @description Lists tasks assigned to the authenticated user, grouped by status.
 * @param params - Object with client, teamId, and optional status filters.
 * @returns Tasks grouped by status with totals.
 */
export async function listMyTasks(params: {
  client: AxiosInstance;
  teamId: string;
  statuses?: string[];
}): Promise<ListMyTasksResult> {
  try {
    // Get the authenticated user's ID
    var user = await getAuthorizedUser({ client: params.client });

    var queryParams: Record<string, unknown> = {
      "assignees[]": user.id,
      "include_closed": false,
      "subtasks": true,
      "order_by": "updated",
      "reverse": true,
    };

    // Add status filters if provided
    if (params.statuses && params.statuses.length > 0) {
      queryParams["statuses[]"] = params.statuses;
    }

    var response = await params.client.get(
      "/api/v2/team/" + params.teamId + "/task",
      { params: queryParams }
    );

    var tasks: ClickUpTask[] = response.data.tasks || [];

    // Group by status
    var byStatus: TasksByStatus = {};
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      var statusName =
        task.status && task.status.status ? task.status.status : "unknown";
      if (!byStatus[statusName]) {
        byStatus[statusName] = [];
      }
      byStatus[statusName].push(task);
    }

    return {
      tasks: tasks,
      byStatus: byStatus,
      total: tasks.length,
    };
  } catch (error) {
    return handleApiError(error, "tasks for team '" + params.teamId + "'");
  }
}

/**
 * @description Creates a new task in a ClickUp list.
 * @param params - Object with client, listId, name, and optional fields.
 * @returns The created task.
 */
export async function createTask(params: {
  client: AxiosInstance;
  listId: string;
  name: string;
  description?: string;
  markdownContent?: string;
  assignees?: number[];
  status?: string;
  priority?: number;
  customFields?: Array<{ id: string; value: unknown }>;
}): Promise<ClickUpTask> {
  try {
    var body: Record<string, unknown> = {
      name: params.name,
    };
    if (params.markdownContent !== undefined) {
      body.markdown_content = normalizeChecklistMarkdown(params.markdownContent);
    } else if (params.description !== undefined) {
      body.description = params.description;
    }
    if (params.assignees !== undefined) {
      body.assignees = params.assignees;
    }
    if (params.status !== undefined) {
      body.status = params.status;
    }
    if (params.priority !== undefined) {
      body.priority = params.priority;
    }
    if (params.customFields !== undefined) {
      body.custom_fields = params.customFields;
    }

    var response = await params.client.post(
      "/api/v2/list/" + params.listId + "/task",
      body
    );
    return response.data;
  } catch (error) {
    return handleApiError(error, "creating task in list '" + params.listId + "'");
  }
}

/**
 * @description Updates an existing ClickUp task.
 * @param params - Object with client, taskId, and fields to update.
 * @returns The updated task.
 */
export async function updateTask(params: {
  client: AxiosInstance;
  taskId: string;
  name?: string;
  description?: string;
  markdownContent?: string;
  status?: string;
  assignees?: number[];
  priority?: number;
  customTaskIds?: boolean;
  teamId?: string;
}): Promise<ClickUpTask> {
  try {
    var body: Record<string, unknown> = {};
    if (params.name !== undefined) {
      body.name = params.name;
    }
    if (params.markdownContent !== undefined) {
      body.markdown_content = normalizeChecklistMarkdown(params.markdownContent);
    } else if (params.description !== undefined) {
      body.description = params.description;
    }
    if (params.status !== undefined) {
      body.status = params.status;
    }
    if (params.assignees !== undefined) {
      body.assignees = params.assignees;
    }
    if (params.priority !== undefined) {
      body.priority = params.priority;
    }

    var response = await params.client.put(
      "/api/v2/task/" + params.taskId,
      body,
      buildIdQuery(params)
    );
    return response.data;
  } catch (error) {
    return handleApiError(error, "updating task '" + params.taskId + "'");
  }
}

/**
 * @description Convenience function to update only a task's status.
 * @param params - Object with client, taskId, and new status.
 * @returns The updated task.
 */
export async function updateTaskStatus(params: {
  client: AxiosInstance;
  taskId: string;
  status: string;
}): Promise<ClickUpTask> {
  return updateTask({
    client: params.client,
    taskId: params.taskId,
    status: params.status,
  });
}

/**
 * @description Deletes a ClickUp task.
 * @param params - Object with client and taskId.
 */
export async function deleteTask(params: {
  client: AxiosInstance;
  taskId: string;
}): Promise<void> {
  try {
    await params.client.delete("/api/v2/task/" + params.taskId);
  } catch (error) {
    return handleApiError(error, "deleting task '" + params.taskId + "'");
  }
}

// --- Custom Fields & Links ---

/**
 * @description Sets a single custom-field value on a task. Value shape depends on
 *   the field type: string for text/url, the option id for drop_down, and
 *   { add: number[], rem: number[] } for users fields.
 * @param params - Object with client, taskId, fieldId, value, and optional custom-ID resolution.
 */
export async function setCustomField(params: {
  client: AxiosInstance;
  taskId: string;
  fieldId: string;
  value: unknown;
  customTaskIds?: boolean;
  teamId?: string;
}): Promise<void> {
  try {
    await params.client.post(
      "/api/v2/task/" + params.taskId + "/field/" + params.fieldId,
      { value: params.value },
      buildIdQuery(params)
    );
  } catch (error) {
    return handleApiError(
      error,
      "setting custom field '" + params.fieldId + "' on task '" + params.taskId + "'"
    );
  }
}

/**
 * @description Creates a link between two tasks (the ClickUp "linked tasks" relation).
 * @param params - Object with client, taskId, linksTo, and optional custom-ID resolution.
 */
export async function linkTask(params: {
  client: AxiosInstance;
  taskId: string;
  linksTo: string;
  customTaskIds?: boolean;
  teamId?: string;
}): Promise<void> {
  try {
    await params.client.post(
      "/api/v2/task/" + params.taskId + "/link/" + params.linksTo,
      {},
      buildIdQuery(params)
    );
  } catch (error) {
    return handleApiError(
      error,
      "linking task '" + params.taskId + "' to '" + params.linksTo + "'"
    );
  }
}

// --- Comments ---

/**
 * @description Adds a comment to a ClickUp task.
 * @param params - Object with client, taskId, and comment text.
 * @returns The created comment.
 */
export async function addComment(params: {
  client: AxiosInstance;
  taskId: string;
  commentText: string;
}): Promise<ClickUpComment> {
  try {
    var response = await params.client.post(
      "/api/v2/task/" + params.taskId + "/comment",
      { comment_text: params.commentText }
    );
    return response.data;
  } catch (error) {
    return handleApiError(
      error,
      "adding comment to task '" + params.taskId + "'"
    );
  }
}

// --- Workspace / Hierarchy ---

/**
 * @description Lists all teams (workspaces) accessible to the authenticated user.
 * @param params - Object with the axios client.
 * @returns Array of ClickUp teams.
 */
export async function getTeams(params: {
  client: AxiosInstance;
}): Promise<ClickUpTeam[]> {
  try {
    var response = await params.client.get("/api/v2/team");
    return response.data.teams || [];
  } catch (error) {
    return handleApiError(error, "teams");
  }
}

/**
 * @description Lists all spaces in a team/workspace.
 * @param params - Object with client and teamId.
 * @returns Array of ClickUp spaces.
 */
export async function getSpaces(params: {
  client: AxiosInstance;
  teamId: string;
}): Promise<ClickUpSpace[]> {
  try {
    var response = await params.client.get(
      "/api/v2/team/" + params.teamId + "/space"
    );
    return response.data.spaces || [];
  } catch (error) {
    return handleApiError(error, "spaces for team '" + params.teamId + "'");
  }
}

/**
 * @description Lists all folders in a space.
 * @param params - Object with client and spaceId.
 * @returns Array of ClickUp folders.
 */
export async function getFolders(params: {
  client: AxiosInstance;
  spaceId: string;
}): Promise<ClickUpFolder[]> {
  try {
    var response = await params.client.get(
      "/api/v2/space/" + params.spaceId + "/folder"
    );
    return response.data.folders || [];
  } catch (error) {
    return handleApiError(error, "folders for space '" + params.spaceId + "'");
  }
}

/**
 * @description Lists all lists in a folder.
 * @param params - Object with client and folderId.
 * @returns Array of ClickUp lists.
 */
export async function getLists(params: {
  client: AxiosInstance;
  folderId: string;
}): Promise<ClickUpList[]> {
  try {
    var response = await params.client.get(
      "/api/v2/folder/" + params.folderId + "/list"
    );
    return response.data.lists || [];
  } catch (error) {
    return handleApiError(error, "lists for folder '" + params.folderId + "'");
  }
}

// --- Space Lists (folderless) ---

/**
 * @description Lists all folderless lists in a space.
 * @param params - Object with client and spaceId.
 * @returns Array of ClickUp lists.
 */
export async function getSpaceLists(params: {
  client: AxiosInstance;
  spaceId: string;
}): Promise<ClickUpList[]> {
  try {
    var response = await params.client.get(
      "/api/v2/space/" + params.spaceId + "/list"
    );
    return response.data.lists || [];
  } catch (error) {
    return handleApiError(error, "lists for space '" + params.spaceId + "'");
  }
}

// --- List Discovery ---

/**
 * @description Finds a ClickUp list by name across all spaces and folders in a team.
 * @param params - Object with client, teamId, and list name to search for.
 * @returns The matched list (case-insensitive) and all discovered lists.
 */
export async function findListByName(params: {
  client: AxiosInstance;
  teamId: string;
  name: string;
}): Promise<FindListByNameResult> {
  try {
    var allLists: ClickUpList[] = [];
    var searchName = params.name.toLowerCase();

    var spaces = await getSpaces({ client: params.client, teamId: params.teamId });

    for (var s = 0; s < spaces.length; s++) {
      var spaceId = spaces[s].id;

      // Folderless lists
      var spaceLists = await getSpaceLists({ client: params.client, spaceId: spaceId });
      for (var sl = 0; sl < spaceLists.length; sl++) {
        allLists.push(spaceLists[sl]);
      }

      // Folder lists
      var folders = await getFolders({ client: params.client, spaceId: spaceId });
      for (var f = 0; f < folders.length; f++) {
        var folderLists = folders[f].lists || [];
        for (var fl = 0; fl < folderLists.length; fl++) {
          allLists.push(folderLists[fl]);
        }
      }
    }

    // Case-insensitive match
    var matched: ClickUpList | null = null;
    for (var i = 0; i < allLists.length; i++) {
      if (allLists[i].name.toLowerCase() === searchName) {
        matched = allLists[i];
        break;
      }
    }

    return {
      list: matched,
      allLists: allLists,
    };
  } catch (error) {
    return handleApiError(error, "finding list '" + params.name + "'");
  }
}

// --- List Tasks ---

/**
 * @description Fetches tasks from a specific list with pagination support.
 * @param params - Object with client, listId, optional page number and includeClosed flag.
 * @returns Array of ClickUp tasks for that page.
 */
export async function getListTasks(params: {
  client: AxiosInstance;
  listId: string;
  page?: number;
  includeClosed?: boolean;
}): Promise<ClickUpTask[]> {
  try {
    var queryParams: Record<string, unknown> = {
      "subtasks": true,
      "page": params.page !== undefined ? params.page : 0,
      "include_closed": params.includeClosed === true,
    };

    var response = await params.client.get(
      "/api/v2/list/" + params.listId + "/task",
      { params: queryParams }
    );
    return response.data.tasks || [];
  } catch (error) {
    return handleApiError(error, "tasks for list '" + params.listId + "'");
  }
}

/**
 * @description Fetches all tasks from a list, handling pagination automatically.
 * @param params - Object with client, listId, and optional includeClosed flag.
 * @returns All tasks from the list.
 */
async function getAllListTasks(params: {
  client: AxiosInstance;
  listId: string;
  includeClosed?: boolean;
}): Promise<ClickUpTask[]> {
  var allTasks: ClickUpTask[] = [];
  var page = 0;

  while (true) {
    var tasks = await getListTasks({
      client: params.client,
      listId: params.listId,
      page: page,
      includeClosed: params.includeClosed,
    });
    allTasks = allTasks.concat(tasks);
    if (tasks.length < 100) {
      break;
    }
    page = page + 1;
  }

  return allTasks;
}

// --- Team Tasks ---

/**
 * @description Fetches all tasks across configured spaces, grouped by status and assignee.
 * @param params - Object with client, teamId, optional spaceIds, statuses, and includeClosed.
 * @returns Tasks grouped by status and assignee with totals.
 */
export async function listTeamTasks(params: {
  client: AxiosInstance;
  teamId: string;
  spaceIds?: string[];
  statuses?: string[];
  includeClosed?: boolean;
}): Promise<ListTeamTasksResult> {
  try {
    // Resolve spaces — use provided spaceIds or fetch all from team
    var spaces: string[] = [];
    if (params.spaceIds && params.spaceIds.length > 0) {
      spaces = params.spaceIds;
    } else {
      var teamSpaces = await getSpaces({ client: params.client, teamId: params.teamId });
      for (var si = 0; si < teamSpaces.length; si++) {
        spaces.push(teamSpaces[si].id);
      }
    }

    // Collect all list IDs from all spaces
    var listIds: string[] = [];

    for (var s = 0; s < spaces.length; s++) {
      var spaceId = spaces[s];

      // Folderless lists
      var spaceLists = await getSpaceLists({ client: params.client, spaceId: spaceId });
      for (var sl = 0; sl < spaceLists.length; sl++) {
        listIds.push(spaceLists[sl].id);
      }

      // Folder lists
      var folders = await getFolders({ client: params.client, spaceId: spaceId });
      for (var f = 0; f < folders.length; f++) {
        var folderLists = folders[f].lists || [];
        for (var fl = 0; fl < folderLists.length; fl++) {
          listIds.push(folderLists[fl].id);
        }
      }
    }

    // Fetch tasks from all lists
    var allTasks: ClickUpTask[] = [];
    var seen: Record<string, boolean> = {};

    for (var l = 0; l < listIds.length; l++) {
      var tasks = await getAllListTasks({
        client: params.client,
        listId: listIds[l],
        includeClosed: params.includeClosed,
      });

      for (var t = 0; t < tasks.length; t++) {
        var task = tasks[t];
        if (!seen[task.id]) {
          seen[task.id] = true;

          // Apply status filter if provided
          if (params.statuses && params.statuses.length > 0) {
            var taskStatus = task.status && task.status.status
              ? task.status.status.toLowerCase()
              : "";
            var matched = false;
            for (var st = 0; st < params.statuses.length; st++) {
              if (taskStatus === params.statuses[st].toLowerCase()) {
                matched = true;
                break;
              }
            }
            if (!matched) {
              continue;
            }
          }

          allTasks.push(task);
        }
      }
    }

    // Group by status
    var byStatus: TasksByStatus = {};
    for (var bs = 0; bs < allTasks.length; bs++) {
      var bsTask = allTasks[bs];
      var statusName = bsTask.status && bsTask.status.status
        ? bsTask.status.status
        : "unknown";
      if (!byStatus[statusName]) {
        byStatus[statusName] = [];
      }
      byStatus[statusName].push(bsTask);
    }

    // Group by assignee
    var byAssignee: { [name: string]: ClickUpTask[] } = {};
    var unassigned: ClickUpTask[] = [];

    for (var ba = 0; ba < allTasks.length; ba++) {
      var baTask = allTasks[ba];
      if (!baTask.assignees || baTask.assignees.length === 0) {
        unassigned.push(baTask);
      } else {
        for (var a = 0; a < baTask.assignees.length; a++) {
          var assigneeName = baTask.assignees[a].username
            || baTask.assignees[a].email
            || String(baTask.assignees[a].id);
          if (!byAssignee[assigneeName]) {
            byAssignee[assigneeName] = [];
          }
          byAssignee[assigneeName].push(baTask);
        }
      }
    }

    return {
      tasks: allTasks,
      byStatus: byStatus,
      byAssignee: byAssignee,
      unassigned: unassigned,
      total: allTasks.length,
    };
  } catch (error) {
    return handleApiError(error, "team tasks for team '" + params.teamId + "'");
  }
}

// --- Convenience API Factory ---

export interface ClickUpApi {
  getAuthorizedUser(): Promise<ClickUpUser>;
  getTask(params: GetTaskParams): Promise<ClickUpTask>;
  listMyTasks(params: ListMyTasksParams): Promise<ListMyTasksResult>;
  listTeamTasks(params: ListTeamTasksParams): Promise<ListTeamTasksResult>;
  createTask(params: CreateTaskParams): Promise<ClickUpTask>;
  updateTask(params: UpdateTaskParams): Promise<ClickUpTask>;
  updateTaskStatus(params: UpdateTaskStatusParams): Promise<ClickUpTask>;
  deleteTask(params: DeleteTaskParams): Promise<void>;
  setCustomField(params: SetCustomFieldParams): Promise<void>;
  linkTask(params: LinkTaskParams): Promise<void>;
  addComment(params: AddCommentParams): Promise<ClickUpComment>;
  getTeams(): Promise<ClickUpTeam[]>;
  getSpaces(params: GetSpacesParams): Promise<ClickUpSpace[]>;
  getFolders(params: GetFoldersParams): Promise<ClickUpFolder[]>;
  getLists(params: GetListsParams): Promise<ClickUpList[]>;
  getSpaceLists(params: GetSpaceListsParams): Promise<ClickUpList[]>;
  getListTasks(params: GetListTasksParams): Promise<ClickUpTask[]>;
  findListByName(params: FindListByNameParams): Promise<FindListByNameResult>;
}

/**
 * @description Creates a ClickUp API object with all functions pre-bound to a client.
 * @param config - Client configuration with token and optional base URL.
 * @returns Object with all ClickUp API functions.
 */
export function createClickUpApi(config: ClickUpClientConfig): ClickUpApi {
  var client = createClient(config);

  return {
    getAuthorizedUser: function () {
      return getAuthorizedUser({ client: client });
    },
    getTask: function (params: GetTaskParams) {
      return getTask({
        client: client,
        taskId: params.taskId,
        customTaskIds: params.customTaskIds,
        teamId: params.teamId,
      });
    },
    listMyTasks: function (params: ListMyTasksParams) {
      return listMyTasks({
        client: client,
        teamId: params.teamId,
        statuses: params.statuses,
      });
    },
    createTask: function (params: CreateTaskParams) {
      return createTask({
        client: client,
        listId: params.listId,
        name: params.name,
        description: params.description,
        markdownContent: params.markdownContent,
        assignees: params.assignees,
        status: params.status,
        priority: params.priority,
        customFields: params.customFields,
      });
    },
    updateTask: function (params: UpdateTaskParams) {
      return updateTask({
        client: client,
        taskId: params.taskId,
        name: params.name,
        description: params.description,
        markdownContent: params.markdownContent,
        status: params.status,
        assignees: params.assignees,
        priority: params.priority,
        customTaskIds: params.customTaskIds,
        teamId: params.teamId,
      });
    },
    updateTaskStatus: function (params: UpdateTaskStatusParams) {
      return updateTaskStatus({
        client: client,
        taskId: params.taskId,
        status: params.status,
      });
    },
    deleteTask: function (params: DeleteTaskParams) {
      return deleteTask({ client: client, taskId: params.taskId });
    },
    setCustomField: function (params: SetCustomFieldParams) {
      return setCustomField({
        client: client,
        taskId: params.taskId,
        fieldId: params.fieldId,
        value: params.value,
        customTaskIds: params.customTaskIds,
        teamId: params.teamId,
      });
    },
    linkTask: function (params: LinkTaskParams) {
      return linkTask({
        client: client,
        taskId: params.taskId,
        linksTo: params.linksTo,
        customTaskIds: params.customTaskIds,
        teamId: params.teamId,
      });
    },
    addComment: function (params: AddCommentParams) {
      return addComment({
        client: client,
        taskId: params.taskId,
        commentText: params.commentText,
      });
    },
    getTeams: function () {
      return getTeams({ client: client });
    },
    getSpaces: function (params: GetSpacesParams) {
      return getSpaces({ client: client, teamId: params.teamId });
    },
    getFolders: function (params: GetFoldersParams) {
      return getFolders({ client: client, spaceId: params.spaceId });
    },
    getLists: function (params: GetListsParams) {
      return getLists({ client: client, folderId: params.folderId });
    },
    getSpaceLists: function (params: GetSpaceListsParams) {
      return getSpaceLists({ client: client, spaceId: params.spaceId });
    },
    getListTasks: function (params: GetListTasksParams) {
      return getListTasks({
        client: client,
        listId: params.listId,
        page: params.page,
        includeClosed: params.includeClosed,
      });
    },
    listTeamTasks: function (params: ListTeamTasksParams) {
      return listTeamTasks({
        client: client,
        teamId: params.teamId,
        spaceIds: params.spaceIds,
        statuses: params.statuses,
        includeClosed: params.includeClosed,
      });
    },
    findListByName: function (params: FindListByNameParams) {
      return findListByName({
        client: client,
        teamId: params.teamId,
        name: params.name,
      });
    },
  };
}
