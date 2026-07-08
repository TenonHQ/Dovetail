/**
 * Tests for US-012: Add staleness warning for active task
 *
 * Validates:
 * - On startup, if .dove-active-task.json is older than 7 days, a warning is logged
 * - Fresh task files produce no warning
 * - Warning includes task name and age in days
 */

// --- Mock setup ---

const mockSNClient = {
  getScopeId: jest.fn(),
  getUserSysId: jest.fn(),
  getCurrentAppUserPrefSysId: jest.fn(),
  updateCurrentAppUserPref: jest.fn(),
  createCurrentAppUserPref: jest.fn(),
  changeScope: jest.fn().mockResolvedValue(undefined),
  createUpdateSet: jest.fn(),
  changeUpdateSet: jest.fn(),
  getCurrentUpdateSet: jest.fn(),
  client: {
    get: jest.fn(),
  },
};

jest.mock("../snClient", () => ({
  defaultClient: jest.fn(() => mockSNClient),
  unwrapSNResponse: jest.fn((val: any) => val),
}));

jest.mock("../FileUtils", () => ({
  getFileContextFromPath: jest.fn(),
  getFileContextWithSkipReason: jest.fn(),
}));

jest.mock("../appUtils", () => ({
  groupAppFiles: jest.fn(),
  pushFiles: jest.fn(),
}));

jest.mock("../logMessages", () => ({
  logFilePush: jest.fn(),
}));

jest.mock("../recentEdits", () => ({
  writeRecentEdit: jest.fn(),
}));

jest.mock("../Logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
    getLogLevel: jest.fn().mockReturnValue("info"),
  },
}));

jest.mock("../config", () => ({
  loadConfigs: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn(),
  getRootDir: jest.fn().mockReturnValue("/project"),
  updateManifest: jest.fn(),
  getManifest: jest.fn(),
  getSourcePath: jest.fn().mockReturnValue("/project/src"),
  getScopeManifestPath: jest.fn(
    (scope: string) => `/project/dove.manifest.${scope}.json`,
  ),
  getManifestPath: jest.fn().mockReturnValue("/project/dove.manifest.json"),
}));

// Filesystem mock store
var mockFsStore: Record<string, string> = {};
var mockFsStatStore: Record<string, { mtimeMs: number }> = {};

jest.mock("fs", () => ({
  existsSync: jest.fn((p: string) => {
    return p in mockFsStore;
  }),
  readFileSync: jest.fn((p: string) => {
    if (p in mockFsStore) return mockFsStore[p];
    throw new Error("ENOENT: " + p);
  }),
  writeFileSync: jest.fn((p: string, data: string) => {
    mockFsStore[p] = data;
  }),
  statSync: jest.fn((p: string) => {
    if (p in mockFsStatStore) return mockFsStatStore[p];
    return { mtimeMs: Date.now() };
  }),
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn(),
    mkdir: jest.fn(),
    access: jest.fn(),
    stat: jest.fn(),
  },
}));

jest.mock("chokidar", () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    close: jest.fn(),
  })),
}));

jest.mock("lodash", () => {
  var actual = jest.requireActual("lodash");
  return {
    ...actual,
    debounce: jest.fn((fn: Function) => {
      var wrapper = jest.fn();
      (wrapper as any).cancel = jest.fn();
      (wrapper as any).flush = jest.fn(() => fn());
      return wrapper;
    }),
  };
});

jest.mock("axios", () => ({
  default: {
    create: jest.fn(() => ({
      get: jest.fn().mockResolvedValue({ data: { result: null } }),
    })),
  },
}));

// --- Imports ---
import { logger } from "../Logger";
import { multiScopeWatcher } from "../MultiScopeWatcher";
import * as path from "path";

// --- Tests ---

describe("US-012: Add staleness warning for active task", () => {
  var taskPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFsStore = {};
    mockFsStatStore = {};
    taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
  });

  it("should warn when active task file is older than 7 days", () => {
    var validTask = {
      taskId: "TASK-123",
      taskName: "Old Feature",
      updateSetName: "CU-TASK-123",
    };
    mockFsStore[taskPath] = JSON.stringify(validTask);
    // 10 days ago
    mockFsStatStore[taskPath] = {
      mtimeMs: Date.now() - 10 * 24 * 60 * 60 * 1000,
    };

    var result = (multiScopeWatcher as any).readActiveTask();

    expect(result).not.toBeNull();
    expect(result.taskId).toBe("TASK-123");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Old Feature"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("10 days ago"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dove task clear"),
    );
  });

  it("should not warn when active task file is fresh (under 7 days)", () => {
    var validTask = {
      taskId: "TASK-456",
      taskName: "Recent Feature",
      updateSetName: "CU-TASK-456",
    };
    mockFsStore[taskPath] = JSON.stringify(validTask);
    // 2 days ago
    mockFsStatStore[taskPath] = {
      mtimeMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
    };

    var result = (multiScopeWatcher as any).readActiveTask();

    expect(result).not.toBeNull();
    expect(result.taskId).toBe("TASK-456");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("should use taskId as fallback when taskName is missing", () => {
    var taskNoName = {
      taskId: "TASK-789",
      updateSetName: "CU-TASK-789",
    };
    mockFsStore[taskPath] = JSON.stringify(taskNoName);
    // 14 days ago
    mockFsStatStore[taskPath] = {
      mtimeMs: Date.now() - 14 * 24 * 60 * 60 * 1000,
    };

    var result = (multiScopeWatcher as any).readActiveTask();

    expect(result).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("TASK-789"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("14 days ago"),
    );
  });

  it("should not warn when task file is exactly 6 days old", () => {
    var validTask = {
      taskId: "TASK-EDGE",
      taskName: "Edge Case",
      updateSetName: "CU-TASK-EDGE",
    };
    mockFsStore[taskPath] = JSON.stringify(validTask);
    // 6 days ago
    mockFsStatStore[taskPath] = {
      mtimeMs: Date.now() - 6 * 24 * 60 * 60 * 1000,
    };

    var result = (multiScopeWatcher as any).readActiveTask();

    expect(result).not.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
