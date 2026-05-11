import { Sinc } from "@tenonhq/dovetail-types";

// Track how many times the update set config file is read
var configReadCount = 0;
var mockConfigData: Record<string, { sys_id: string; name: string }> = {};

// Per-scope read-only table sets, consumed by the mocked ../config module.
// Mutate this object between tests to drive the push-gate behavior.
var mockReadOnlyByScope: Record<string, Set<string>> = {};

jest.mock("fs", function () {
  var actualFs = jest.requireActual("fs");
  return {
    ...actualFs,
    existsSync: function (p: string) {
      if (typeof p === "string" && p.endsWith(".dove-update-sets.json")) {
        configReadCount++;
        return Object.keys(mockConfigData).length > 0;
      }
      return actualFs.existsSync(p);
    },
    readFileSync: function (p: string, encoding?: string) {
      if (typeof p === "string" && p.endsWith(".dove-update-sets.json")) {
        return JSON.stringify(mockConfigData);
      }
      return actualFs.readFileSync(p, encoding);
    },
  };
});

// Mock only the config surface pushFiles touches. getReadOnlyTablesForScope
// is the one new call site; the rest of pushFiles reads no ConfigManager
// exports, so a minimal mock keeps the test focused on the push gate.
jest.mock("../config", function () {
  return {
    getReadOnlyTablesForScope: function (scope: string): Set<string> {
      return mockReadOnlyByScope[scope] || new Set<string>();
    },
  };
});

// Mock dependencies that pushFiles needs
var mockPushWithUpdateSet = jest.fn().mockResolvedValue({
  data: { result: { status: "success" } },
});
var mockUpdateRecord = jest.fn().mockResolvedValue({
  data: { result: { status: "success" } },
});

jest.mock("../snClient", function () {
  return {
    defaultClient: function () {
      return {
        pushWithUpdateSet: mockPushWithUpdateSet,
        updateRecord: mockUpdateRecord,
      };
    },
    processPushResponse: function (_res: unknown, summary: string) {
      return { success: true, message: summary };
    },
    retryOnErr: function (fn: () => Promise<unknown>) {
      return fn();
    },
    retryOnHttpErr: function (fn: () => Promise<unknown>) {
      return fn();
    },
    unwrapSNResponse: jest.fn(),
    unwrapTableAPIFirstItem: jest.fn(),
    SNClient: jest.fn(),
  };
});

jest.mock("../PluginManager", function () {
  return {
    __esModule: true,
    default: {
      getFinalFileContents: function (ctx: Sinc.FileContext) {
        return Promise.resolve("built-content");
      },
    },
  };
});

jest.mock("../Logger", function () {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      getLogLevel: function () { return "debug"; },
    },
  };
});

jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () {
    return { tick: jest.fn() };
  });
});

function makeRecord(table: string, sysId: string, scope: string): Sinc.BuildableRecord {
  return {
    table: table,
    sysId: sysId,
    fields: {
      script: {
        name: "TestRecord",
        tableName: table,
        targetField: "script",
        ext: "js",
        sys_id: sysId,
        filePath: "/fake/path/script.js",
        scope: scope,
      } as Sinc.FileContext,
    },
  };
}

