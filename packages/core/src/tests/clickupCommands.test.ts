// --- Mock setup (must be before imports) ---

var mockApi = {
  getAuthorizedUser: jest.fn(),
  getTask: jest.fn(),
  listMyTasks: jest.fn(),
  listTeamTasks: jest.fn(),
  createTask: jest.fn(),
  updateTask: jest.fn(),
  updateTaskStatus: jest.fn(),
  deleteTask: jest.fn(),
  addComment: jest.fn(),
  getTeams: jest.fn(),
  getSpaces: jest.fn(),
  getFolders: jest.fn(),
  getLists: jest.fn(),
  getSpaceLists: jest.fn(),
  getListTasks: jest.fn(),
};

jest.mock("@tenonhq/dovetail-clickup", function () {
  return {
    createClickUpApi: jest.fn(function () {
      return mockApi;
    }),
    parseClickUpIdentifier: jest.fn(function (input: string) {
      return { taskId: input, raw: input };
    }),
    formatForClaude: jest.fn(function () {
      return "## Formatted tasks";
    }),
    formatTaskDetail: jest.fn(function () {
      return "## Task detail";
    }),
    formatTaskSummary: jest.fn(function () {
      return "Task summary";
    }),
  };
});

jest.mock("inquirer", function () {
  return {
    default: {
      prompt: jest.fn(),
    },
    prompt: jest.fn(),
  };
});

jest.mock("../Logger", function () {
  return {
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      success: jest.fn(),
    },
  };
});

jest.mock("../commands", function () {
  return {
    setLogLevel: jest.fn(),
  };
});

jest.mock("chalk", function () {
  var identity: any = function (s: any) {
    return s;
  };
  identity.green = identity;
  identity.bold = identity;
  return {
    default: identity,
    green: identity,
    bold: identity,
  };
});

jest.mock("fs", function () {
  var actual = jest.requireActual("fs");
  return Object.assign({}, actual, {
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    existsSync: jest.fn(),
    promises: actual.promises,
  });
});
jest.mock("child_process");

// --- Imports (after mocks) ---

import {
  refineUpdateSetName,
  clickupTaskCommand,
  clickupTasksCommand,
  clickupCommentCommand,
  clickupTeamsCommand,
} from "../clickupCommands";
import {
  createClickUpApi,
  parseClickUpIdentifier,
  formatForClaude,
  formatTaskDetail,
} from "@tenonhq/dovetail-clickup";
import inquirer from "inquirer";
import { logger } from "../Logger";

// --- Tests ---

