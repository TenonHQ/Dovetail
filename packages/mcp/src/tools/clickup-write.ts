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
  linkTask,
  createGoal,
  updateGoal,
  createKeyResult,
  editKeyResult
} from "@tenonhq/dovetail-clickup";
import type { ClickUpGoal, ClickUpKeyResult } from "@tenonhq/dovetail-clickup";
import { ClickUpDeps, resolveClient, requireTeamId } from "./clickup";
import {
  ClickupUpdateTaskInput,
  ClickupSetCustomFieldInput,
  ClickupCreateTaskInput,
  ClickupLinkTasksInput,
  ClickupCreateGoalInput,
  ClickupUpdateGoalInput,
  ClickupCreateKeyResultInput,
  ClickupEditKeyResultInput
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

// --- Goals + Key Results ---

interface DryRunPreview {
  dryRun: true;
  action: string;
  note: string;
  [key: string]: unknown;
}

// "YYYY-MM-DD" → epoch ms at the end of that day (UTC), the shape ClickUp wants.
function toDueDateMs(dueDate: string): number {
  var ms = Date.parse(dueDate + "T23:59:59Z");
  if (isNaN(ms)) {
    throw new Error("dueDate '" + dueDate + "' is not a real calendar date.");
  }
  return ms;
}

/**
 * Cross-field rules for a key result, enforced here because the MCP SDK
 * consumes the raw schema shape (no zod refinements). Returns the steps to send.
 */
function resolveKeyResultSteps(args: ClickupCreateKeyResultInput): { start: number; end: number } {
  if (args.type === "boolean") {
    // A boolean target is done/not-done: ClickUp models it as 0 → 1.
    return { start: 0, end: 1 };
  }
  if (args.type === "automatic") {
    var hasTasks = !!args.taskIds && args.taskIds.length > 0;
    var hasLists = !!args.listIds && args.listIds.length > 0;
    if (!hasTasks && !hasLists) {
      throw new Error("An automatic key result needs at least one taskIds or listIds entry.");
    }
  }
  if (args.stepsStart === args.stepsEnd) {
    throw new Error("stepsStart and stepsEnd must differ (a key result needs a range to progress through).");
  }
  return { start: args.stepsStart, end: args.stepsEnd };
}

export async function clickupCreateGoal(
  args: ClickupCreateGoalInput,
  deps: ClickUpDeps
): Promise<ClickUpGoal | DryRunPreview> {
  ensureWritesEnabled(deps);
  var teamId = requireTeamId(deps, args.teamId);
  var dueDateMs = toDueDateMs(args.dueDate);
  if (!args.confirm) {
    return {
      dryRun: true,
      action: "create_goal",
      teamId: teamId,
      name: args.name,
      fields: {
        dueDate: args.dueDate,
        description: args.description,
        owners: args.owners,
        color: args.color
      },
      note: DRY_RUN_NOTE
    };
  }
  var client = resolveClient(deps);
  return await createGoal({
    client: client,
    teamId: teamId,
    name: args.name,
    dueDate: dueDateMs,
    description: args.description,
    owners: args.owners,
    color: args.color
  });
}

export async function clickupUpdateGoal(
  args: ClickupUpdateGoalInput,
  deps: ClickUpDeps
): Promise<ClickUpGoal | DryRunPreview> {
  ensureWritesEnabled(deps);
  var dueDateMs = args.dueDate !== undefined ? toDueDateMs(args.dueDate) : undefined;
  if (!args.confirm) {
    return {
      dryRun: true,
      action: "update_goal",
      goalId: args.goalId,
      changes: {
        name: args.name,
        dueDate: args.dueDate,
        description: args.description,
        addOwners: args.addOwners,
        remOwners: args.remOwners,
        color: args.color
      },
      note: DRY_RUN_NOTE
    };
  }
  var client = resolveClient(deps);
  return await updateGoal({
    client: client,
    goalId: args.goalId,
    name: args.name,
    dueDate: dueDateMs,
    description: args.description,
    addOwners: args.addOwners,
    remOwners: args.remOwners,
    color: args.color
  });
}

export async function clickupCreateKeyResult(
  args: ClickupCreateKeyResultInput,
  deps: ClickUpDeps
): Promise<ClickUpKeyResult | DryRunPreview> {
  ensureWritesEnabled(deps);
  var steps = resolveKeyResultSteps(args);
  if (!args.confirm) {
    return {
      dryRun: true,
      action: "create_key_result",
      goalId: args.goalId,
      name: args.name,
      fields: {
        type: args.type,
        stepsStart: steps.start,
        stepsEnd: steps.end,
        unit: args.unit,
        owners: args.owners,
        taskIds: args.taskIds,
        listIds: args.listIds
      },
      note: DRY_RUN_NOTE
    };
  }
  var client = resolveClient(deps);
  return await createKeyResult({
    client: client,
    goalId: args.goalId,
    name: args.name,
    type: args.type,
    stepsStart: steps.start,
    stepsEnd: steps.end,
    unit: args.unit,
    owners: args.owners,
    taskIds: args.taskIds,
    listIds: args.listIds
  });
}

export async function clickupEditKeyResult(
  args: ClickupEditKeyResultInput,
  deps: ClickUpDeps
): Promise<ClickUpKeyResult | DryRunPreview> {
  ensureWritesEnabled(deps);
  var note = args.note.trim();
  if (!note) {
    throw new Error("note is required — record the period and the evidence link.");
  }
  if (!args.confirm) {
    return {
      dryRun: true,
      action: "edit_key_result",
      keyResultId: args.keyResultId,
      stepsCurrent: args.stepsCurrent,
      progressNote: note,
      note: DRY_RUN_NOTE
    };
  }
  var client = resolveClient(deps);
  return await editKeyResult({
    client: client,
    keyResultId: args.keyResultId,
    stepsCurrent: args.stepsCurrent,
    note: note
  });
}
