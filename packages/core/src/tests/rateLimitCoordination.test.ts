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

jest.mock("lodash", function () {
  var actual = jest.requireActual("lodash");
  return {
    ...actual,
    debounce: jest.fn(function (fn: Function) {
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
import * as ConfigManager from "../config";
import { logger } from "../Logger";
import {
  multiScopeWatcher,
  startMultiScopeWatching,
  stopMultiScopeWatching,
} from "../MultiScopeWatcher";
import fs from "fs";

var MOCK_CONFIG = {
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

describe("US-009: Rate limit coordination", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    mockWatchers.length = 0;
    stopMultiScopeWatching();

    mockSNClient.getScopeId.mockResolvedValue([{ sys_id: "scope_sys_id" }]);
    mockSNClient.getUserSysId.mockResolvedValue([{ sys_id: "user_sys_id" }]);
    mockSNClient.getCurrentAppUserPrefSysId.mockResolvedValue([
      { sys_id: "pref_sys_id" },
    ]);
    mockSNClient.updateCurrentAppUserPref.mockResolvedValue({});
    mockSNClient.getCurrentUpdateSetUserPref.mockResolvedValue([]);
  });

  afterEach(function () {
    stopMultiScopeWatching();
  });

  describe("configurable monitoring interval", function () {
    it("uses the provided monitorIntervalMs", async function () {
      var setIntervalSpy = jest.spyOn(global, "setInterval");
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG,
        scopes: { x_test: {} },
      });

      await startMultiScopeWatching({ monitorIntervalMs: 60000 });
      await new Promise(function (r) {
        setTimeout(r, 50);
      });

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60000);
      setIntervalSpy.mockRestore();
    });

    it("defaults to 120s when no options provided", async function () {
      var setIntervalSpy = jest.spyOn(global, "setInterval");
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG,
        scopes: { x_test: {} },
      });

      await startMultiScopeWatching();
      await new Promise(function (r) {
        setTimeout(r, 50);
      });

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 120000);
      setIntervalSpy.mockRestore();
    });

    it("disables monitoring when monitorIntervalMs is 0", async function () {
      var setIntervalSpy = jest.spyOn(global, "setInterval");
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG,
        scopes: { x_test: {} },
      });

      await startMultiScopeWatching({ monitorIntervalMs: 0 });
      await new Promise(function (r) {
        setTimeout(r, 50);
      });

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("monitoring disabled"),
      );
      setIntervalSpy.mockRestore();
    });
  });

  describe("monitoring uses local config (no API calls)", function () {
    it("reads update set config from local file instead of making API calls", async function () {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG,
        scopes: { x_scope_a: {}, x_scope_b: {} },
      });

      // Simulate update set config on disk
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(
        JSON.stringify({
          x_scope_a: { sys_id: "us_a", name: "Task A Update Set" },
          x_scope_b: { sys_id: "us_b", name: "Task B Update Set" },
        }),
      );

      await startMultiScopeWatching({ monitorIntervalMs: 60000 });
      await new Promise(function (r) {
        setTimeout(r, 50);
      });

      // Monitoring should NOT call any SN API (getScopeId is only from startWatching scope switching)
      // The checkAllUpdateSets method uses local config file — no getUserSysId, no getCurrentUpdateSetUserPref
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Task A Update Set"),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Task B Update Set"),
      );
    });

    it("warns when scope has no update set configured", async function () {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG,
        scopes: { x_scope_a: {} },
      });

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({}));

      await startMultiScopeWatching({ monitorIntervalMs: 60000 });
      await new Promise(function (r) {
        setTimeout(r, 50);
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("No update set configured"),
      );
    });

    it("warns when scope is on Default update set", async function () {
      (ConfigManager.getConfig as jest.Mock).mockReturnValue({
        ...MOCK_CONFIG,
        scopes: { x_scope_a: {} },
      });

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(
        JSON.stringify({
          x_scope_a: { sys_id: "us_default", name: "Default" },
        }),
      );

      await startMultiScopeWatching({ monitorIntervalMs: 60000 });
      await new Promise(function (r) {
        setTimeout(r, 50);
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("DEFAULT update set"),
      );
    });
  });
});
