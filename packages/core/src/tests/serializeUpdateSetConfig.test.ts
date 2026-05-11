/**
 * US-005: Serialize update set config writes under scope lock
 *
 * Tests that:
 * - ensureUpdateSetForScope() calls are serialized via scopeLock
 * - 3 concurrent scope writes all persist correctly
 * - After writing, config is verified by re-reading
 * - No mapping is lost due to concurrent writes
 */

// --- Mock setup ---

var mockFsStore: Record<string, string> = {};

jest.mock("fs", function () {
  return {
    existsSync: jest.fn(function (p: string) {
      return p in mockFsStore;
    }),
    readFileSync: jest.fn(function (p: string) {
      if (p in mockFsStore) return mockFsStore[p];
      throw new Error("ENOENT: " + p);
    }),
    writeFileSync: jest.fn(function (p: string, data: string) {
      mockFsStore[p] = data;
    }),
    statSync: jest.fn(function () { return { mtimeMs: Date.now() }; }),
    promises: {
      readFile: jest.fn(function (p: string) {
        if (p in mockFsStore) return Promise.resolve(mockFsStore[p]);
        return Promise.reject(new Error("ENOENT: " + p));
      }),
      writeFile: jest.fn(),
      readdir: jest.fn(),
      mkdir: jest.fn(),
      access: jest.fn(),
      stat: jest.fn(),
    },
  };
});

var mockSNClient = {
  getScopeId: jest.fn(),
  getUserSysId: jest.fn(),
  getCurrentAppUserPrefSysId: jest.fn(),
  updateCurrentAppUserPref: jest.fn(),
  createCurrentAppUserPref: jest.fn(),
  getCurrentUpdateSetUserPref: jest.fn(),
  changeScope: jest.fn().mockResolvedValue(undefined),
  client: {
    get: jest.fn(),
  },
  changeUpdateSet: jest.fn().mockResolvedValue(undefined),
  createUpdateSet: jest.fn(),
};

jest.mock("../snClient", function () {
  return {
    defaultClient: jest.fn(function () { return mockSNClient; }),
    unwrapSNResponse: jest.fn(function (val: any) { return val; }),
  };
});

jest.mock("chokidar", function () {
  return {
    watch: jest.fn(function () {
      return {
        on: jest.fn().mockReturnThis(),
        close: jest.fn(),
      };
    }),
  };
});

jest.mock("lodash", function () {
  var actual = jest.requireActual("lodash");
  return {
    ...actual,
    debounce: jest.fn(function (fn: Function) {
      var wrapper = jest.fn();
      (wrapper as any).cancel = jest.fn();
      (wrapper as any).flush = jest.fn(function () { return fn(); });
      return wrapper;
    }),
  };
});

jest.mock("../FileUtils", function () {
  return {
    getFileContextFromPath: jest.fn(),
    getFileContextWithSkipReason: jest.fn(),
  };
});

jest.mock("../appUtils", function () {
  return {
    groupAppFiles: jest.fn(),
    pushFiles: jest.fn(),
  };
});

jest.mock("../logMessages", function () {
  return { logFilePush: jest.fn() };
});

jest.mock("../recentEdits", function () {
  return { writeRecentEdit: jest.fn() };
});

jest.mock("../Logger", function () {
  return {
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      success: jest.fn(),
      getLogLevel: jest.fn().mockReturnValue("info"),
    },
  };
});

jest.mock("../config", function () {
  return {
    loadConfigs: jest.fn().mockResolvedValue(undefined),
    getConfig: jest.fn().mockReturnValue({
      sourceDirectory: "src",
      buildDirectory: "build",
      rules: [],
      includes: {},
      excludes: {},
      tableOptions: {},
      refreshInterval: 30,
      scopes: {
        x_scope_a: { sourceDirectory: "src/x_scope_a" },
        x_scope_b: { sourceDirectory: "src/x_scope_b" },
        x_scope_c: { sourceDirectory: "src/x_scope_c" },
      },
    }),
    getRootDir: jest.fn().mockReturnValue("/project"),
    updateManifest: jest.fn(),
    getManifest: jest.fn(),
    getSourcePath: jest.fn().mockReturnValue("/project/src"),
    getScopeManifestPath: jest.fn(function (scope: string) { return "/project/dove.manifest." + scope + ".json"; }),
    getManifestPath: jest.fn().mockReturnValue("/project/dove.manifest.json"),
  };
});

