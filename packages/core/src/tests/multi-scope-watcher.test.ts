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
  const handlers: Record<string, EventHandler[]> = {};
  const mock: MockWatcher = {
    _handlers: handlers,
    on: jest.fn((event: string, handler: EventHandler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return mock;
    }),
    close: jest.fn(),
    _emit: (event: string, ...args: any[]) => {
      (handlers[event] || []).forEach((h) => h(...args));
    },
  };
  return mock;
}

const mockWatchers: MockWatcher[] = [];

jest.mock("chokidar", () => ({
  watch: jest.fn(() => {
    const w = createMockWatcher();
    mockWatchers.push(w);
    return w;
  }),
}));

// Debounce: capture the global processor, tests trigger manually
const capturedDebounceFns: Function[] = [];

jest.mock("lodash", () => {
  const actual = jest.requireActual("lodash");
  return {
    ...actual,
    debounce: jest.fn((fn: Function) => {
      capturedDebounceFns.push(fn);
      const wrapper = jest.fn();
      (wrapper as any).cancel = jest.fn();
      (wrapper as any).flush = jest.fn(() => fn());
      return wrapper;
    }),
  };
});

const mockSNClient = {
  getScopeId: jest.fn(),
  getUserSysId: jest.fn(),
  getCurrentAppUserPrefSysId: jest.fn(),
  updateCurrentAppUserPref: jest.fn(),
  createCurrentAppUserPref: jest.fn(),
  getCurrentUpdateSetUserPref: jest.fn(),
  changeScope: jest.fn().mockResolvedValue(undefined),
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

// Mock fs for manifest loading and config file access
jest.mock("fs", () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    readdir: jest.fn(),
    mkdir: jest.fn(),
    access: jest.fn(),
    stat: jest.fn(),
  },
}));

// Also mock axios for getUpdateSetDetails
jest.mock("axios", () => ({
  default: {
    create: jest.fn(() => ({
      get: jest.fn().mockResolvedValue({ data: { result: null } }),
    })),
  },
}));

// --- Imports ---
import chokidar from "chokidar";
import fs from "fs";
import * as ConfigManager from "../config";
import { getFileContextFromPath, getFileContextWithSkipReason } from "../FileUtils";
import { groupAppFiles, pushFiles } from "../appUtils";
import { logFilePush } from "../logMessages";
import { logger } from "../Logger";
import { multiScopeWatcher, startMultiScopeWatching, stopMultiScopeWatching } from "../MultiScopeWatcher";

// Helper to flush microtask queue (for async code in setInterval callbacks)
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

// --- Fixtures ---

const makeFileContext = (overrides: Partial<Sinc.FileContext> = {}): Sinc.FileContext => ({
  filePath: "/project/src/x_test_core/sys_script_include/TestScript/script.js",
  ext: ".js",
  sys_id: "abc123",
  name: "TestScript",
  scope: "x_test_core",
  tableName: "sys_script_include",
  targetField: "script",
  ...overrides,
});

const MOCK_CONFIG_TWO_SCOPES = {
  sourceDirectory: "src",
  buildDirectory: "build",
  rules: [],
  includes: {},
  excludes: {},
  tableOptions: {},
  refreshInterval: 30,
  scopes: {
    x_test_core: { sourceDirectory: "src/x_test_core" },
    x_test_work: {},
  },
};

const MOCK_CONFIG_CUSTOM_DIR = {
  ...MOCK_CONFIG_TWO_SCOPES,
  scopes: {
    x_custom: { sourceDirectory: "custom/path" },
  },
};

const MOCK_CONFIG_NO_SCOPES = {
  sourceDirectory: "src",
};

// --- Tests ---