describe("pushFiles", function () {
  beforeEach(function () {
    configReadCount = 0;
    mockConfigData = {};
    mockReadOnlyByScope = {};
    mockPushWithUpdateSet.mockClear();
    mockUpdateRecord.mockClear();
  });

  it("reads update set config once at batch start, not per record", async function () {
    // Set up config for two scopes
    mockConfigData = {
      "x_cadso_core": { sys_id: "us-core-123", name: "Core US" },
      "x_cadso_work": { sys_id: "us-work-456", name: "Work US" },
    };

    var { pushFiles } = require("../appUtils");

    var records = [
      makeRecord("sys_script_include", "rec1", "x_cadso_core"),
      makeRecord("sys_script_include", "rec2", "x_cadso_work"),
      makeRecord("sys_script_include", "rec3", "x_cadso_core"),
    ];

    await pushFiles(records);

    // Config should be read exactly once (existsSync check at batch start)
    // not 3 times (once per record)
    expect(configReadCount).toBe(1);
  });

  it("does not re-read config mid-batch even with multiple scopes", async function () {
    mockConfigData = {
      "x_cadso_core": { sys_id: "us-core-123", name: "Core US" },
    };

    var { pushFiles } = require("../appUtils");

    var records = [
      makeRecord("sys_script_include", "rec1", "x_cadso_core"),
      makeRecord("sys_script_include", "rec2", "x_cadso_core"),
    ];

    await pushFiles(records);

    // Only 1 read regardless of record count
    expect(configReadCount).toBe(1);
  });

  it("routes records to correct update sets from cached config", async function () {
    mockConfigData = {
      "x_cadso_core": { sys_id: "us-core-123", name: "Core US" },
      "x_cadso_work": { sys_id: "us-work-456", name: "Work US" },
    };

    var { pushFiles } = require("../appUtils");

    var records = [
      makeRecord("sys_script_include", "rec1", "x_cadso_core"),
      makeRecord("sys_script_include", "rec2", "x_cadso_work"),
    ];

    await pushFiles(records);

    // Both should use pushWithUpdateSet with their respective update set IDs
    expect(mockPushWithUpdateSet).toHaveBeenCalledTimes(2);

    var calls = mockPushWithUpdateSet.mock.calls;
    var updateSetIds = calls.map(function (call: unknown[]) { return call[0]; });
    expect(updateSetIds).toContain("us-core-123");
    expect(updateSetIds).toContain("us-work-456");
  });

  it("uses updateRecord when no update set config exists", async function () {
    mockConfigData = {};

    var { pushFiles } = require("../appUtils");

    var records = [
      makeRecord("sys_script_include", "rec1", "x_cadso_core"),
    ];

    await pushFiles(records);

    expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
    expect(mockPushWithUpdateSet).not.toHaveBeenCalled();
  });

  it("skips push for tables listed in _readOnlyTables for the scope", async function () {
    mockConfigData = {};
    mockReadOnlyByScope = {
      x_cadso_core: new Set(["sys_hub_flow"]),
    };

    var { pushFiles } = require("../appUtils");

    var records = [
      makeRecord("sys_hub_flow", "flow1", "x_cadso_core"),
    ];

    var results = await pushFiles(records);

    expect(mockPushWithUpdateSet).not.toHaveBeenCalled();
    expect(mockUpdateRecord).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toContain("skipped (read-only table)");
  });

  it("pushes normally when the scope has no read-only tables", async function () {
    mockConfigData = {};
    mockReadOnlyByScope = {};

    var { pushFiles } = require("../appUtils");

    var records = [
      makeRecord("sys_script_include", "rec1", "x_cadso_core"),
    ];

    await pushFiles(records);

    expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
    expect(mockPushWithUpdateSet).not.toHaveBeenCalled();
  });

  it("in a mixed batch, only non-read-only tables are pushed", async function () {
    mockConfigData = {};
    mockReadOnlyByScope = {
      x_cadso_core: new Set(["sys_hub_flow"]),
    };

    var { pushFiles } = require("../appUtils");

    var records = [
      makeRecord("sys_hub_flow", "flow1", "x_cadso_core"),
      makeRecord("sys_script_include", "rec1", "x_cadso_core"),
      makeRecord("sys_hub_action_instance", "ai1", "x_cadso_core"),
    ];

    var results = await pushFiles(records);

    // Only the read-only flow row is skipped; the other two hit updateRecord.
    expect(mockUpdateRecord).toHaveBeenCalledTimes(2);
    expect(mockPushWithUpdateSet).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);

    var skipped = results.filter(function (r: Sinc.PushResult) {
      return r.message.indexOf("skipped (read-only table)") !== -1;
    });
    expect(skipped).toHaveLength(1);
  });

  it("applies scope-specific read-only tables independently across scopes", async function () {
    mockConfigData = {};
    mockReadOnlyByScope = {
      x_cadso_core: new Set(["sys_hub_flow"]),
      x_cadso_work: new Set<string>(),
    };

    var { pushFiles } = require("../appUtils");

    var records = [
      makeRecord("sys_hub_flow", "flow1", "x_cadso_core"),
      makeRecord("sys_hub_flow", "flow2", "x_cadso_work"),
    ];

    var results = await pushFiles(records);

    // x_cadso_core's flow is blocked; x_cadso_work's flow pushes because it
    // isn't in that scope's read-only set.
    expect(mockUpdateRecord).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);

    var skipped = results.filter(function (r: Sinc.PushResult) {
      return r.message.indexOf("skipped (read-only table)") !== -1;
    });
    expect(skipped).toHaveLength(1);
  });
});
