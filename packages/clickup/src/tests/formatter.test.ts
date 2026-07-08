import {
  formatForClaude,
  formatTaskDetail,
  formatTaskSummary,
  formatTeamSync,
} from "../formatter";
import { makeClickUpTask, makeUser, makePipelineGroup } from "./fixtures";

describe("formatForClaude", function () {
  it("returns 'No tasks found' for empty array", function () {
    var result = formatForClaude({ tasks: [] });
    expect(result).toContain("No tasks found");
  });

  it("includes total count in header", function () {
    var tasks = [
      makeClickUpTask(),
      makeClickUpTask({ id: "task2", name: "Second Task" }),
    ];
    var result = formatForClaude({ tasks: tasks });
    expect(result).toContain("## ClickUp Tasks (2 total)");
  });

  it("groups tasks by status with section headers", function () {
    var tasks = [
      makeClickUpTask({
        status: {
          status: "in progress",
          color: "#000",
          type: "open",
          orderindex: 1,
        },
      }),
      makeClickUpTask({
        id: "task2",
        name: "Done Task",
        status: {
          status: "done",
          color: "#000",
          type: "closed",
          orderindex: 2,
        },
      }),
    ];
    var result = formatForClaude({ tasks: tasks });
    expect(result).toContain("### In progress (1)");
    expect(result).toContain("### Done (1)");
  });

  it("shows custom_id when present", function () {
    var task = makeClickUpTask({ custom_id: "TENON-42" });
    var result = formatForClaude({ tasks: [task] });
    expect(result).toContain("[TENON-42]");
  });

  it("falls back to id when custom_id is null", function () {
    var task = makeClickUpTask({ custom_id: null, id: "abc123" });
    var result = formatForClaude({ tasks: [task] });
    expect(result).toContain("[abc123]");
  });

  it("shows priority when present", function () {
    var task = makeClickUpTask({
      priority: { id: "2", priority: "high", color: "#f00", orderindex: "2" },
    });
    var result = formatForClaude({ tasks: [task] });
    expect(result).toContain("(Priority: High)");
  });

  it("shows assignee names", function () {
    var task = makeClickUpTask({
      assignees: [makeUser({ username: "daniel" })],
    });
    var result = formatForClaude({ tasks: [task] });
    expect(result).toContain("Assignees: daniel");
  });

  it("shows list name", function () {
    var task = makeClickUpTask({ list: { id: "l1", name: "Sprint 5" } });
    var result = formatForClaude({ tasks: [task] });
    expect(result).toContain("List: Sprint 5");
  });

  it("shows task URL", function () {
    var task = makeClickUpTask({ url: "https://app.clickup.com/t/task99" });
    var result = formatForClaude({ tasks: [task] });
    expect(result).toContain("URL: https://app.clickup.com/t/task99");
  });

  it("shows task name in bold", function () {
    var task = makeClickUpTask({ name: "Fix Login Bug" });
    var result = formatForClaude({ tasks: [task] });
    expect(result).toContain("**");
    expect(result).toContain("Fix Login Bug");
  });

  it("groups multiple tasks under same status", function () {
    var tasks = [
      makeClickUpTask({ id: "t1", name: "Task A" }),
      makeClickUpTask({ id: "t2", name: "Task B" }),
    ];
    var result = formatForClaude({ tasks: tasks });
    expect(result).toContain("### In progress (2)");
    expect(result).toContain("Task A");
    expect(result).toContain("Task B");
  });
});