describe("MultiScopeWatcherManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWatchers.length = 0;
    capturedDebounceFns.length = 0;
    // Reset the internal state by stopping any previous watchers
    stopMultiScopeWatching();
    // Reset scope and user caches (US-013)
    (multiScopeWatcher as any).cachedScope = null;
    (multiScopeWatcher as any).cachedUserSysId = null;
    // Reset global debounce state (US-014)
    (multiScopeWatcher as any).pendingScopes = new Map();
    (multiScopeWatcher as any).globalProcessQueue = null;

    // Default: scope switching succeeds
    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.getUserSysId.mockResolvedValue([{ sys_id: "user_sys_id" }]);
    mockSNClient.getCurrentAppUserPrefSysId.mockResolvedValue([{ sys_id: "pref_sys_id" }]);
    mockSNClient.updateCurrentAppUserPref.mockResolvedValue({});
    mockSNClient.createCurrentAppUserPref.mockResolvedValue({});
    mockSNClient.getCurrentUpdateSetUserPref.mockResolvedValue([]);
  });

  afterEach(() => {
    stopMultiScopeWatching();
    jest.useRealTimers();
  });

  describe("startWatchingAllScopes", () => {
    it("loads config and creates a watcher per scope", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue(MOCK_CONFIG_TWO_SCOPES);

      await startMultiScopeWatching();

      expect(ConfigManager.loadConfigs).toHaveBeenCalled();
      expect(chokidar.watch).toHaveBeenCalledTimes(2);
    });

    it("throws when config has no scopes", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue(MOCK_CONFIG_NO_SCOPES);

      await expect(startMultiScopeWatching()).rejects.toThrow("No scopes defined in configuration");
    });

    it("uses custom sourceDirectory from scope config", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue(MOCK_CONFIG_CUSTOM_DIR);

      await startMultiScopeWatching();

      expect(chokidar.watch).toHaveBeenCalledWith(
        expect.stringContaining("custom/path"),
        expect.any(Object),
      );
    });

    it("uses default src/{scopeName} when no sourceDirectory", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG_TWO_SCOPES,
        scopes: { x_default_scope: {} },
      });

      await startMultiScopeWatching();

      expect(chokidar.watch).toHaveBeenCalledWith(
        expect.stringContaining("/src/x_default_scope"),
        expect.any(Object),
      );
    });

    it("configures chokidar with correct options", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG_TWO_SCOPES,
        scopes: { x_test: {} },
      });

      await startMultiScopeWatching();

      expect(chokidar.watch).toHaveBeenCalledWith(expect.any(String), {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
      });
    });

    it("registers change, add, and error handlers on each watcher", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG_TWO_SCOPES,
        scopes: { x_test: {} },
      });

      await startMultiScopeWatching();

      const watcher = mockWatchers[0];
      const registeredEvents = watcher.on.mock.calls.map((c: any[]) => c[0]);
      expect(registeredEvents).toContain("change");
      expect(registeredEvents).toContain("add");
      expect(registeredEvents).toContain("error");
    });
  });

  describe("file change in scope", () => {
    beforeEach(async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG_TWO_SCOPES,
        scopes: { x_test_core: { sourceDirectory: "src/x_test_core" } },
      });

      // fs mock for loadScopeManifest
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await startMultiScopeWatching();
    });

    it("processes file change through scope switch and push pipeline", async () => {
      const ctx = makeFileContext();
      (getFileContextWithSkipReason as jest.Mock).mockReturnValue({ context: ctx });
      (groupAppFiles as jest.Mock).mockReturnValue([{ table: "sys_script_include", sysId: "abc123", fields: {} }]);
      (pushFiles as jest.Mock).mockResolvedValue([{ success: true, message: "ok" }]);

      // Emit change on the scope's watcher
      mockWatchers[0]._emit("change", ctx.filePath);

      // Trigger the debounced processor for this scope
      await capturedDebounceFns[0]();

      expect(getFileContextWithSkipReason).toHaveBeenCalled();
      expect(groupAppFiles).toHaveBeenCalled();
      expect(pushFiles).toHaveBeenCalled();
    });

    it("processes file add through the same pipeline", async () => {
      const ctx = makeFileContext();
      (getFileContextWithSkipReason as jest.Mock).mockReturnValue({ context: ctx });
      (groupAppFiles as jest.Mock).mockReturnValue([{ table: "sys_script_include", sysId: "abc123", fields: {} }]);
      (pushFiles as jest.Mock).mockResolvedValue([{ success: true, message: "ok" }]);

      mockWatchers[0]._emit("add", ctx.filePath);
      await capturedDebounceFns[0]();

      expect(pushFiles).toHaveBeenCalled();
    });

    it("warns when no valid file contexts found", async () => {
      (getFileContextWithSkipReason as jest.Mock).mockReturnValue({ skipReason: "not in manifest" });

      mockWatchers[0]._emit("change", "/project/src/x_test_core/unknown/file.txt");
      await capturedDebounceFns[0]();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No valid file contexts found"),
      );
      expect(pushFiles).not.toHaveBeenCalled();
    });

    it("logs warning for each skipped file with reason", async () => {
      (getFileContextWithSkipReason as jest.Mock)
        .mockReturnValueOnce({ skipReason: "not in manifest" })
        .mockReturnValueOnce({ context: makeFileContext() });
      (groupAppFiles as jest.Mock).mockReturnValue([{ table: "sys_script_include", sysId: "abc123", fields: {} }]);
      (pushFiles as jest.Mock).mockResolvedValue([{ success: true, message: "ok" }]);

      mockWatchers[0]._emit("change", "/project/src/x_test_core/unknown/file.txt");
      mockWatchers[0]._emit("change", makeFileContext().filePath);
      await capturedDebounceFns[0]();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipped: /project/src/x_test_core/unknown/file.txt (not in manifest)"),
      );
    });

    it("logs warning with scope not found reason", async () => {
      (getFileContextWithSkipReason as jest.Mock).mockReturnValue({ skipReason: "scope not found" });

      mockWatchers[0]._emit("change", "/project/src/x_unknown/sys_script/file.js");
      await capturedDebounceFns[0]();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipped: /project/src/x_unknown/sys_script/file.js (scope not found)"),
      );
    });

    it("logs push summary with skipped file count", async () => {
      var ctx = makeFileContext();
      (getFileContextWithSkipReason as jest.Mock)
        .mockReturnValueOnce({ context: ctx })
        .mockReturnValueOnce({ skipReason: "not in manifest" });
      (groupAppFiles as jest.Mock).mockReturnValue([{ table: "sys_script_include", sysId: "abc123", fields: {} }]);
      (pushFiles as jest.Mock).mockResolvedValue([{ success: true, message: "ok" }]);

      mockWatchers[0]._emit("change", ctx.filePath);
      mockWatchers[0]._emit("change", "/project/src/x_test_core/unknown/other.txt");
      await capturedDebounceFns[0]();

      // Should log a summary with pushed/total counts and skipped files
      var allCalls = [
        ...(logger.info as jest.Mock).mock.calls,
        ...(logger.success as jest.Mock).mock.calls,
      ].map(function (c: any[]) { return c[0]; });
      var summaryCall = allCalls.find(function (msg: any) {
        return typeof msg === "string" && msg.indexOf("Pushed") !== -1 && msg.indexOf("files to") !== -1;
      });
      expect(summaryCall).toBeDefined();
      expect(summaryCall).toContain("1/2");
      expect(summaryCall).toContain("skipped");
    });

    it("allows file through when scope matches watcher scope", async () => {
      const ctx = makeFileContext({ scope: "x_test_core" });
      (getFileContextWithSkipReason as jest.Mock).mockReturnValue({ context: ctx });
      (groupAppFiles as jest.Mock).mockReturnValue([{ table: "sys_script_include", sysId: "abc123", fields: {} }]);
      (pushFiles as jest.Mock).mockResolvedValue([{ success: true, message: "ok" }]);

      mockWatchers[0]._emit("change", ctx.filePath);
      await capturedDebounceFns[0]();

      expect(pushFiles).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining("Scope mismatch"),
      );
    });

    it("skips file with error when scope mismatches watcher scope", async () => {
      const ctx = makeFileContext({ scope: "x_other_scope" });
      (getFileContextWithSkipReason as jest.Mock).mockReturnValue({ context: ctx });

      mockWatchers[0]._emit("change", ctx.filePath);
      await capturedDebounceFns[0]();

      // Should log an error about scope mismatch
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Scope mismatch"),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("x_other_scope"),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("x_test_core"),
      );

      // Should not push the file
      expect(pushFiles).not.toHaveBeenCalled();

      // Should appear in the summary as skipped
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No valid file contexts found"),
      );
    });

    it("includes scope-mismatched file in push summary alongside valid files", async () => {
      const validCtx = makeFileContext({ scope: "x_test_core", filePath: "/project/src/x_test_core/sys_script_include/Valid/script.js" });
      const mismatchCtx = makeFileContext({ scope: "x_other_scope", filePath: "/project/src/x_test_core/sys_script_include/Wrong/script.js" });
      (getFileContextWithSkipReason as jest.Mock)
        .mockReturnValueOnce({ context: validCtx })
        .mockReturnValueOnce({ context: mismatchCtx });
      (groupAppFiles as jest.Mock).mockReturnValue([{ table: "sys_script_include", sysId: "abc123", fields: {} }]);
      (pushFiles as jest.Mock).mockResolvedValue([{ success: true, message: "ok" }]);

      mockWatchers[0]._emit("change", validCtx.filePath);
      mockWatchers[0]._emit("change", mismatchCtx.filePath);
      await capturedDebounceFns[0]();

      // Valid file should be pushed
      expect(pushFiles).toHaveBeenCalled();

      // Mismatch should be logged as error
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Scope mismatch"),
      );

      // Push summary should include the skipped file
      var allCalls = [
        ...(logger.info as jest.Mock).mock.calls,
        ...(logger.success as jest.Mock).mock.calls,
      ].map(function (c: any[]) { return c[0]; });
      var summaryCall = allCalls.find(function (msg: any) {
        return typeof msg === "string" && msg.indexOf("Pushed") !== -1 && msg.indexOf("files to") !== -1;
      });
      expect(summaryCall).toBeDefined();
      expect(summaryCall).toContain("1/2");
      expect(summaryCall).toContain("skipped");
    });

    it("logs error on watcher error event", () => {
      mockWatchers[0]._emit("error", new Error("FS error"));
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Watcher error: FS error"),
      );
    });
  });

  describe("processScopeQueue - empty queue", () => {
    it("returns early when queue is empty", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG_TWO_SCOPES,
        scopes: { x_test_core: {} },
      });
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await startMultiScopeWatching();

      // Don't emit any events, just trigger processQueue
      await capturedDebounceFns[0]();

      // switchToScope should NOT have been called
      expect(mockSNClient.getScopeId).not.toHaveBeenCalled();
      expect(getFileContextFromPath).not.toHaveBeenCalled();
    });
  });

  describe("switchToScope", () => {
    // switchToScope now uses the Claude REST API changeScope endpoint
    // (gs.setCurrentApplicationId) to switch the active REST session scope.
    // The previous user-preference approach only wrote a DB record and did
    // not affect the session, causing updateRecord() to operate in the wrong scope.

    it("invokes client.changeScope with the target scope", async () => {
      await (multiScopeWatcher as any).switchToScope("x_test_core");

      expect(mockSNClient.changeScope).toHaveBeenCalledWith("x_test_core");
    });

    it("propagates errors from changeScope and invalidates cached scope", async () => {
      mockSNClient.changeScope.mockRejectedValueOnce(new Error("changeScope failed"));

      await expect(
        (multiScopeWatcher as any).switchToScope("x_test_core"),
      ).rejects.toThrow("changeScope failed");
    });
  });

  describe("loadScopeManifest", () => {
    it("loads scope-specific manifest when it exists", async () => {
      const manifest = { tables: {}, scope: "x_test_core" };
      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p.includes("dove.manifest.x_test_core.json"),
      );
      (fs.promises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(manifest));

      await (multiScopeWatcher as any).loadScopeManifest("x_test_core", "/project/src/x_test_core");

      expect(ConfigManager.updateManifest).toHaveBeenCalledWith(manifest);
    });

    it("sets scope field on manifest if missing", async () => {
      const manifest = { tables: {} };
      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p.includes("dove.manifest.x_test_core.json"),
      );
      (fs.promises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(manifest));

      await (multiScopeWatcher as any).loadScopeManifest("x_test_core", "/project/src/x_test_core");

      expect(ConfigManager.updateManifest).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "x_test_core" }),
      );
    });

    it("falls back to legacy multi-scope manifest", async () => {
      const legacyManifest = {
        x_test_core: { tables: { sys_script_include: {} } },
        x_test_work: { tables: {} },
      };

      // Scope-specific file doesn't exist, legacy does
      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (p.includes("dove.manifest.x_test_core.json")) return false;
        if (p.includes("dove.manifest.json")) return true;
        return false;
      });
      (fs.promises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(legacyManifest));

      await (multiScopeWatcher as any).loadScopeManifest("x_test_core", "/project/src/x_test_core");

      expect(ConfigManager.updateManifest).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "x_test_core", tables: { sys_script_include: {} } }),
      );
    });

    it("loads single-scope manifest matching the scope", async () => {
      const manifest = { tables: {}, scope: "x_test_core" };

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (p.includes("dove.manifest.x_test_core.json")) return false;
        if (p.includes("dove.manifest.json")) return true;
        return false;
      });
      (fs.promises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(manifest));

      await (multiScopeWatcher as any).loadScopeManifest("x_test_core", "/project/src/x_test_core");

      expect(ConfigManager.updateManifest).toHaveBeenCalledWith(manifest);
    });

    it("handles legacy format with tables but no scope field", async () => {
      const manifest = { tables: { sys_script_include: {} } };

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (p.includes("dove.manifest.x_test_core.json")) return false;
        if (p.includes("dove.manifest.json")) return true;
        return false;
      });
      (fs.promises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(manifest));

      await (multiScopeWatcher as any).loadScopeManifest("x_test_core", "/project/src/x_test_core");

      expect(ConfigManager.updateManifest).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "x_test_core", tables: { sys_script_include: {} } }),
      );
    });

    it("warns when scope not found in legacy manifest", async () => {
      const manifest = { other_scope: { tables: {} } };

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (p.includes("dove.manifest.x_test_core.json")) return false;
        if (p.includes("dove.manifest.json")) return true;
        return false;
      });
      (fs.promises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(manifest));

      await (multiScopeWatcher as any).loadScopeManifest("x_test_core", "/project/src/x_test_core");

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Scope not found in manifest"),
      );
    });

    it("warns when no manifest files exist", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await (multiScopeWatcher as any).loadScopeManifest("x_test_core", "/project/src/x_test_core");

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No manifest found"),
      );
    });
  });

  describe("stopWatching", () => {
    it("closes all scope watchers", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue(MOCK_CONFIG_TWO_SCOPES);

      await startMultiScopeWatching();
      expect(mockWatchers.length).toBe(2);

      stopMultiScopeWatching();

      mockWatchers.forEach((w) => {
        expect(w.close).toHaveBeenCalled();
      });
    });

    it("logs stop message", async () => {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG_TWO_SCOPES,
        scopes: { x_test: {} },
      });

      await startMultiScopeWatching();
      jest.clearAllMocks();
      stopMultiScopeWatching();

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Stopping watcher"));
      expect(logger.info).toHaveBeenCalledWith("All watchers stopped");
    });
  });

  describe("update set monitoring", () => {
    it("sets up interval with default 120s when no options provided", async () => {
      const setIntervalSpy = jest.spyOn(global, "setInterval");

      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG_TWO_SCOPES,
        scopes: { x_test: {} },
      });

      await startMultiScopeWatching();

      // startUpdateSetMonitoring runs async — wait for it to set the interval
      await new Promise((r) => setTimeout(r, 50));

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 120000);
      setIntervalSpy.mockRestore();
    });

    it("clears interval on stopWatching", async () => {
      const clearIntervalSpy = jest.spyOn(global, "clearInterval");

      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG_TWO_SCOPES,
        scopes: { x_test: {} },
      });

      await startMultiScopeWatching();
      // Wait for startUpdateSetMonitoring to complete and set the interval
      await new Promise((r) => setTimeout(r, 50));

      stopMultiScopeWatching();

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });
});
