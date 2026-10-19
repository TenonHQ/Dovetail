/**
 * @tenonhq/dovetail-clickup
 *
 * ClickUp API v2 client for Dovetail.
 * Provides task management, workspace navigation, and formatting utilities.
 */

// Client and API functions
export {
  createClient,
  createClickUpApi,
  getAuthorizedUser,
  getTask,
  listMyTasks,
  listTeamTasks,
  createTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  setCustomField,
  linkTask,
  normalizeChecklistMarkdown,
  addComment,
  getGoals,
  getGoal,
  createGoal,
  updateGoal,
  deleteGoal,
  createKeyResult,
  editKeyResult,
  deleteKeyResult,
  getTeams,
  getSpaces,
  getFolders,
  getLists,
  getSpaceLists,
  getListTasks,
  findListByName,
} from "./client";

export type { ClickUpApi } from "./client";

// Formatting utilities
export {
  formatForClaude,
  formatTaskDetail,
  formatTaskSummary,
  formatTeamSync,
} from "./formatter";

// URL/ID parsing
export { parseClickUpIdentifier } from "./parser";

// Init plugin — discovered automatically by dovetail-core
export { sincPlugin } from "./plugin";

// Type definitions
export type {
  ClickUpClientConfig,
  ClickUpUser,
  ClickUpStatus,
  ClickUpPriority,
  ClickUpCustomField,
  ClickUpCustomFieldValue,
  ClickUpTask,
  ClickUpListRef,
  ClickUpFolderRef,
  ClickUpSpaceRef,
  ClickUpTag,
  ClickUpTeam,
  ClickUpTeamMember,
  ClickUpSpace,
  ClickUpFolder,
  ClickUpList,
  ClickUpComment,
  ClickUpGoal,
  ClickUpKeyResult,
  ClickUpKeyResultType,
  TasksByStatus,
  ListMyTasksResult,
  ListTeamTasksResult,
  ParsedIdentifier,
  PipelineStage,
  PipelineGroup,
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
  GetGoalsParams,
  GetGoalParams,
  CreateGoalParams,
  UpdateGoalParams,
  DeleteGoalParams,
  CreateKeyResultParams,
  EditKeyResultParams,
  DeleteKeyResultParams,
  GetSpacesParams,
  GetFoldersParams,
  GetListsParams,
  GetSpaceListsParams,
  GetListTasksParams,
  FormatForClaudeParams,
  FormatTaskDetailParams,
  FormatTaskSummaryParams,
  FormatTeamSyncParams,
} from "./types";
