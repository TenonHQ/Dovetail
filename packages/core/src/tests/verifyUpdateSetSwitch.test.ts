/**
 * Tests for US-007: Verify update set is active after creation
 *
 * Validates:
 * - After switchToUpdateSet(), getCurrentUpdateSet() is called to verify the sys_id matches
 * - Verification failure triggers a retry
 * - Retry failure produces explicit error with actual update set name
 * - MultiScopeWatcher's ensureUpdateSetForScope() includes the same verification
 */

// --- Mock setup (MultiScopeWatcher tests) ---

var mockSNClient = {
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

describe("US-007: Verify update set is active after creation", () => {
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

  it("verifies update set switch by calling getCurrentUpdateSet after changeUpdateSet", async () => {
    // Setup: active task + no existing config
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

    // Scope exists
    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);

    // Search returns existing update set
    mockSNClient.client.get.mockResolvedValue({
      data: { result: [{ sys_id: "us_123", name: "CU-abc123 Test Task" }] },
    });

    // changeUpdateSet succeeds
    mockSNClient.changeUpdateSet.mockResolvedValue(undefined);

    // getCurrentUpdateSet confirms the correct sys_id
    mockSNClient.getCurrentUpdateSet.mockResolvedValue({
      data: { result: { sysId: "us_123", name: "CU-abc123 Test Task" } },
    });

    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_scope");

    // changeUpdateSet was called
    expect(mockSNClient.changeUpdateSet).toHaveBeenCalledWith({
      sysId: "us_123",
    });

    // getCurrentUpdateSet was called for verification
    expect(mockSNClient.getCurrentUpdateSet).toHaveBeenCalledWith(
      "x_test_scope",
    );

    // Verify debug confirmation logged
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Update set switch verified"),
    );
  });

  it("retries switch when verification shows wrong update set, succeeds on retry", async () => {
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

    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.client.get.mockResolvedValue({
      data: { result: [{ sys_id: "us_123", name: "CU-abc123 Test Task" }] },
    });
    mockSNClient.changeUpdateSet.mockResolvedValue(undefined);

    // First verification fails (wrong sys_id), second succeeds
    mockSNClient.getCurrentUpdateSet
      .mockResolvedValueOnce({
        data: { result: { sysId: "wrong_us_id", name: "Default" } },
      })
      .mockResolvedValueOnce({
        data: { result: { sysId: "us_123", name: "CU-abc123 Test Task" } },
      });

    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_scope");

    // changeUpdateSet called twice (initial + retry)
    expect(mockSNClient.changeUpdateSet).toHaveBeenCalledTimes(2);

    // Warning logged about retry
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("verification failed, retrying"),
    );

    // Should succeed — no error about "could not be activated"
    var errorCalls = (logger.error as jest.Mock).mock.calls.map(function (
      c: any[],
    ) {
      return c[0];
    });
    var hasActivationError = errorCalls.some(function (msg: string) {
      return (
        typeof msg === "string" && msg.indexOf("could not be activated") !== -1
      );
    });
    expect(hasActivationError).toBe(false);
  });

  it("logs explicit error when both switch attempts fail verification", async () => {
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

    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.client.get.mockResolvedValue({
      data: { result: [{ sys_id: "us_123", name: "CU-abc123 Test Task" }] },
    });
    mockSNClient.changeUpdateSet.mockResolvedValue(undefined);

    // Both verifications fail — always returns wrong sys_id
    mockSNClient.getCurrentUpdateSet.mockResolvedValue({
      data: { result: { sysId: "wrong_us_id", name: "Default" } },
    });

    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_scope");

    // changeUpdateSet called twice (initial + retry)
    expect(mockSNClient.changeUpdateSet).toHaveBeenCalledTimes(2);

    // Error message should include both the update set name and the actual active one
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("could not be activated"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Default"),
    );
  });

  it("does not retry when verification passes on first attempt", async () => {
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

    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.client.get.mockResolvedValue({
      data: { result: [{ sys_id: "us_123", name: "CU-abc123 Test Task" }] },
    });
    mockSNClient.changeUpdateSet.mockResolvedValue(undefined);

    // Verification passes on first attempt
    mockSNClient.getCurrentUpdateSet.mockResolvedValue({
      data: { result: { sysId: "us_123", name: "CU-abc123 Test Task" } },
    });

    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_scope");

    // changeUpdateSet called only once
    expect(mockSNClient.changeUpdateSet).toHaveBeenCalledTimes(1);

    // getCurrentUpdateSet called once for verification
    expect(mockSNClient.getCurrentUpdateSet).toHaveBeenCalledTimes(1);

    // No retry warning
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("verification failed, retrying"),
    );
  });

  it("handles getCurrentUpdateSet throwing during verification gracefully", async () => {
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

    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.client.get.mockResolvedValue({
      data: { result: [{ sys_id: "us_123", name: "CU-abc123 Test Task" }] },
    });
    mockSNClient.changeUpdateSet.mockResolvedValue(undefined);

    // getCurrentUpdateSet throws (network error etc.)
    mockSNClient.getCurrentUpdateSet.mockRejectedValue(
      new Error("Network error"),
    );

    // Should not crash — the outer try/catch in ensureUpdateSetForScope handles it
    await (multiScopeWatcher as any).ensureUpdateSetForScope("x_test_scope");

    // Should have attempted verification
    expect(mockSNClient.getCurrentUpdateSet).toHaveBeenCalled();
  });
});
