/**
 * ClickUp gated write tools (Phase 2).
 *
 * This is the ONE declared write module. It is the single exception in
 * tests/readonly-imports.test.ts and .eslintrc.json — every OTHER tool module
 * must remain read-only.
 *
 * Gating:
 *   1. Operator gate: deps.writesEnabled (SINC_MCP_WRITES_ENABLE=1), else
 *      refuse. This is the only boundary an autonomous agent cannot self-flip.
 *   2. Preview affordance: confirm:true in the args, else return a dry-run.
 *      The calling agent can set confirm itself — this is a preview/speed-bump,
 *      NOT a human-in-the-loop checkpoint.
 */

import {
  createTask,
  updateTask,
  setCustomField,
  linkTask
} from "@tenonhq/dovetail-clickup";
import { ClickUpDeps, resolveClient } from "./clickup";
import {
  ClickupUpdateTaskInput,
  ClickupSetCustomFieldInput,
  ClickupCreateTaskInput,
  ClickupLinkTasksInput
} from "../schemas/clickup";

function ensureWritesEnabled(deps: ClickUpDeps): void {
  if (!deps.writesEnabled) {
    throw new Error(
      "ClickUp writes are disabled. Set SINC_MCP_WRITES_ENABLE=1 to enable gated writes."
    );
  }
}

/**
 * Cross-field guard: customTaskIds:true requires teamId. ClickUp would
 * otherwise return an opaque 401 (the same one this PR series set out to fix).
 * Lives in the handler — not on the schema — because the MCP SDK consumes the
 * raw object shape and would ignore a zod refinement.
 */
function ensureTeamIdWhenCustom(args: {
  customTaskIds?: boolean;
  teamId?: string;
}): void {
  if (args.customTaskIds && (typeof args.teamId !== "string" || args.teamId.length === 0)) {
    throw new Error(
      "teamId is required when customTaskIds is true (ClickUp custom-ID lookups need ?team_id=…)."
    );
  }
}

var DRY_RUN_NOTE = "Dry run — no write performed. Re-run with confirm:true to apply.";

export async function clickupUpdateTask(
  args: ClickupUpdateTaskInput,
  deps: ClickUpDeps
): Promise<any> {
  ensureWritesEnabled(deps);
  ensureTeamIdWhenCustom(args);
  if (!args.confirm) {
    return {
      dryRun: true,
      action: "update_task",
      taskId: args.taskId,
      changes: {
        name: args.name,
        markdownContent: args.markdownContent,
        status: args.status,
        priority: args.priority
      },
      note: DRY_RUN_NOTE
    };
  }
  var client = resolveClient(deps);
  return await updateTask({
    client: client,
    taskId: args.taskId,
    name: args.name,
    markdownContent: args.markdownContent,
    status: args.status,
    priority: args.priority,
    customTaskIds: args.customTaskIds,
    teamId: args.teamId
  });
}

export async function clickupSetCustomField(
  args: ClickupSetCustomFieldInput,
  deps: ClickUpDeps
): Promise<any> {
  ensureWritesEnabled(deps);
  ensureTeamIdWhenCustom(args);
  if (!args.confirm) {
    return {
      dryRun: true,
      action: "set_custom_field",
      taskId: args.taskId,
      fieldId: args.fieldId,
      value: args.value,
      note: DRY_RUN_NOTE
    };
  }
  var client = resolveClient(deps);
  await setCustomField({
    client: client,
    taskId: args.taskId,
    fieldId: args.fieldId,
    value: args.value,
    customTaskIds: args.customTaskIds,
    teamId: args.teamId
  });
  return { ok: true, action: "set_custom_field", taskId: args.taskId, fieldId: args.fieldId };
}

export async function clickupCreateTask(
  args: ClickupCreateTaskInput,
  deps: ClickUpDeps
): Promise<any> {
  ensureWritesEnabled(deps);
  if (!args.confirm) {
    return {
      dryRun: true,
      action: "create_task",
      listId: args.listId,
      name: args.name,
      fields: {
        markdownContent: args.markdownContent,
        status: args.status,
        priority: args.priority,
        assignees: args.assignees,
        customFields: args.customFields
      },
      note: DRY_RUN_NOTE
    };
  }
  var client = resolveClient(deps);
  var customFields = args.customFields
    ? args.customFields.map(function (cf) {
        return { id: cf.id, value: cf.value };
      })
    : undefined;
  return await createTask({
    client: client,
    listId: args.listId,
    name: args.name,
    markdownContent: args.markdownContent,
    status: args.status,
    priority: args.priority,
    assignees: args.assignees,
    customFields: customFields
  });
}

export async function clickupLinkTasks(
  args: ClickupLinkTasksInput,
  deps: ClickUpDeps
): Promise<any> {
  ensureWritesEnabled(deps);
  ensureTeamIdWhenCustom(args);
  if (!args.confirm) {
    return {
      dryRun: true,
      action: "link_tasks",
      taskId: args.taskId,
      linksTo: args.linksTo,
      note: DRY_RUN_NOTE
    };
  }
  var client = resolveClient(deps);
  await linkTask({
    client: client,
    taskId: args.taskId,
    linksTo: args.linksTo,
    customTaskIds: args.customTaskIds,
    teamId: args.teamId
  });
  return { ok: true, action: "link_tasks", taskId: args.taskId, linksTo: args.linksTo };
}