describe("refineUpdateSetName", function () {
  var execSync: jest.Mock;

  beforeEach(function () {
    jest.clearAllMocks();
    execSync = require("child_process").execSync as jest.Mock;
  });

  it("returns Claude CLI result when valid and under 100 chars", function () {
    execSync.mockReturnValue("  Fix Login Redirect Issue  \n");

    var result = refineUpdateSetName({
      taskName: "Fix login redirect",
      taskId: "abc123",
      taskDescription: "Users are redirected to wrong page",
    });

    expect(result).toBe("Fix Login Redirect Issue");
  });

  it("falls back to cleaned task name when Claude CLI returns empty", function () {
    execSync.mockReturnValue("  \n");

    var result = refineUpdateSetName({
      taskName: "Fix Bug #42",
      taskId: "abc123",
      taskDescription: "Something broke",
    });

    expect(result).toBe("Fix Bug 42");
  });

  it("falls back when Claude CLI returns string over 100 chars", function () {
    execSync.mockReturnValue("A".repeat(101));

    var result = refineUpdateSetName({
      taskName: "Short Name",
      taskId: "abc123",
      taskDescription: "",
    });

    expect(result).toBe("Short Name");
  });

  it("falls back when Claude CLI throws (not installed)", function () {
    execSync.mockImplementation(function () {
      throw new Error("command not found: claude");
    });

    var result = refineUpdateSetName({
      taskName: "Fix Bug",
      taskId: "abc123",
      taskDescription: "",
    });

    expect(result).toBe("Fix Bug");
  });

  it("falls back when Claude CLI times out", function () {
    execSync.mockImplementation(function () {
      var err = new Error("ETIMEDOUT") as any;
      err.killed = true;
      throw err;
    });

    var result = refineUpdateSetName({
      taskName: "Timeout Task",
      taskId: "abc123",
      taskDescription: "",
    });

    expect(result).toBe("Timeout Task");
  });

  it("strips special characters in fallback", function () {
    execSync.mockImplementation(function () {
      throw new Error("not available");
    });

    var result = refineUpdateSetName({
      taskName: "Fix: Bug #123 (urgent!)",
      taskId: "abc123",
      taskDescription: "",
    });

    expect(result).toBe("Fix Bug 123 urgent");
  });

  it("truncates fallback to 80 characters", function () {
    execSync.mockImplementation(function () {
      throw new Error("not available");
    });

    var longName = "A".repeat(100);
    var result = refineUpdateSetName({
      taskName: longName,
      taskId: "abc123",
      taskDescription: "",
    });

    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("sanitizes quotes and backslashes from input before passing to CLI", function () {
    execSync.mockReturnValue("Clean Name");

    refineUpdateSetName({
      taskName: "Fix 'quotes' and \"double\" and \\backslash",
      taskId: "abc123",
      taskDescription: "Desc with 'quotes' and \\slashes",
    });

    var callArgs = execSync.mock.calls[0][0];
    expect(callArgs).not.toContain("'quotes'");
    expect(callArgs).not.toContain("\\backslash");
  });
});

describe("clickupTaskCommand", function () {
  var originalEnv: string | undefined;

  beforeEach(function () {
    jest.clearAllMocks();
    originalEnv = process.env.CLICKUP_API_TOKEN;
    process.env.CLICKUP_API_TOKEN = "pk_test_token";
  });

  afterEach(function () {
    if (originalEnv !== undefined) {
      process.env.CLICKUP_API_TOKEN = originalEnv;
    } else {
      delete process.env.CLICKUP_API_TOKEN;
    }
  });

  it("fetches and formats a task on happy path", async function () {
    var mockTask = { id: "t1", name: "Test Task" };
    mockApi.getTask.mockResolvedValue(mockTask);

    var consoleSpy = jest.spyOn(console, "log").mockImplementation();

    await clickupTaskCommand({ id: "t1", logLevel: "info" });

    expect(parseClickUpIdentifier).toHaveBeenCalledWith("t1");
    expect(mockApi.getTask).toHaveBeenCalledWith({ taskId: "t1" });
    expect(formatTaskDetail).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith("## Task detail");

    consoleSpy.mockRestore();
  });

  it("throws when CLICKUP_API_TOKEN is missing", async function () {
    delete process.env.CLICKUP_API_TOKEN;

    await expect(
      clickupTaskCommand({ id: "t1", logLevel: "info" }),
    ).rejects.toThrow("CLICKUP_API_TOKEN not set");
  });

  it("logs and re-throws API errors", async function () {
    mockApi.getTask.mockRejectedValue(new Error("API down"));

    await expect(
      clickupTaskCommand({ id: "t1", logLevel: "info" }),
    ).rejects.toThrow("API down");
    expect(logger.error).toHaveBeenCalledWith("Failed to get task");
  });
});

describe("clickupTasksCommand", function () {
  var originalEnv: string | undefined;

  beforeEach(function () {
    jest.clearAllMocks();
    originalEnv = process.env.CLICKUP_API_TOKEN;
    process.env.CLICKUP_API_TOKEN = "pk_test_token";
    // Auto-resolve team (single team)
    mockApi.getTeams.mockResolvedValue([{ id: "team1", name: "Tenon" }]);
  });

  afterEach(function () {
    if (originalEnv !== undefined) {
      process.env.CLICKUP_API_TOKEN = originalEnv;
    } else {
      delete process.env.CLICKUP_API_TOKEN;
    }
  });

  it("formats and outputs tasks on happy path", async function () {
    mockApi.listMyTasks.mockResolvedValue({
      tasks: [{ id: "t1", name: "Task" }],
      byStatus: { "in progress": [{ id: "t1" }] },
      total: 1,
    });

    var consoleSpy = jest.spyOn(console, "log").mockImplementation();

    await clickupTasksCommand({ logLevel: "info" });

    expect(mockApi.listMyTasks).toHaveBeenCalled();
    expect(formatForClaude).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith("## Formatted tasks");

    consoleSpy.mockRestore();
  });

  it("logs message when no tasks found", async function () {
    mockApi.listMyTasks.mockResolvedValue({
      tasks: [],
      byStatus: {},
      total: 0,
    });

    await clickupTasksCommand({ logLevel: "info" });

    expect(logger.info).toHaveBeenCalledWith("No tasks assigned to you.");
  });

  it("uses explicit --team flag when provided", async function () {
    mockApi.listMyTasks.mockResolvedValue({
      tasks: [],
      byStatus: {},
      total: 0,
    });

    await clickupTasksCommand({ team: "explicit-team", logLevel: "info" });

    expect(mockApi.listMyTasks).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "explicit-team" }),
    );
    // Should NOT call getTeams when --team is provided
    expect(mockApi.getTeams).not.toHaveBeenCalled();
  });

  it("passes status filter from args", async function () {
    mockApi.listMyTasks.mockResolvedValue({
      tasks: [],
      byStatus: {},
      total: 0,
    });

    await clickupTasksCommand({
      logLevel: "info",
      status: ["in progress", "blocked"],
    });

    expect(mockApi.listMyTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["in progress", "blocked"],
      }),
    );
  });
});

