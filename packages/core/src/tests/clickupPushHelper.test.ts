// --- Mock setup (must be before imports) ---

var mockApi = {
  getTask: jest.fn(),
};

jest.mock("@tenonhq/dovetail-clickup", function () {
  return {
    createClickUpApi: jest.fn(function () {
      return mockApi;
    }),
    parseClickUpIdentifier: jest.fn(function (input: string) {
      return { taskId: input.replace(/.*\/t\//, ""), raw: input };
    }),
  };
});

jest.mock("../clickupCommands", function () {
  return {
    refineUpdateSetName: jest.fn(function (params: any) {
      return "Refined: " + params.taskName;
    }),
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

jest.mock("chalk", function () {
  var identity: any = function (s: any) {
    return s;
  };
  identity.green = identity;
  return {
    default: identity,
    green: identity,
  };
});

// --- Imports (after mocks) ---

import { resolveClickUpForPush } from "../clickupPushHelper";
import {
  parseClickUpIdentifier,
  createClickUpApi,
} from "@tenonhq/dovetail-clickup";
import { refineUpdateSetName } from "../clickupCommands";

// --- Tests ---

describe("resolveClickUpForPush", function () {
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

  it("throws when CLICKUP_API_TOKEN is not set", async function () {
    delete process.env.CLICKUP_API_TOKEN;

    await expect(resolveClickUpForPush("abc123")).rejects.toThrow(
      "CLICKUP_API_TOKEN not set",
    );
  });

  it("throws when CLICKUP_API_TOKEN is empty", async function () {
    process.env.CLICKUP_API_TOKEN = "";

    await expect(resolveClickUpForPush("abc123")).rejects.toThrow(
      "CLICKUP_API_TOKEN not set",
    );
  });

  it("resolves task and returns refined update set name", async function () {
    mockApi.getTask.mockResolvedValue({
      id: "abc123",
      name: "Fix Login Bug",
      description: "Login page has redirect issue",
    });

    var result = await resolveClickUpForPush("abc123");

    expect(parseClickUpIdentifier).toHaveBeenCalledWith("abc123");
    expect(createClickUpApi).toHaveBeenCalledWith({ token: "pk_test_token" });
    expect(mockApi.getTask).toHaveBeenCalled();
    expect(refineUpdateSetName).toHaveBeenCalledWith({
      taskName: "Fix Login Bug",
      taskId: "abc123",
      taskDescription: "Login page has redirect issue",
    });
    expect(result).toBe("Refined: Fix Login Bug");
  });

  it("passes empty string for description when task has no description", async function () {
    mockApi.getTask.mockResolvedValue({
      id: "abc123",
      name: "No Desc Task",
      description: "",
    });

    await resolveClickUpForPush("abc123");

    expect(refineUpdateSetName).toHaveBeenCalledWith(
      expect.objectContaining({
        taskDescription: "",
      }),
    );
  });

  it("passes empty string when description is undefined", async function () {
    mockApi.getTask.mockResolvedValue({
      id: "abc123",
      name: "Undefined Desc",
      description: undefined,
    });

    await resolveClickUpForPush("abc123");

    expect(refineUpdateSetName).toHaveBeenCalledWith(
      expect.objectContaining({
        taskDescription: "",
      }),
    );
  });

  it("propagates API errors", async function () {
    mockApi.getTask.mockRejectedValue(new Error("Task not found"));

    await expect(resolveClickUpForPush("missing123")).rejects.toThrow(
      "Task not found",
    );
  });

  it("works with ClickUp URL input", async function () {
    mockApi.getTask.mockResolvedValue({
      id: "86a3bx7wz",
      name: "URL Task",
      description: "From URL",
    });

    // The mock parseClickUpIdentifier strips the URL prefix
    await resolveClickUpForPush("https://app.clickup.com/t/86a3bx7wz");

    expect(parseClickUpIdentifier).toHaveBeenCalledWith(
      "https://app.clickup.com/t/86a3bx7wz",
    );
  });
});