describe("formatTaskDetail", function () {
  it("includes task name as header", function () {
    var task = makeClickUpTask({ name: "My Task" });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("## Task: My Task");
  });

  it("includes task ID", function () {
    var task = makeClickUpTask({ id: "xyz789" });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**ID:** xyz789");
  });

  it("includes status", function () {
    var task = makeClickUpTask({
      status: {
        status: "in review",
        color: "#000",
        type: "open",
        orderindex: 1,
      },
    });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**Status:** In review");
  });

  it("includes custom_id when present", function () {
    var task = makeClickUpTask({ custom_id: "TENON-100" });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**Custom ID:** TENON-100");
  });

  it("omits custom_id when null", function () {
    var task = makeClickUpTask({ custom_id: null });
    var result = formatTaskDetail({ task: task });
    expect(result).not.toContain("Custom ID");
  });

  it("includes priority when present", function () {
    var task = makeClickUpTask({
      priority: { id: "1", priority: "urgent", color: "#f00", orderindex: "1" },
    });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**Priority:** Urgent");
  });

  it("omits priority when null", function () {
    var task = makeClickUpTask({ priority: null });
    var result = formatTaskDetail({ task: task });
    expect(result).not.toContain("Priority");
  });

  it("shows assignees by username", function () {
    var task = makeClickUpTask({
      assignees: [
        makeUser({ username: "angel" }),
        makeUser({ id: 2, username: "trevor" }),
      ],
    });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**Assignees:** angel, trevor");
  });

  it("falls back to email when username is empty", function () {
    var task = makeClickUpTask({
      assignees: [makeUser({ username: "", email: "dev@tenon.com" })],
    });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("dev@tenon.com");
  });

  it("falls back to id when username and email are empty", function () {
    var task = makeClickUpTask({
      assignees: [makeUser({ username: "", email: "", id: 42 })],
    });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("42");
  });

  it("includes list and folder names", function () {
    var task = makeClickUpTask({
      list: { id: "l1", name: "Sprint List" },
      folder: { id: "f1", name: "Dev Folder" },
    });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**List:** Sprint List");
    expect(result).toContain("**Folder:** Dev Folder");
  });

  it("includes due date when present", function () {
    var task = makeClickUpTask({ due_date: "1704067200000" });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**Due:**");
  });

  it("omits due date when null", function () {
    var task = makeClickUpTask({ due_date: null });
    var result = formatTaskDetail({ task: task });
    expect(result).not.toContain("Due:");
  });

  it("includes tags when present", function () {
    var task = makeClickUpTask({
      tags: [
        { name: "bug", tag_fg: "#fff", tag_bg: "#f00" },
        { name: "urgent", tag_fg: "#fff", tag_bg: "#f00" },
      ],
    });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**Tags:** bug, urgent");
  });

  it("includes description section when present", function () {
    var task = makeClickUpTask({
      description: "Fix the login page redirect issue",
    });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("### Description");
    expect(result).toContain("Fix the login page redirect issue");
  });

  it("omits description section when empty", function () {
    var task = makeClickUpTask({ description: "" });
    var result = formatTaskDetail({ task: task });
    expect(result).not.toContain("### Description");
  });

  it("omits description section when whitespace-only", function () {
    var task = makeClickUpTask({ description: "   " });
    var result = formatTaskDetail({ task: task });
    expect(result).not.toContain("### Description");
  });

  it("includes created and updated timestamps", function () {
    var task = makeClickUpTask();
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**Created:**");
    expect(result).toContain("**Updated:**");
  });

  it("includes URL", function () {
    var task = makeClickUpTask({ url: "https://app.clickup.com/t/task1" });
    var result = formatTaskDetail({ task: task });
    expect(result).toContain("**URL:** https://app.clickup.com/t/task1");
  });
});

describe("formatTaskSummary", function () {
  it("returns just the name when no description", function () {
    var task = makeClickUpTask({ name: "Fix Bug", description: "" });
    var result = formatTaskSummary({ task: task });
    expect(result).toBe("Fix Bug");
  });

  it("returns just the name when description is whitespace-only", function () {
    var task = makeClickUpTask({ name: "Fix Bug", description: "   " });
    var result = formatTaskSummary({ task: task });
    expect(result).toBe("Fix Bug");
  });

  it("appends first sentence when description has early period", function () {
    var task = makeClickUpTask({
      name: "Fix Bug",
      description:
        "The login page redirects incorrectly. This affects all users.",
    });
    var result = formatTaskSummary({ task: task });
    expect(result).toBe("Fix Bug — The login page redirects incorrectly.");
  });

  it("truncates long descriptions to 147 chars + ellipsis", function () {
    var longDesc = "A".repeat(200);
    var task = makeClickUpTask({ name: "Fix Bug", description: longDesc });
    var result = formatTaskSummary({ task: task });
    expect(result).toContain("Fix Bug — ");
    expect(result).toContain("...");
    expect(result.length).toBeLessThanOrEqual("Fix Bug — ".length + 150);
  });

  it("appends full short description without period", function () {
    var task = makeClickUpTask({
      name: "Fix Bug",
      description: "Short desc no period",
    });
    var result = formatTaskSummary({ task: task });
    expect(result).toBe("Fix Bug — Short desc no period");
  });

  it("truncates when first period is beyond 150 chars", function () {
    var descNoPeriod = "A".repeat(160) + ".";
    var task = makeClickUpTask({ name: "Fix Bug", description: descNoPeriod });
    var result = formatTaskSummary({ task: task });
    expect(result).toContain("...");
  });
});

