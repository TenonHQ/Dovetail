import { Sinc } from "@tenonhq/dovetail-types";

// --- Mock setup ---

type EventHandler = (...args: any[]) => void;
interface MockWatcher {
  on: jest.Mock;
  close: jest.Mock;
  _handlers: Record<string, EventHandler[]>;
  _emit: (event: string, ...args: any[]) => void;
}

function createMockWatcher(): MockWatcher {
  var handlers: Record<string, EventHandler[]> = {};
  var mock: MockWatcher = {
    _handlers: handlers,
    on: jest.fn(function (event: string, handler: EventHandler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return mock;
    }),
    close: jest.fn(),
    _emit: function (event: string) {
      var args = Array.prototype.slice.call(arguments, 1);
      (handlers[event] || []).forEach(function (h) {
        h.apply(null, args);
      });
    },
  };
  return mock;
}

var mockWatchers: MockWatcher[] = [];

jest.mock("chokidar", function () {
  return {
    watch: jest.fn(function () {
      var w = createMockWatcher();
      mockWatchers.push(w);
      return w;
    }),
  };
});

// Capture debounce calls to verify single global debounce
var capturedDebounceFns: Function[] = [];

jest.mock("lodash", function () {
  var actual = jest.requireActual("lodash");
  return {
    ...actual,
    debounce: jest.fn(function (fn: Function) {
      capturedDebounceFns.push(fn);
      var wrapper = jest.fn();
      (wrapper as any).cancel = jest.fn();
      (wrapper as any).flush = jest.fn(function () {
        return fn();
      });
      return wrapper;
    }),
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
};

jest.mock("../snClient", function () {
  return {
    defaultClient: jest.fn(function () {
      return mockSNClient;
    }),
    unwrapSNResponse: jest.fn(function (val: any) {
      return val;
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
    getConfig: jest.fn(),
    getRootDir: jest.fn().mockReturnValue("/project"),
    updateManifest: jest.fn(),
    getManifest: jest.fn(),
    getSourcePath: jest.fn().mockReturnValue("/project/src"),
    getScopeManifestPath: jest.fn(function (scope: string) {
      return "/project/dove.manifest." + scope + ".json";
    }),
    getManifestPath: jest.fn().mockReturnValue("/project/dove.manifest.json"),
  };
});

jest.mock("fs", function () {
  return {
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    statSync: jest.fn().mockReturnValue({ mtimeMs: Date.now() }),
    promises: {
      readFile: jest.fn(),
      writeFile: jest.fn(),
      readdir: jest.fn(),
      mkdir: jest.fn(),
      access: jest.fn(),
      stat: jest.fn(),
    },
  };
});

jest.mock("axios", function () {
  return {
    default: {
      create: jest.fn(function () {
        return { get: jest.fn().mockResolvedValue({ data: { result: null } }) };
      }),
    },
  };
});

// --- Imports ---
import fs from "fs";
import * as ConfigManager from "../config";
import { getFileContextWithSkipReason } from "../FileUtils";
import { groupAppFiles, pushFiles } from "../appUtils";
import { logger } from "../Logger";
import {
  multiScopeWatcher,
  startMultiScopeWatching,
  stopMultiScopeWatching,
} from "../MultiScopeWatcher";

// --- Fixtures ---

var makeFileContext = function (
  overrides?: Partial<Sinc.FileContext>,
): Sinc.FileContext {
  return Object.assign(
    {
      filePath:
        "/project/src/x_test_core/sys_script_include/TestScript/script.js",
      ext: ".js",
      sys_id: "abc123",
      name: "TestScript",
      scope: "x_test_core",
      tableName: "sys_script_include",
      targetField: "script",
    },
    overrides || {},
  );
};

var TWO_SCOPES_CONFIG = {
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
  },
};

// --- Tests ---

describe("US-014: Global debounce for serialized scope processing", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    mockWatchers.length = 0;
    capturedDebounceFns.length = 0;
    stopMultiScopeWatching();
    (multiScopeWatcher as any).cachedScope = null;
    (multiScopeWatcher as any).cachedUserSysId = null;
    (multiScopeWatcher as any).pendingScopes = new Map();
    (multiScopeWatcher as any).globalProcessQueue = null;

    // Default scope switching succeeds
    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.getUserSysId.mockResolvedValue([{ sys_id: "user_sys_id" }]);
    mockSNClient.getCurrentAppUserPrefSysId.mockResolvedValue([
      { sys_id: "pref_sys_id" },
    ]);
    mockSNClient.updateCurrentAppUserPref.mockResolvedValue({});
    mockSNClient.createCurrentAppUserPref.mockResolvedValue({});

    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  afterEach(function () {
    stopMultiScopeWatching();
    jest.useRealTimers();
  });

  it("creates a single global debounce, not one per scope", async function () {
    (ConfigManager.getConfig as jest.Mock).mockReturnValue(TWO_SCOPES_CONFIG);

    await startMultiScopeWatching({ monitorIntervalMs: 0 });

    // Two scopes but only one debounce function captured
    expect(capturedDebounceFns.length).toBe(1);
  });

  it("processes multiple scopes triggered within debounce window in a single batch", async function () {
    (ConfigManager.getConfig as jest.Mock).mockReturnValue(TWO_SCOPES_CONFIG);

    var ctxA = makeFileContext({
      scope: "x_scope_a",
      filePath: "/project/src/x_scope_a/sys_script_include/A/script.js",
    });
    var ctxB = makeFileContext({
      scope: "x_scope_b",
      filePath: "/project/src/x_scope_b/sys_script_include/B/script.js",
    });
    (getFileContextWithSkipReason as jest.Mock).mockImplementation(function (
      fp: string,
    ) {
      if (fp.indexOf("x_scope_a") !== -1) return { context: ctxA };
      if (fp.indexOf("x_scope_b") !== -1) return { context: ctxB };
      return { skipReason: "unknown" };
    });
    (groupAppFiles as jest.Mock).mockReturnValue([
      { table: "sys_script_include", sysId: "abc123", fields: {} },
    ]);
    (pushFiles as jest.Mock).mockResolvedValue([
      { success: true, message: "ok" },
    ]);

    await startMultiScopeWatching({ monitorIntervalMs: 0 });

    // Emit changes in both scopes before debounce fires
    mockWatchers[0]._emit("change", ctxA.filePath);
    mockWatchers[1]._emit("change", ctxB.filePath);

    // Fire the single global debounce
    await capturedDebounceFns[0]();

    // Both scopes should have been processed (pushFiles called twice — once per scope)
    expect(pushFiles).toHaveBeenCalledTimes(2);
  });

  it("processes scopes in FIFO order by first file change timestamp", async function () {
    (ConfigManager.getConfig as jest.Mock).mockReturnValue(TWO_SCOPES_CONFIG);

    var ctxA = makeFileContext({
      scope: "x_scope_a",
      filePath: "/project/src/x_scope_a/sys_script_include/A/script.js",
    });
    var ctxB = makeFileContext({
      scope: "x_scope_b",
      filePath: "/project/src/x_scope_b/sys_script_include/B/script.js",
    });
    (getFileContextWithSkipReason as jest.Mock).mockImplementation(function (
      fp: string,
    ) {
      if (fp.indexOf("x_scope_a") !== -1) return { context: ctxA };
      if (fp.indexOf("x_scope_b") !== -1) return { context: ctxB };
      return { skipReason: "unknown" };
    });
    (groupAppFiles as jest.Mock).mockReturnValue([
      { table: "sys_script_include", sysId: "abc123", fields: {} },
    ]);
    (pushFiles as jest.Mock).mockResolvedValue([
      { success: true, message: "ok" },
    ]);

    await startMultiScopeWatching({ monitorIntervalMs: 0 });

    // Scope B changes first, then scope A
    // Use pendingScopes directly to control timestamps for deterministic ordering
    (multiScopeWatcher as any).pendingScopes.set("x_scope_b", 1000);
    (multiScopeWatcher as any).pendingScopes.set("x_scope_a", 2000);

    // Add files to queues manually
    var watcherA = (multiScopeWatcher as any).scopeWatchers.get("x_scope_a");
    var watcherB = (multiScopeWatcher as any).scopeWatchers.get("x_scope_b");
    watcherA.pushQueue.push(ctxA.filePath);
    watcherB.pushQueue.push(ctxB.filePath);

    // Track the order of scope switches
    var switchOrder: string[] = [];
    mockSNClient.changeScope.mockImplementation(function (scope: string) {
      switchOrder.push(scope);
      return Promise.resolve(undefined);
    });

    // Fire the global debounce
    await capturedDebounceFns[0]();

    // Scope B (timestamp 1000) should be processed before scope A (timestamp 2000)
    expect(switchOrder[0]).toBe("x_scope_b");
    expect(switchOrder[1]).toBe("x_scope_a");
  });

  it("clears pendingScopes after processing", async function () {
    (ConfigManager.getConfig as jest.Mock).mockReturnValue(TWO_SCOPES_CONFIG);

    var ctx = makeFileContext({
      scope: "x_scope_a",
      filePath: "/project/src/x_scope_a/sys_script_include/A/script.js",
    });
    (getFileContextWithSkipReason as jest.Mock).mockReturnValue({
      context: ctx,
    });
    (groupAppFiles as jest.Mock).mockReturnValue([
      { table: "sys_script_include", sysId: "abc123", fields: {} },
    ]);
    (pushFiles as jest.Mock).mockResolvedValue([
      { success: true, message: "ok" },
    ]);

    await startMultiScopeWatching({ monitorIntervalMs: 0 });

    mockWatchers[0]._emit("change", ctx.filePath);
    await capturedDebounceFns[0]();

    expect((multiScopeWatcher as any).pendingScopes.size).toBe(0);
  });

  it("only records first change timestamp per scope (not subsequent changes)", async function () {
    (ConfigManager.getConfig as jest.Mock).mockReturnValue({
      ...TWO_SCOPES_CONFIG,
      scopes: { x_scope_a: { sourceDirectory: "src/x_scope_a" } },
    });

    await startMultiScopeWatching({ monitorIntervalMs: 0 });

    // Record the timestamp after first emit
    mockWatchers[0]._emit(
      "change",
      "/project/src/x_scope_a/sys_script_include/A/script.js",
    );
    var firstTimestamp = (multiScopeWatcher as any).pendingScopes.get(
      "x_scope_a",
    );

    // Wait a bit and emit again
    await new Promise(function (r) {
      setTimeout(r, 5);
    });
    mockWatchers[0]._emit(
      "change",
      "/project/src/x_scope_a/sys_script_include/B/script.js",
    );
    var secondTimestamp = (multiScopeWatcher as any).pendingScopes.get(
      "x_scope_a",
    );

    // Timestamp should not have changed
    expect(secondTimestamp).toBe(firstTimestamp);
  });
});
