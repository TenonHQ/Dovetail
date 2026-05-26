/**
 * ClickUp API v2 type definitions for Dovetail integration.
 */

// --- Client Configuration ---

export interface ClickUpClientConfig {
  token: string;
  baseUrl?: string;
}

// --- Core Entities ---

export interface ClickUpUser {
  id: number;
  username: string;
  email: string;
  color: string;
  profilePicture: string | null;
  initials: string;
}

export interface ClickUpStatus {
  status: string;
  color: string;
  type: string;
  orderindex: number;
}

export interface ClickUpPriority {
  id: string;
  priority: string;
  color: string;
  orderindex: string;
}

export interface ClickUpCustomField {
  id: string;
  name: string;
  type: string;
  type_config: Record<string, unknown>;
  value: unknown;
}

export interface ClickUpTask {
  id: string;
  custom_id: string | null;
  name: string;
  description: string;
  status: ClickUpStatus;
  assignees: ClickUpUser[];
  priority: ClickUpPriority | null;
  url: string;
  date_created: string;
  date_updated: string;
  date_closed: string | null;
  creator: ClickUpUser;
  list: ClickUpListRef;
  folder: ClickUpFolderRef;
  space: ClickUpSpaceRef;
  tags: ClickUpTag[];
  custom_fields: ClickUpCustomField[];
  due_date: string | null;
  start_date: string | null;
  time_estimate: number | null;
}

export interface ClickUpListRef {
  id: string;
  name: string;
}

export interface ClickUpFolderRef {
  id: string;
  name: string;
}

export interface ClickUpSpaceRef {
  id: string;
}

export interface ClickUpTag {
  name: string;
  tag_fg: string;
  tag_bg: string;
}

export interface ClickUpTeam {
  id: string;
  name: string;
  color: string;
  members: ClickUpTeamMember[];
}

export interface ClickUpTeamMember {
  user: ClickUpUser;
}

export interface ClickUpSpace {
  id: string;
  name: string;
  private: boolean;
  statuses: ClickUpStatus[];
}

export interface ClickUpFolder {
  id: string;
  name: string;
  orderindex: number;
  hidden: boolean;
  space: ClickUpSpaceRef;
  lists: ClickUpList[];
}

export interface ClickUpList {
  id: string;
  name: string;
  orderindex: number;
  folder: ClickUpFolderRef;
  space: ClickUpSpaceRef;
  statuses: ClickUpStatus[];
  task_count: number | null;
}

export interface ClickUpComment {
  id: string;
  comment_text: string;
  user: ClickUpUser;
  date: string;
}

// --- Result Types ---

export interface TasksByStatus {
  [status: string]: ClickUpTask[];
}

export interface ListMyTasksResult {
  tasks: ClickUpTask[];
  byStatus: TasksByStatus;
  total: number;
}

export interface ParsedIdentifier {
  taskId: string;
  raw: string;
}

// --- Function Parameter Types (single-object pattern) ---

export interface GetTaskParams {
  taskId: string;
  // When true, taskId is treated as a custom ID (e.g. "DEV-225") and teamId is required.
  customTaskIds?: boolean;
  teamId?: string;
}

// A custom-field value to set inline on task creation or via setCustomField.
export interface ClickUpCustomFieldValue {
  id: string;
  value: unknown;
}

export interface ListMyTasksParams {
  teamId: string;
  statuses?: string[];
}

export interface CreateTaskParams {
  listId: string;
  name: string;
  description?: string;
  // Rendered markdown body. Inline checkbox runs are normalized to one per line.
  markdownContent?: string;
  assignees?: number[];
  status?: string;
  priority?: number;
  // Custom fields to set inline at creation, e.g. [{ id, value }].
  customFields?: ClickUpCustomFieldValue[];
}

export interface UpdateTaskParams {
  taskId: string;
  name?: string;
  description?: string;
  // Rendered markdown body. Inline checkbox runs are normalized to one per line.
  markdownContent?: string;
  status?: string;
  assignees?: number[];
  priority?: number;
  // When true, taskId is treated as a custom ID (e.g. "DEV-225") and teamId is required.
  customTaskIds?: boolean;
  teamId?: string;
}

export interface SetCustomFieldParams {
  taskId: string;
  fieldId: string;
  value: unknown;
  // When true, taskId is treated as a custom ID (e.g. "DEV-225") and teamId is required.
  customTaskIds?: boolean;
  teamId?: string;
}

export interface LinkTaskParams {
  taskId: string;
  linksTo: string;
  // When true, both task IDs are treated as custom IDs and teamId is required.
  customTaskIds?: boolean;
  teamId?: string;
}

export interface UpdateTaskStatusParams {
  taskId: string;
  status: string;
}

export interface DeleteTaskParams {
  taskId: string;
}

export interface AddCommentParams {
  taskId: string;
  commentText: string;
}

export interface GetSpacesParams {
  teamId: string;
}

export interface GetFoldersParams {
  spaceId: string;
}

export interface GetListsParams {
  folderId: string;
}

export interface FormatForClaudeParams {
  tasks: ClickUpTask[];
}

export interface FormatTaskDetailParams {
  task: ClickUpTask;
}

export interface FormatTaskSummaryParams {
  task: ClickUpTask;
}

// --- Team Task Sync Types ---

export interface GetSpaceListsParams {
  spaceId: string;
}

export interface GetListTasksParams {
  listId: string;
  page?: number;
  includeClosed?: boolean;
}

export interface FindListByNameParams {
  teamId: string;
  name: string;
}

export interface FindListByNameResult {
  list: ClickUpList | null;
  allLists: ClickUpList[];
}

export interface ListTeamTasksParams {
  teamId: string;
  spaceIds?: string[];
  statuses?: string[];
  includeClosed?: boolean;
}

export interface ListTeamTasksResult {
  tasks: ClickUpTask[];
  byStatus: TasksByStatus;
  byAssignee: { [name: string]: ClickUpTask[] };
  unassigned: ClickUpTask[];
  total: number;
}

// --- Team Sync Formatter Types ---

export type PipelineStage =
  | "Blocked"
  | "In Progress"
  | "In Review"
  | "QA"
  | "UAT"
  | "Ready for Release"
  | "Done"
  | "Unknown";

export interface PipelineGroup {
  stage: PipelineStage;
  tasks: ClickUpTask[];
}

export interface FormatTeamSyncParams {
  groups: PipelineGroup[];
  unassigned: ClickUpTask[];
  unmappedStatuses: { [status: string]: number };
  syncTime: Date;
  listCount: number;
}