describe("formatTeamSync", function () {
  // Fixed reference time for deterministic tests
  var syncTime = new Date(2024, 0, 15, 10, 0, 0); // Jan 15, 2024 10:00 AM

  it("shows header with zero tasks when groups are empty", function () {
    var result = formatTeamSync({
      groups: [],
      unassigned: [],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 5,
    });
    expect(result).toContain("# ClickUp Task Sync");
    expect(result).toContain("Tasks: 0 active across 5 lists");
  });

  it("renders In Progress section with correct table format", function () {
    var task = makeClickUpTask({
      name: "Build Feature",
      assignees: [makeUser({ username: "angel" })],
      date_updated: String(syncTime.getTime() - 86400000), // 1 day ago
    });
    var result = formatTeamSync({
      groups: [makePipelineGroup("In Progress", [task])],
      unassigned: [],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 3,
    });
    expect(result).toContain("## In Progress");
    expect(result).toContain("| Task | Assignee | List | Updated | Link |");
    expect(result).toContain("Build Feature");
    expect(result).toContain("angel");
    expect(result).toContain("1d ago");
  });

  it("renders Blocked section with Days Stalled column", function () {
    var task = makeClickUpTask({
      name: "Blocked Task",
      assignees: [makeUser({ username: "trevor" })],
      date_updated: String(syncTime.getTime() - 3 * 86400000), // 3 days ago
    });
    var result = formatTeamSync({
      groups: [makePipelineGroup("Blocked", [task])],
      unassigned: [],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 2,
    });
    expect(result).toContain("## Blocked");
    expect(result).toContain(
      "| Task | Assignee | List | Days Stalled | Link |",
    );
    expect(result).toContain("3d");
  });

  it("shows 'today' for tasks updated today", function () {
    var task = makeClickUpTask({
      name: "Fresh Task",
      assignees: [makeUser({ username: "daniel" })],
      date_updated: String(syncTime.getTime()), // same time
    });
    var result = formatTeamSync({
      groups: [makePipelineGroup("In Progress", [task])],
      unassigned: [],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 1,
    });
    expect(result).toContain("today");
  });

  it("renders stages in correct order", function () {
    var blockedTask = makeClickUpTask({ id: "t1", name: "Blocked" });
    var inProgressTask = makeClickUpTask({ id: "t2", name: "Working" });
    var qaTask = makeClickUpTask({ id: "t3", name: "Testing" });

    var result = formatTeamSync({
      groups: [
        makePipelineGroup("QA", [qaTask]),
        makePipelineGroup("Blocked", [blockedTask]),
        makePipelineGroup("In Progress", [inProgressTask]),
      ],
      unassigned: [],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 1,
    });

    var blockedIdx = result.indexOf("## Blocked");
    var inProgressIdx = result.indexOf("## In Progress");
    var qaIdx = result.indexOf("## QA");

    expect(blockedIdx).toBeLessThan(inProgressIdx);
    expect(inProgressIdx).toBeLessThan(qaIdx);
  });

  it("skips Done and Unknown stages", function () {
    var doneTask = makeClickUpTask({ id: "t1", name: "Done Task" });
    var result = formatTeamSync({
      groups: [makePipelineGroup("Done", [doneTask])],
      unassigned: [],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 1,
    });
    expect(result).not.toContain("## Done");
  });

  it("renders unassigned section", function () {
    var task = makeClickUpTask({
      name: "Unassigned Task",
      assignees: [],
      priority: { id: "2", priority: "high", color: "#f00", orderindex: "2" },
    });
    var result = formatTeamSync({
      groups: [],
      unassigned: [task],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 1,
    });
    expect(result).toContain("## Unassigned");
    expect(result).toContain("Unassigned Task");
    expect(result).toContain("High");
  });

  it("renders developer summary table", function () {
    var task1 = makeClickUpTask({
      id: "t1",
      assignees: [makeUser({ username: "angel" })],
    });
    var task2 = makeClickUpTask({
      id: "t2",
      assignees: [makeUser({ username: "angel" })],
    });
    var task3 = makeClickUpTask({
      id: "t3",
      assignees: [makeUser({ username: "trevor" })],
    });

    var result = formatTeamSync({
      groups: [
        makePipelineGroup("In Progress", [task1, task2]),
        makePipelineGroup("QA", [task3]),
      ],
      unassigned: [],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 1,
    });
    expect(result).toContain("## Summary by Developer");
    expect(result).toContain("angel");
    expect(result).toContain("trevor");
  });

  it("renders unmapped statuses", function () {
    var result = formatTeamSync({
      groups: [],
      unassigned: [],
      unmappedStatuses: { "custom status": 3, "weird state": 1 },
      syncTime: syncTime,
      listCount: 1,
    });
    expect(result).toContain("## Unmapped Statuses");
    expect(result).toContain('"custom status" (3 tasks)');
    expect(result).toContain('"weird state" (1 tasks)');
  });

  it("counts total tasks including unassigned", function () {
    var task1 = makeClickUpTask({ id: "t1" });
    var task2 = makeClickUpTask({ id: "t2" });
    var result = formatTeamSync({
      groups: [makePipelineGroup("In Progress", [task1])],
      unassigned: [task2],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 2,
    });
    expect(result).toContain("Tasks: 2 active across 2 lists");
  });

  it("escapes pipe characters in task names", function () {
    var task = makeClickUpTask({ name: "Task | with pipe" });
    var result = formatTeamSync({
      groups: [makePipelineGroup("In Progress", [task])],
      unassigned: [],
      unmappedStatuses: {},
      syncTime: syncTime,
      listCount: 1,
    });
    expect(result).toContain("Task \\| with pipe");
  });
});
