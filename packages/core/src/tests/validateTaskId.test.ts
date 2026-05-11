/**
 * Tests for US-010: Validate task ID before ServiceNow queries
 *
 * Validates:
 * - taskId is validated as non-empty string before constructing nameLIKECU-{taskId} query
 * - Empty/undefined taskId logs an error and skips update set lookup
 * - readActiveTask() validates required fields (taskId, updateSetName) and returns null if missing
 * - Missing required fields produce a clear error, not a crash
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
  getScopeManifestPath: jest.fn((scope: string) => `/project/dove.manifest.${scope}.json`),
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
import { multiScopeWatcher, stopMultiScopeWatching } from "../MultiScopeWatcher";
import * as path from "path";

// --- Tests ---

describe("US-010: Validate task ID before ServiceNow queries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFsStore = {};

    // Default: scope switching succeeds
    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.getUserSysId.mockResolvedValue([{ sys_id: "user_sys_id" }]);
    mockSNClient.getCurrentAppUserPrefSysId.mockResolvedValue([{ sys_id: "pref_sys_id" }]);
    mockSNClient.updateCurrentAppUserPref.mockResolvedValue({});
    mockSNClient.createCurrentAppUserPref.mockResolvedValue({});
  });

  afterEach(() => {
    stopMultiScopeWatching();
  });

  describe("readActiveTask() validation", () => {
    it("returns null and logs error when taskId is empty string", () => {
      var taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
      mockFsStore[taskPath] = JSON.stringify({
        taskId: "",
        taskName: "Test Task",
        updateSetName: "CU- Test Task",
        description: "Test",
        taskUrl: "",
        scopes: {},
      });

      var result = (multiScopeWatcher as any).readActiveTask();

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("missing a valid taskId")
      );
    });

    it("returns null and logs error when taskId is undefined", () => {
      var taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
      mockFsStore[taskPath] = JSON.stringify({
        taskName: "Test Task",
        updateSetName: "CU-abc Test Task",
        description: "Test",
        taskUrl: "",
        scopes: {},
      });

      var result = (multiScopeWatcher as any).readActiveTask();

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("missing a valid taskId")
      );
    });

    it("returns null and logs error when updateSetName is empty string", () => {
      var taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
      mockFsStore[taskPath] = JSON.stringify({
        taskId: "abc123",
        taskName: "Test Task",
        updateSetName: "",
        description: "Test",
        taskUrl: "",
        scopes: {},
      });

      var result = (multiScopeWatcher as any).readActiveTask();

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("missing a valid updateSetName")
      );
    });

    it("returns null and logs error when updateSetName is missing", () => {
      var taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
      mockFsStore[taskPath] = JSON.stringify({
        taskId: "abc123",
        taskName: "Test Task",
        description: "Test",
        taskUrl: "",
        scopes: {},
      });

      var result = (multiScopeWatcher as any).readActiveTask();

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("missing a valid updateSetName")
      );
    });

    it("returns valid task when both taskId and updateSetName are present", () => {
      var taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
      mockFsStore[taskPath] = JSON.stringify({
        taskId: "abc123",
        taskName: "Test Task",
        updateSetName: "CU-abc123 Test Task",
        description: "Test",
        taskUrl: "",
        scopes: {},
      });

      var result = (multiScopeWatcher as any).readActiveTask();

      expect(result).not.toBeNull();
      expect(result.taskId).toBe("abc123");
      expect(result.updateSetName).toBe("CU-abc123 Test Task");
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe("ensureUpdateSetForScope() taskId validation", () => {
    it("skips update set lookup when taskId is whitespace-only", async () => {
      var taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
      mockFsStore[taskPath] = JSON.stringify({
        taskId: "   ",
        taskName: "Test Task",
        updateSetName: "CU- Test Task",
        description: "Test",
        taskUrl: "",
        scopes: {},
      });

      await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_scope");

      // readActiveTask should have returned null due to whitespace-only taskId
      // which triggers the no-active-task warning instead
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No update set configured for scope")
      );

      // Should NOT have made any ServiceNow API calls
      expect(mockSNClient.changeScope).not.toHaveBeenCalled();
      expect(mockSNClient.client.get).not.toHaveBeenCalled();
      expect(mockSNClient.createUpdateSet).not.toHaveBeenCalled();
    });

    it("does not crash with missing required fields in task file", async () => {
      var taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
      mockFsStore[taskPath] = JSON.stringify({
        taskName: "Partial Task",
      });

      // Should not throw
      await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_scope");

      // readActiveTask returns null → falls through to no-active-task warning
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("missing a valid taskId")
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No update set configured for scope")
      );

      // No ServiceNow API calls
      expect(mockSNClient.changeScope).not.toHaveBeenCalled();
    });

    it("proceeds with valid taskId and makes ServiceNow query", async () => {
      var taskPath = path.resolve(process.cwd(), ".dove-active-task.json");
      mockFsStore[taskPath] = JSON.stringify({
        taskId: "abc123",
        taskName: "Test Task",
        updateSetName: "CU-abc123 Test Task",
        description: "Test",
        taskUrl: "",
        scopes: {},
      });

      // Mock: scope found, existing update set found
      mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
      mockSNClient.client.get.mockResolvedValue({
        data: { result: [{ sys_id: "us_123", name: "CU-abc123 Test Task", state: "in progress" }] },
      });
      mockSNClient.changeUpdateSet.mockResolvedValue(undefined);
      mockSNClient.getCurrentUpdateSet.mockResolvedValue({
        data: { result: { sysId: "us_123", name: "CU-abc123 Test Task" } },
      });

      await (multiScopeWatcher as any).ensureUpdateSetForScope("x_valid_scope");

      // Should have proceeded to search ServiceNow
      expect(mockSNClient.client.get).toHaveBeenCalled();

      // The query should contain the taskId
      var getCall = mockSNClient.client.get.mock.calls[0];
      expect(getCall[1].params.sysparm_query).toContain("CU-abc123");

      // No "empty taskId" error
      var errorCalls = (logger.error as jest.Mock).mock.calls.map(function (c: any[]) { return c[0]; });
      var hasEmptyTaskIdError = errorCalls.some(function (msg: string) {
        return msg.indexOf("empty taskId") !== -1;
      });
      expect(hasEmptyTaskIdError).toBe(false);
    });
  });
});
