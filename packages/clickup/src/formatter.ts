import {
  ClickUpTask,
  TasksByStatus,
  PipelineGroup,
  FormatForClaudeParams,
  FormatTaskDetailParams,
  FormatTaskSummaryParams,
  FormatTeamSyncParams,
} from "./types";

/**
 * @description Formats a list of tasks as markdown grouped by status, optimized for LLM consumption.
 * @param params - Object with tasks array.
 * @returns Markdown-formatted string.
 */
export function formatForClaude(params: FormatForClaudeParams): string {
  var tasks = params.tasks;

  if (tasks.length === 0) {
    return "## ClickUp Tasks\n\nNo tasks found.";
  }

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

  var lines: string[] = [];
  lines.push("## ClickUp Tasks (" + tasks.length + " total)");
  lines.push("");

  var statusNames = Object.keys(byStatus);
  for (var s = 0; s < statusNames.length; s++) {
    var status = statusNames[s];
    var statusTasks = byStatus[status];
    lines.push("### " + capitalize(status) + " (" + statusTasks.length + ")");
    lines.push("");

    for (var t = 0; t < statusTasks.length; t++) {
      var tsk = statusTasks[t];
      var idLabel = tsk.custom_id ? tsk.custom_id : tsk.id;
      var priorityLabel =
        tsk.priority && tsk.priority.priority
          ? " (Priority: " + capitalize(tsk.priority.priority) + ")"
          : "";

      lines.push("- **[" + idLabel + "] " + tsk.name + "**" + priorityLabel);

      var assigneeNames = getAssigneeNames(tsk);
      if (assigneeNames.length > 0) {
        lines.push("  Assignees: " + assigneeNames.join(", "));
      }

      if (tsk.list && tsk.list.name) {
        lines.push("  List: " + tsk.list.name);
      }

      if (tsk.url) {
        lines.push("  URL: " + tsk.url);
      }

      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * @description Formats a single task as a detailed markdown view.
 * @param params - Object with the task.
 * @returns Markdown-formatted string.
 */
export function formatTaskDetail(params: FormatTaskDetailParams): string {
  var task = params.task;
  var lines: string[] = [];

  lines.push("## Task: " + task.name);
  lines.push("");
  lines.push("- **ID:** " + task.id);

  if (task.custom_id) {
    lines.push("- **Custom ID:** " + task.custom_id);
  }

  var statusLabel =
    task.status && task.status.status
      ? capitalize(task.status.status)
      : "Unknown";
  lines.push("- **Status:** " + statusLabel);

  if (task.priority && task.priority.priority) {
    lines.push("- **Priority:** " + capitalize(task.priority.priority));
  }

  var assigneeNames = getAssigneeNames(task);
  if (assigneeNames.length > 0) {
    lines.push("- **Assignees:** " + assigneeNames.join(", "));
  }

  if (task.list && task.list.name) {
    lines.push("- **List:** " + task.list.name);
  }

  if (task.folder && task.folder.name) {
    lines.push("- **Folder:** " + task.folder.name);
  }

  if (task.due_date) {
    lines.push("- **Due:** " + formatTimestamp(task.due_date));
  }

  if (task.start_date) {
    lines.push("- **Start:** " + formatTimestamp(task.start_date));
  }

  lines.push("- **Created:** " + formatTimestamp(task.date_created));
  lines.push("- **Updated:** " + formatTimestamp(task.date_updated));

  if (task.url) {
    lines.push("- **URL:** " + task.url);
  }

  if (task.tags && task.tags.length > 0) {
    var tagNames = task.tags.map(function (tag) {
      return tag.name;
    });
    lines.push("- **Tags:** " + tagNames.join(", "));
  }

  if (task.description && task.description.trim() !== "") {
    lines.push("");
    lines.push("### Description");
    lines.push("");
    lines.push(task.description);
  }

  return lines.join("\n");
}

/**
 * @description Generates a brief one-line summary of a task, suitable for update set descriptions.
 * @param params - Object with the task.
 * @returns A concise summary string.
 */
export function formatTaskSummary(params: FormatTaskSummaryParams): string {
  var task = params.task;
  var summary = task.name;

  // Add a truncated description if available
  if (task.description && task.description.trim() !== "") {
    var desc = task.description.trim();
    // Take first sentence or first 150 chars
    var firstSentenceEnd = desc.indexOf(".");
    if (firstSentenceEnd > 0 && firstSentenceEnd < 150) {
      summary = summary + " — " + desc.substring(0, firstSentenceEnd + 1);
    } else if (desc.length > 150) {
      summary = summary + " — " + desc.substring(0, 147) + "...";
    } else {
      summary = summary + " — " + desc;
    }
  }

  return summary;
}

/**
 * @description Formats team task data as a structured markdown sync report for the CTO morning brief.
 * @param params - Object with pipeline groups, unassigned tasks, unmapped statuses, and sync metadata.
 * @returns Markdown-formatted string.
 */
export function formatTeamSync(params: FormatTeamSyncParams): string {
  var groups = params.groups;
  var unassigned = params.unassigned;
  var unmappedStatuses = params.unmappedStatuses;
  var syncTime = params.syncTime;
  var listCount = params.listCount;

  var totalTasks = 0;
  for (var g = 0; g < groups.length; g++) {
    totalTasks = totalTasks + groups[g].tasks.length;
  }
  totalTasks = totalTasks + unassigned.length;

  var lines: string[] = [];
  lines.push("# ClickUp Task Sync");
  lines.push("");
  lines.push("> Last synced: " + formatDate(syncTime));
  lines.push(
    "> Tasks: " + totalTasks + " active across " + listCount + " lists",
  );
  lines.push("");

  // Pipeline stage sections
  var stageOrder = [
    "Blocked",
    "In Progress",
    "In Review",
    "QA",
    "UAT",
    "Ready for Release",
  ];

  for (var so = 0; so < stageOrder.length; so++) {
    var stageName = stageOrder[so];
    var group = null;
    for (var fg = 0; fg < groups.length; fg++) {
      if (groups[fg].stage === stageName) {
        group = groups[fg];
        break;
      }
    }

    if (!group || group.tasks.length === 0) {
      continue;
    }

    lines.push("## " + stageName);
    lines.push("");

    // Sort by date_updated descending
    var sorted = group.tasks.slice().sort(function (a, b) {
      return parseInt(b.date_updated, 10) - parseInt(a.date_updated, 10);
    });

    if (stageName === "Blocked") {
      lines.push("| Task | Assignee | List | Days Stalled | Link |");
      lines.push("|---|---|---|---|---|");
      for (var bt = 0; bt < sorted.length; bt++) {
        var bTask = sorted[bt];
        lines.push(
          "| " +
            escapeCell(bTask.name) +
            " | " +
            getAssigneeNames(bTask).join(", ") +
            " | " +
            (bTask.list && bTask.list.name ? bTask.list.name : "-") +
            " | " +
            daysStalled(bTask.date_updated, syncTime) +
            " | [" +
            (bTask.custom_id || bTask.id) +
            "](" +
            bTask.url +
            ") |",
        );
      }
    } else {
      lines.push("| Task | Assignee | List | Updated | Link |");
      lines.push("|---|---|---|---|---|");
      for (var st = 0; st < sorted.length; st++) {
        var sTask = sorted[st];
        lines.push(
          "| " +
            escapeCell(sTask.name) +
            " | " +
            getAssigneeNames(sTask).join(", ") +
            " | " +
            (sTask.list && sTask.list.name ? sTask.list.name : "-") +
            " | " +
            relativeTime(sTask.date_updated, syncTime) +
            " | [" +
            (sTask.custom_id || sTask.id) +
            "](" +
            sTask.url +
            ") |",
        );
      }
    }

    lines.push("");
  }

  // Unassigned section
  if (unassigned.length > 0) {
    lines.push("## Unassigned");
    lines.push("");
    lines.push("| Task | Priority | List | Created | Link |");
    lines.push("|---|---|---|---|---|");

    for (var u = 0; u < unassigned.length; u++) {
      var uTask = unassigned[u];
      var priorityLabel =
        uTask.priority && uTask.priority.priority
          ? capitalize(uTask.priority.priority)
          : "-";
      lines.push(
        "| " +
          escapeCell(uTask.name) +
          " | " +
          priorityLabel +
          " | " +
          (uTask.list && uTask.list.name ? uTask.list.name : "-") +
          " | " +
          relativeTime(uTask.date_created, syncTime) +
          " | [" +
          (uTask.custom_id || uTask.id) +
          "](" +
          uTask.url +
          ") |",
      );
    }

    lines.push("");
  }

  // Developer summary table
  var devTotals: Record<string, Record<string, number>> = {};

  for (var dg = 0; dg < groups.length; dg++) {
    var dGroup = groups[dg];
    if (dGroup.stage === "Done" || dGroup.stage === "Unknown") {
      continue;
    }
    for (var dt = 0; dt < dGroup.tasks.length; dt++) {
      var dTask = dGroup.tasks[dt];
      var names = getAssigneeNames(dTask);
      if (names.length === 0) {
        continue;
      }
      for (var dn = 0; dn < names.length; dn++) {
        var devName = names[dn];
        if (!devTotals[devName]) {
          devTotals[devName] = {};
        }
        if (!devTotals[devName][dGroup.stage]) {
          devTotals[devName][dGroup.stage] = 0;
        }
        devTotals[devName][dGroup.stage] = devTotals[devName][dGroup.stage] + 1;
      }
    }
  }

  var devNames = Object.keys(devTotals).sort();
  if (devNames.length > 0) {
    lines.push("## Summary by Developer");
    lines.push("");
    lines.push(
      "| Developer | Blocked | In Progress | In Review | QA | UAT | Total |",
    );
    lines.push("|---|---|---|---|---|---|---|");

    for (var dvn = 0; dvn < devNames.length; dvn++) {
      var dev = devNames[dvn];
      var counts = devTotals[dev];
      var blocked = counts["Blocked"] || 0;
      var inProgress = counts["In Progress"] || 0;
      var inReview = counts["In Review"] || 0;
      var qa = counts["QA"] || 0;
      var uat = counts["UAT"] || 0;
      var total =
        blocked +
        inProgress +
        inReview +
        qa +
        uat +
        (counts["Ready for Release"] || 0);
      lines.push(
        "| " +
          dev +
          " | " +
          blocked +
          " | " +
          inProgress +
          " | " +
          inReview +
          " | " +
          qa +
          " | " +
          uat +
          " | " +
          total +
          " |",
      );
    }

    lines.push("");
  }

  // Unmapped statuses
  var unmappedKeys = Object.keys(unmappedStatuses);
  if (unmappedKeys.length > 0) {
    lines.push("## Unmapped Statuses");
    lines.push("");
    for (var uk = 0; uk < unmappedKeys.length; uk++) {
      var uStatus = unmappedKeys[uk];
      lines.push(
        '- "' +
          uStatus +
          '" (' +
          unmappedStatuses[uStatus] +
          " tasks) — add to STATUS_MAP in clickup-sync.ts",
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Helpers ---

function escapeCell(str: string): string {
  if (!str) {
    return "";
  }
  return str.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function daysStalled(updatedTs: string, now: Date): string {
  if (!updatedTs) {
    return "?";
  }
  var updated = new Date(parseInt(updatedTs, 10));
  var diffMs = now.getTime() - updated.getTime();
  var days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) {
    return "today";
  }
  return days + "d";
}

function relativeTime(ts: string, now: Date): string {
  if (!ts) {
    return "?";
  }
  var date = new Date(parseInt(ts, 10));
  var diffMs = now.getTime() - date.getTime();
  var days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) {
    return "today";
  }
  if (days === 1) {
    return "1d ago";
  }
  return days + "d ago";
}

function formatDate(date: Date): string {
  var months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  var hours = date.getHours();
  var ampm = hours >= 12 ? "PM" : "AM";
  var displayHours = hours % 12;
  if (displayHours === 0) {
    displayHours = 12;
  }
  var minutes = date.getMinutes();
  var minStr = minutes < 10 ? "0" + minutes : String(minutes);
  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0") +
    " " +
    displayHours +
    ":" +
    minStr +
    " " +
    ampm
  );
}

function getAssigneeNames(task: ClickUpTask): string[] {
  if (!task.assignees || task.assignees.length === 0) {
    return [];
  }
  return task.assignees.map(function (assignee) {
    return assignee.username || assignee.email || String(assignee.id);
  });
}

function formatTimestamp(ts: string): string {
  if (!ts) {
    return "Unknown";
  }
  try {
    // ClickUp returns timestamps as Unix milliseconds
    var date = new Date(parseInt(ts, 10));
    if (isNaN(date.getTime())) {
      return ts;
    }
    return date.toLocaleDateString() + " " + date.toLocaleTimeString();
  } catch (e) {
    return ts;
  }
}

function capitalize(str: string): string {
  if (!str || str.length === 0) {
    return str;
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}
