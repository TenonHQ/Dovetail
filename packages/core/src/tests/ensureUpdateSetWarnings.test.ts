/**
 * Tests for US-006: Surface warning when no update set is configured
 *
 * Validates:
 * - Prominent warning when readActiveTask() returns null and no update set configured
 * - Warning message includes specific text about Default and remediation steps
 * - Invalid scope name produces a clear error (not a global-scope update set)
 * - scopeSysId validated before creating update set; null/undefined skips with error
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
  statSync: jest.fn(() => ({ mtimeMs: Date.now() })),
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
import {
  multiScopeWatcher,
  stopMultiScopeWatching,
} from "../MultiScopeWatcher";

// --- Tests ---

describe("US-006: Surface warning when no update set is configured", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFsStore = {};

    // Default: scope switching succeeds
    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.getUserSysId.mockResolvedValue([{ sys_id: "user_sys_id" }]);
    mockSNClient.getCurrentAppUserPrefSysId.mockResolvedValue([
      { sys_id: "pref_sys_id" },
    ]);
    mockSNClient.updateCurrentAppUserPref.mockResolvedValue({});
    mockSNClient.createCurrentAppUserPref.mockResolvedValue({});
  });

  afterEach(() => {
    stopMultiScopeWatching();
  });

  it("warns with specific message when no active task and no update set configured", async () => {
    // No .dove-update-sets.json and no .dove-active-task.json
    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_core");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No update set configured for scope x_test_core"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Changes will go to Default"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dove createUpdateSet"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("activate a task in the dashboard"),
    );
  });

  it("does not warn when update set already configured for scope", async () => {
    // Pre-populate the update set config
    var configPath = require("path").resolve(
      process.cwd(),
      ".dove-update-sets.json",
    );
    mockFsStore[configPath] = JSON.stringify({
      x_test_core: { sys_id: "us_123", name: "My Update Set" },
    });

    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_core");

    // Should return early — no warning
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs error and skips creation when scope not found on instance (scopeSysId is undefined)", async () => {
    // Active task exists so we get past the no-task check
    var taskPath = require("path").resolve(
      process.cwd(),
      ".dove-active-task.json",
    );
    mockFsStore[taskPath] = JSON.stringify({
      taskId: "abc123",
      taskName: "Test Task",
      taskDescription: "Test",
      updateSetName: "CU-abc123 Test Task",
      description: "Test update set",
      taskUrl: "https://example.com",
      scopes: {},
    });

    // getScopeId returns empty — scope doesn't exist
    mockSNClient.getScopeId.mockResolvedValue([]);

    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_invalid_scope");

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("x_invalid_scope"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("not found on the instance"),
    );

    // Should NOT attempt to create an update set
    expect(mockSNClient.createUpdateSet).not.toHaveBeenCalled();
    expect(mockSNClient.client.get).not.toHaveBeenCalled();
  });

  it("logs error and skips creation when getScopeId returns null", async () => {
    var taskPath = require("path").resolve(
      process.cwd(),
      ".dove-active-task.json",
    );
    mockFsStore[taskPath] = JSON.stringify({
      taskId: "abc123",
      taskName: "Test Task",
      taskDescription: "Test",
      updateSetName: "CU-abc123 Test Task",
      description: "Test update set",
      taskUrl: "https://example.com",
      scopes: {},
    });

    // getScopeId returns null
    mockSNClient.getScopeId.mockResolvedValue(null);

    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_bad_scope");

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("x_bad_scope"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("not found on the instance"),
    );
    expect(mockSNClient.createUpdateSet).not.toHaveBeenCalled();
  });

  it("proceeds to create update set when scope is valid", async () => {
    var taskPath = require("path").resolve(
      process.cwd(),
      ".dove-active-task.json",
    );
    mockFsStore[taskPath] = JSON.stringify({
      taskId: "abc123",
      taskName: "Test Task",
      taskDescription: "Test",
      updateSetName: "CU-abc123 Test Task",
      description: "Test update set",
      taskUrl: "https://example.com",
      scopes: {},
    });

    // Valid scope
    mockSNClient.getScopeId.mockResolvedValue([
      { sys_id: "valid_scope_sys_id" },
    ]);

    // Search returns existing update set
    mockSNClient.client.get.mockResolvedValue({
      data: {
        result: [
          {
            sys_id: "us_existing",
            name: "CU-abc123 Test Task",
            state: "in progress",
          },
        ],
      },
    });

    // changeUpdateSet succeeds
    mockSNClient.changeUpdateSet.mockResolvedValue(undefined);

    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_valid_scope");

    // Should have searched for existing update sets (scope was valid)
    expect(mockSNClient.client.get).toHaveBeenCalled();

    // No "not found on the instance" error
    var errorCalls = (logger.error as jest.Mock).mock.calls.map(function (
      c: any[],
    ) {
      return c[0];
    });
    var hasInvalidScopeError = errorCalls.some(function (msg: string) {
      return msg.indexOf("not found on the instance") !== -1;
    });
    expect(hasInvalidScopeError).toBe(false);
  });
});
