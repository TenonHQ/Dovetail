import { taskClearCommand } from "../commands";
import * as fs from "fs";
import * as path from "path";

// Mock logger
var logMessages: { level: string; msg: string }[] = [];
jest.mock("../Logger", function () {
  return {
    logger: {
      setLogLevel: jest.fn(),
      success: jest.fn(function (msg: string) {
        logMessages.push({ level: "success", msg: msg });
      }),
      info: jest.fn(function (msg: string) {
        logMessages.push({ level: "info", msg: msg });
      }),
      error: jest.fn(function (msg: string) {
        logMessages.push({ level: "error", msg: msg });
      }),
      warn: jest.fn(function (msg: string) {
        logMessages.push({ level: "warn", msg: msg });
      }),
      debug: jest.fn(),
      getInternalLogger: jest.fn(function () {
        return { error: jest.fn() };
      }),
    },
  };
});

// Mock fs
jest.mock("fs");
var mockFs = fs as jest.Mocked<typeof fs>;

// Mock other imports to prevent side effects
jest.mock("../config", function () {
  return {
    getConfig: jest.fn(function () { return {}; }),
    loadConfigs: jest.fn(),
  };
});
jest.mock("../appUtils", function () { return {}; });
jest.mock("../snClient", function () {
  return {
    defaultClient: jest.fn(),
    unwrapSNResponse: jest.fn(),
  };
});
jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn() } };
});
jest.mock("../logMessages", function () {
  return {
    logPushResults: jest.fn(),
    logBuildResults: jest.fn(),
  };
});
jest.mock("../gitUtils", function () {
  return { gitDiffToEncodedPaths: jest.fn() };
});
jest.mock("../FileUtils", function () {
  return { encodedPathsToFilePaths: jest.fn() };
});
jest.mock("inquirer", function () {
  return { prompt: jest.fn() };
});

describe("taskClearCommand", function () {
  var taskPath: string;
  var defaultArgs = { logLevel: "info" };

  beforeEach(function () {
    logMessages = [];
    taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
    jest.clearAllMocks();
  });

  it("should remove .dove-active-task.json when it exists", async function () {
    var taskData = JSON.stringify({
      taskId: "abc123",
      taskName: "My Test Task",
      updateSetName: "CU-abc123",
    });

    mockFs.existsSync.mockImplementation(function (p) {
      return p === taskPath;
    });
    mockFs.readFileSync.mockImplementation(function (p) {
      if (p === taskPath) return taskData as any;
      throw new Error("file not found");
    });
    mockFs.unlinkSync.mockImplementation(function () {});

    await taskClearCommand(defaultArgs as any);

    expect(mockFs.unlinkSync).toHaveBeenCalledWith(taskPath);
    expect(logMessages.some(function (m) {
      return m.level === "success" && m.msg.indexOf("My Test Task") !== -1;
    })).toBe(true);
  });

  it("should show informational message when no active task exists", async function () {
    mockFs.existsSync.mockReturnValue(false as any);

    await taskClearCommand(defaultArgs as any);

    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    expect(logMessages.some(function (m) {
      return m.level === "info" && m.msg.indexOf("No active task") !== -1;
    })).toBe(true);
  });

  it("should still remove file even if JSON is invalid", async function () {
    mockFs.existsSync.mockImplementation(function (p) {
      return p === taskPath;
    });
    mockFs.readFileSync.mockImplementation(function () {
      return "not valid json" as any;
    });
    mockFs.unlinkSync.mockImplementation(function () {});

    await taskClearCommand(defaultArgs as any);

    expect(mockFs.unlinkSync).toHaveBeenCalledWith(taskPath);
    expect(logMessages.some(function (m) {
      return m.level === "success" && m.msg.indexOf("removed") !== -1;
    })).toBe(true);
  });

  it("should use taskId as fallback when taskName is missing", async function () {
    var taskData = JSON.stringify({
      taskId: "def456",
      updateSetName: "CU-def456",
    });

    mockFs.existsSync.mockImplementation(function (p) {
      return p === taskPath;
    });
    mockFs.readFileSync.mockImplementation(function (p) {
      if (p === taskPath) return taskData as any;
      throw new Error("file not found");
    });
    mockFs.unlinkSync.mockImplementation(function () {});

    await taskClearCommand(defaultArgs as any);

    expect(mockFs.unlinkSync).toHaveBeenCalledWith(taskPath);
    expect(logMessages.some(function (m) {
      return m.level === "success" && m.msg.indexOf("def456") !== -1;
    })).toBe(true);
  });
});