describe("clickupCommentCommand", function () {
  var originalEnv: string | undefined;

  beforeEach(function () {
    jest.clearAllMocks();
    originalEnv = process.env.CLICKUP_API_TOKEN;
    process.env.CLICKUP_API_TOKEN = "pk_test_token";
  });

  afterEach(function () {
    if (originalEnv !== undefined) {
      process.env.CLICKUP_API_TOKEN = originalEnv;
    } else {
      delete process.env.CLICKUP_API_TOKEN;
    }
  });

  it("adds comment to task", async function () {
    mockApi.addComment.mockResolvedValue({});

    await clickupCommentCommand({
      taskId: "t1",
      msg: "Hello!",
      logLevel: "info",
    });

    expect(mockApi.addComment).toHaveBeenCalledWith({
      taskId: "t1",
      commentText: "Hello!",
    });
  });

  it("throws when message is empty", async function () {
    await expect(
      clickupCommentCommand({ taskId: "t1", msg: "", logLevel: "info" }),
    ).rejects.toThrow("Comment message is required");
  });

  it("throws when message is whitespace-only", async function () {
    await expect(
      clickupCommentCommand({ taskId: "t1", msg: "   ", logLevel: "info" }),
    ).rejects.toThrow("Comment message is required");
  });
});

describe("clickupTeamsCommand", function () {
  var originalEnv: string | undefined;

  beforeEach(function () {
    jest.clearAllMocks();
    originalEnv = process.env.CLICKUP_API_TOKEN;
    process.env.CLICKUP_API_TOKEN = "pk_test_token";
  });

  afterEach(function () {
    if (originalEnv !== undefined) {
      process.env.CLICKUP_API_TOKEN = originalEnv;
    } else {
      delete process.env.CLICKUP_API_TOKEN;
    }
  });

  it("lists teams with member counts", async function () {
    mockApi.getTeams.mockResolvedValue([
      { id: "t1", name: "Tenon", members: [{ user: {} }, { user: {} }] },
    ]);

    var consoleSpy = jest.spyOn(console, "log").mockImplementation();

    await clickupTeamsCommand({ logLevel: "info" });

    expect(mockApi.getTeams).toHaveBeenCalled();
    var output = consoleSpy.mock.calls
      .map(function (c) {
        return c[0];
      })
      .join("\n");
    expect(output).toContain("Tenon");
    expect(output).toContain("2 members");

    consoleSpy.mockRestore();
  });

  it("logs message when no teams found", async function () {
    mockApi.getTeams.mockResolvedValue([]);

    await clickupTeamsCommand({ logLevel: "info" });

    expect(logger.info).toHaveBeenCalledWith(
      "No workspaces found for this token.",
    );
  });
});

describe("getClickUpToken (via commands)", function () {
  var originalEnv: string | undefined;

  beforeEach(function () {
    originalEnv = process.env.CLICKUP_API_TOKEN;
  });

  afterEach(function () {
    if (originalEnv !== undefined) {
      process.env.CLICKUP_API_TOKEN = originalEnv;
    } else {
      delete process.env.CLICKUP_API_TOKEN;
    }
  });

  it("throws when CLICKUP_API_TOKEN is empty string", async function () {
    process.env.CLICKUP_API_TOKEN = "";

    await expect(
      clickupTaskCommand({ id: "t1", logLevel: "info" }),
    ).rejects.toThrow("CLICKUP_API_TOKEN not set");
  });

  it("throws when CLICKUP_API_TOKEN is undefined", async function () {
    delete process.env.CLICKUP_API_TOKEN;

    await expect(
      clickupTaskCommand({ id: "t1", logLevel: "info" }),
    ).rejects.toThrow("CLICKUP_API_TOKEN not set");
  });
});

describe("resolveTeamId (tested via clickupTasksCommand)", function () {
  var originalEnv: string | undefined;

  beforeEach(function () {
    jest.clearAllMocks();
    originalEnv = process.env.CLICKUP_API_TOKEN;
    process.env.CLICKUP_API_TOKEN = "pk_test_token";
  });

  afterEach(function () {
    if (originalEnv !== undefined) {
      process.env.CLICKUP_API_TOKEN = originalEnv;
    } else {
      delete process.env.CLICKUP_API_TOKEN;
    }
  });

  it("auto-selects when only one team exists", async function () {
    mockApi.getTeams.mockResolvedValue([{ id: "solo-team", name: "Solo" }]);
    mockApi.listMyTasks.mockResolvedValue({
      tasks: [],
      byStatus: {},
      total: 0,
    });

    await clickupTasksCommand({ logLevel: "info" });

    expect(mockApi.listMyTasks).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "solo-team" }),
    );
  });

  it("throws when no teams found", async function () {
    mockApi.getTeams.mockResolvedValue([]);

    await expect(clickupTasksCommand({ logLevel: "info" })).rejects.toThrow(
      "No ClickUp workspaces found",
    );
  });
});