jest.mock("axios", function () {
  return {
    default: {
      create: jest.fn(function () {
        return {
          get: jest.fn().mockResolvedValue({ data: { result: null } }),
        };
      }),
    },
  };
});

// --- Imports ---
import fs from "fs";
import { logger } from "../Logger";
import { multiScopeWatcher, stopMultiScopeWatching } from "../MultiScopeWatcher";

// --- Helpers ---

var CONFIG_PATH = "/fake/.dove-update-sets.json";
var TASK_PATH = "/fake/.dove-active-task.json";

function setActiveTask(task: any) {
  var taskPath = require("path").resolve(process.cwd(), ".dove-active-task.json");
  mockFsStore[taskPath] = JSON.stringify(task);
}

function getConfigPath() {
  return require("path").resolve(process.cwd(), ".dove-update-sets.json");
}

function readPersistedConfig(): Record<string, any> {
  var configPath = getConfigPath();
  if (configPath in mockFsStore) {
    return JSON.parse(mockFsStore[configPath]);
  }
  return {};
}

function clearFsStore() {
  Object.keys(mockFsStore).forEach(function (k) { delete mockFsStore[k]; });
}

// --- Tests ---

describe("US-005: Serialize update set config writes under scope lock", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    clearFsStore();
    stopMultiScopeWatching();

    // Default: scope switching succeeds
    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.getUserSysId.mockResolvedValue([{ sys_id: "user_sys_id" }]);
    mockSNClient.getCurrentAppUserPrefSysId.mockResolvedValue([{ sys_id: "pref_sys_id" }]);
    mockSNClient.updateCurrentAppUserPref.mockResolvedValue({});
    mockSNClient.createCurrentAppUserPref.mockResolvedValue({});
    mockSNClient.changeScope.mockResolvedValue(undefined);
    mockSNClient.changeUpdateSet.mockResolvedValue(undefined);

    // Mock: existing update set found for each scope
    mockSNClient.client.get.mockResolvedValue({
      data: {
        result: [{ sys_id: "us_found_123", name: "CU-TASK123 Update Set", state: "in progress" }],
      },
    });
  });

  afterEach(function () {
    stopMultiScopeWatching();
  });

  it("3 concurrent ensureUpdateSetForScope calls all persist correctly", async function () {
    // Set up active task so ensureUpdateSetForScope will create update sets
    setActiveTask({
      taskId: "TASK123",
      taskName: "Test Task",
      taskDescription: "desc",
      updateSetName: "CU-TASK123 Update Set",
      description: "desc",
      taskUrl: "https://example.com",
      scopes: {},
    });

    // Return different sys_ids for each scope's search
    var callCount = 0;
    mockSNClient.client.get.mockImplementation(function () {
      callCount++;
      return Promise.resolve({
        data: {
          result: [{ sys_id: "us_" + callCount, name: "CU-TASK123 Scope " + callCount, state: "in progress" }],
        },
      });
    });

    // Call all 3 concurrently — they should serialize under scopeLock
    var watcher = multiScopeWatcher as any;
    var p1 = watcher.withScopeLock(function () { return watcher.ensureUpdateSetForScope("x_scope_a"); });
    var p2 = watcher.withScopeLock(function () { return watcher.ensureUpdateSetForScope("x_scope_b"); });
    var p3 = watcher.withScopeLock(function () { return watcher.ensureUpdateSetForScope("x_scope_c"); });

    await Promise.all([p1, p2, p3]);

    // All 3 scopes should be in the persisted config
    var config = readPersistedConfig();
    expect(config.x_scope_a).toBeDefined();
    expect(config.x_scope_a.sys_id).toBe("us_1");
    expect(config.x_scope_b).toBeDefined();
    expect(config.x_scope_b.sys_id).toBe("us_2");
    expect(config.x_scope_c).toBeDefined();
    expect(config.x_scope_c.sys_id).toBe("us_3");
  });

  it("re-reads config before writing to preserve other scopes' mappings", async function () {
    // Pre-populate config with scope_a already mapped
    var configPath = getConfigPath();
    mockFsStore[configPath] = JSON.stringify({
      x_scope_a: { sys_id: "existing_a", name: "Existing A" },
    });

    setActiveTask({
      taskId: "TASK456",
      taskName: "Test",
      taskDescription: "",
      updateSetName: "CU-TASK456",
      description: "",
      taskUrl: "",
      scopes: {},
    });

    mockSNClient.client.get.mockResolvedValue({
      data: {
        result: [{ sys_id: "us_new_b", name: "CU-TASK456 B", state: "in progress" }],
      },
    });

    var watcher = multiScopeWatcher as any;
    await watcher.withScopeLock(function () { return watcher.ensureUpdateSetForScope("x_scope_b"); });

    // Both scope_a (pre-existing) and scope_b (new) should be present
    var config = readPersistedConfig();
    expect(config.x_scope_a).toBeDefined();
    expect(config.x_scope_a.sys_id).toBe("existing_a");
    expect(config.x_scope_b).toBeDefined();
    expect(config.x_scope_b.sys_id).toBe("us_new_b");
  });

  it("verifies write after saving config and logs debug confirmation", async function () {
    setActiveTask({
      taskId: "TASK789",
      taskName: "Test",
      taskDescription: "",
      updateSetName: "CU-TASK789",
      description: "",
      taskUrl: "",
      scopes: {},
    });

    mockSNClient.client.get.mockResolvedValue({
      data: {
        result: [{ sys_id: "us_verified", name: "CU-TASK789", state: "in progress" }],
      },
    });

    var watcher = multiScopeWatcher as any;
    await watcher.withScopeLock(function () { return watcher.ensureUpdateSetForScope("x_scope_a"); });

    // Should log a debug message confirming verification
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Update set config verified"),
    );
  });

  it("throws and logs error when write verification fails", async function () {
    setActiveTask({
      taskId: "TASKFAIL",
      taskName: "Test",
      taskDescription: "",
      updateSetName: "CU-TASKFAIL",
      description: "",
      taskUrl: "",
      scopes: {},
    });

    mockSNClient.client.get.mockResolvedValue({
      data: {
        result: [{ sys_id: "us_fail", name: "CU-TASKFAIL", state: "in progress" }],
      },
    });

    // Make writeFileSync succeed but readFileSync return empty on verification re-read
    var writeCount = 0;
    (fs.writeFileSync as jest.Mock).mockImplementation(function (p: string, data: string) {
      // Write succeeds but data is "corrupted" — store empty config
      mockFsStore[p] = JSON.stringify({});
    });

    var watcher = multiScopeWatcher as any;

    // The error is caught by ensureUpdateSetForScope's try/catch, which logs error + warn
    await watcher.withScopeLock(function () { return watcher.ensureUpdateSetForScope("x_scope_a"); });

    // Should log error about verification failure
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("write verification failed"),
    );
  });

  it("skips API calls when scope already has a mapping", async function () {
    // Pre-populate config with scope_a already mapped
    var configPath = getConfigPath();
    mockFsStore[configPath] = JSON.stringify({
      x_scope_a: { sys_id: "existing_a", name: "Existing A" },
    });

    var watcher = multiScopeWatcher as any;
    await watcher.withScopeLock(function () { return watcher.ensureUpdateSetForScope("x_scope_a"); });

    // Should not have called any ServiceNow APIs
    expect(mockSNClient.changeScope).not.toHaveBeenCalled();
    expect(mockSNClient.client.get).not.toHaveBeenCalled();
  });
});
