/**
 * Tests for the scope + table whitelist gates in syncManifest() and
 * processTablesInManifest().
 *
 * Regression target: 2026-04-14 sys_alias debris incident.
 *  - `npx dove refresh` iterated every scope in the persisted multi-scope
 *    manifest, including scopes not declared in dove.config.js.
 *  - For each of those scopes, the server-side getManifest response returned
 *    hundreds of tables (up to 129 for x_cadso_work) that the config _tables
 *    whitelist never authorised, and the client wrote all of them to disk —
 *    including sys_alias/sys_alias_templates folders with 314 field files per
 *    record (fan-out of every script/html/css/xml field config across tables).
 *
 * These tests assert the two defensive filters:
 *   1. Undeclared scopes are skipped before any REST call.
 *   2. Tables not in the _tables whitelist are filtered from the manifest
 *      before writeScopeManifest / processMissingFiles run.
 */

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  getLogLevel: function () { return "info"; },
};

var mockFileLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

var mockClient = {
  getManifest: jest.fn(),
  // refreshAllFiles asks for file content per table. Returning {} means "no
  // files to write", which keeps these tests off the plugin/write path while
  // still recording WHICH tables were asked for.
  getMissingFiles: jest.fn().mockResolvedValue({}),
};

var mockFUtils = {
  writeScopeManifest: jest.fn().mockResolvedValue(undefined),
  writeFileForce: jest.fn().mockResolvedValue(undefined),
  writeSNFileCurry: jest.fn(() => jest.fn().mockResolvedValue(undefined)),
  createDirRecursively: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../Logger", function () { return { logger: mockLogger }; });
jest.mock("../FileLogger", function () { return { fileLogger: mockFileLogger }; });
jest.mock("../FileUtils", function () { return mockFUtils; });
jest.mock("../snClient", function () {
  return {
    defaultClient: function () { return mockClient; },
    unwrapSNResponse: function (p: any) { return Promise.resolve(p).then(function (r: any) { return r; }); },
    processPushResponse: jest.fn(),
    retryOnErr: jest.fn(),
    retryOnHttpErr: jest.fn(),
    unwrapTableAPIFirstItem: jest.fn(),
  };
});

// Mock config module. Individual tests override getConfig/getManifest/etc.
var mockConfig: any = {
  getConfig: jest.fn(),
  getManifest: jest.fn(),
  getSourcePathForScope: jest.fn().mockReturnValue("/tmp/src"),
  getSourcePath: jest.fn().mockReturnValue("/tmp/src"),
  getManifestPath: jest.fn().mockReturnValue("/tmp/dove.manifest.json"),
  resolveConfigForScope: jest.fn(),
  isMultiScopeManifest: jest.fn().mockReturnValue(true),
  updateManifest: jest.fn(),
};

jest.mock("../config", function () { return mockConfig; });

// Prevent processMissingFiles' progress bar from touching stdout in tests.
jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () {
    return { tick: jest.fn() };
  });
});

// Keep the per-scope progress shim simple.
jest.mock("../genericUtils", function () {
  var actual = jest.requireActual("../genericUtils");
  return actual;
});

import * as AppUtils from "../appUtils";

describe("syncManifest — scope + table whitelist gates", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    mockConfig.isMultiScopeManifest.mockReturnValue(true);
    mockConfig.resolveConfigForScope.mockImplementation(function (_scope: string) {
      return {
        tables: ["sys_script_include", "sys_script", "sys_ux_macroponent"],
        fieldOverrides: {},
        apiIncludes: {},
        apiExcludes: {},
      };
    });
  });

  test("skips undeclared scope — no REST call, warn logged", async function () {
    mockConfig.getConfig.mockReturnValue({
      scopes: { x_cadso_core: {}, x_cadso_work: {} },
    });
    mockConfig.getManifest.mockResolvedValue({
      x_cadso_core: { scope: "x_cadso_core", tables: {} },
      x_cadso_click: { scope: "x_cadso_click", tables: {} }, // stale undeclared
    });

    await AppUtils.syncManifest("x_cadso_click");

    expect(mockClient.getManifest).not.toHaveBeenCalled();
    expect(mockFUtils.writeScopeManifest).not.toHaveBeenCalled();
    var warnedAboutScope = mockLogger.warn.mock.calls.some(function (args) {
      return typeof args[0] === "string" && args[0].indexOf("x_cadso_click") !== -1;
    });
    expect(warnedAboutScope).toBe(true);
  });

  test("declared scope — filters non-whitelisted tables before write", async function () {
    mockConfig.getConfig.mockReturnValue({
      scopes: { x_cadso_core: {} },
    });
    mockConfig.getManifest.mockResolvedValue({
      x_cadso_core: { scope: "x_cadso_core", tables: {} },
    });

    // Server returns two whitelisted tables + sys_alias (not whitelisted).
    mockClient.getManifest.mockResolvedValue({
      scope: "x_cadso_core",
      tables: {
        sys_script_include: { records: { FooInclude: { name: "FooInclude", sys_id: "a1", files: [] } } },
        sys_script: { records: { BarBR: { name: "BarBR", sys_id: "a2", files: [] } } },
        sys_alias: { records: { DebrisRec: { name: "DebrisRec", sys_id: "a3", files: [] } } },
      },
    });

    await AppUtils.syncManifest("x_cadso_core");

    expect(mockClient.getManifest).toHaveBeenCalledWith("x_cadso_core", expect.any(Object));
    expect(mockFUtils.writeScopeManifest).toHaveBeenCalledTimes(1);

    var writtenScope = mockFUtils.writeScopeManifest.mock.calls[0][0];
    var writtenManifest = mockFUtils.writeScopeManifest.mock.calls[0][1];
    expect(writtenScope).toBe("x_cadso_core");
    var writtenTables = Object.keys(writtenManifest.tables);
    expect(writtenTables).toContain("sys_script_include");
    expect(writtenTables).toContain("sys_script");
    expect(writtenTables).not.toContain("sys_alias");
  });

  test("no-scope call iterates only declared scopes, even when manifest has stale ones", async function () {
    mockConfig.getConfig.mockReturnValue({
      scopes: { x_cadso_core: {}, x_cadso_work: {} },
    });
    // Persisted multi-scope manifest still carries stale undeclared scopes.
    mockConfig.getManifest.mockResolvedValue({
      x_cadso_core: { scope: "x_cadso_core", tables: {} },
      x_cadso_work: { scope: "x_cadso_work", tables: {} },
      x_cadso_click: { scope: "x_cadso_click", tables: {} },
      x_nuvo_sinc: { scope: "x_nuvo_sinc", tables: {} },
      x_cadso_ti_agile: { scope: "x_cadso_ti_agile", tables: {} },
    });
    mockClient.getManifest.mockImplementation(function (scope: string) {
      return Promise.resolve({ scope: scope, tables: {} });
    });

    await AppUtils.syncManifest();

    var refreshedScopes = mockClient.getManifest.mock.calls.map(function (c: any[]) { return c[0]; });
    expect(refreshedScopes.sort()).toEqual(["x_cadso_core", "x_cadso_work"]);
    expect(refreshedScopes).not.toContain("x_cadso_click");
    expect(refreshedScopes).not.toContain("x_nuvo_sinc");
    expect(refreshedScopes).not.toContain("x_cadso_ti_agile");
  });
});

/**
 * `dove refresh --table` narrows the FILE refresh only.
 *
 * The load-bearing invariant is that the PERSISTED manifest stays complete:
 * narrowing dove.manifest.<scope>.json to the requested table would drop every
 * other table from it and break push/watch. These tests exist so that a future
 * "optimization" that narrows newManifest fails loudly instead of silently
 * corrupting the manifest.
 */
describe("syncManifest — --table filter", function () {
  function recordWithFile(name: string, sysId: string) {
    return { records: { [name]: { name: name, sys_id: sysId, files: [{ name: "script", type: "js" }] } } };
  }

  beforeEach(function () {
    jest.clearAllMocks();
    mockClient.getMissingFiles.mockResolvedValue({});
    mockConfig.isMultiScopeManifest.mockReturnValue(true);
    mockConfig.resolveConfigForScope.mockImplementation(function (_scope: string) {
      return {
        tables: ["sys_script_include", "sys_script", "sys_ux_macroponent"],
        fieldOverrides: {},
        apiIncludes: {},
        apiExcludes: {},
      };
    });
    mockConfig.getConfig.mockReturnValue({ scopes: { x_cadso_core: {} } });
    mockConfig.getManifest.mockResolvedValue({
      x_cadso_core: { scope: "x_cadso_core", tables: {} },
    });
    mockClient.getManifest.mockResolvedValue({
      scope: "x_cadso_core",
      tables: {
        sys_script_include: recordWithFile("FooInclude", "a1"),
        sys_script: recordWithFile("BarBR", "a2"),
        sys_ux_macroponent: recordWithFile("BazComp", "a3"),
      },
    });
  });

  test("does NOT narrow the persisted manifest — all whitelisted tables still written", async function () {
    await AppUtils.syncManifest("x_cadso_core", { tables: ["sys_script"] });

    expect(mockFUtils.writeScopeManifest).toHaveBeenCalledTimes(1);
    var writtenTables = Object.keys(mockFUtils.writeScopeManifest.mock.calls[0][1].tables);
    // The manifest keeps every whitelisted table, not just the requested one.
    expect(writtenTables.sort()).toEqual([
      "sys_script",
      "sys_script_include",
      "sys_ux_macroponent",
    ]);
  });

  test("narrows the file refresh to the requested tables only", async function () {
    await AppUtils.syncManifest("x_cadso_core", { tables: ["sys_script"] });

    expect(mockClient.getMissingFiles).toHaveBeenCalledTimes(1);
    var askedFor = Object.keys(mockClient.getMissingFiles.mock.calls[0][0]);
    expect(askedFor).toEqual(["sys_script"]);
  });

  test("refreshes every table when no --table filter is given", async function () {
    await AppUtils.syncManifest("x_cadso_core", {});

    var askedFor = Object.keys(mockClient.getMissingFiles.mock.calls[0][0]);
    expect(askedFor.sort()).toEqual([
      "sys_script",
      "sys_script_include",
      "sys_ux_macroponent",
    ]);
  });

  test("a scope holding none of the requested tables still writes its manifest, but refreshes no files", async function () {
    await AppUtils.syncManifest("x_cadso_core", { tables: ["sys_ui_action"] });

    // Manifest untouched-in-full …
    expect(mockFUtils.writeScopeManifest).toHaveBeenCalledTimes(1);
    expect(Object.keys(mockFUtils.writeScopeManifest.mock.calls[0][1].tables)).toHaveLength(3);
    // … and not a single file downloaded.
    expect(mockClient.getMissingFiles).not.toHaveBeenCalled();
  });
});

describe("narrowManifestToTables", function () {
  var manifest: any;

  beforeEach(function () {
    manifest = {
      scope: "x_cadso_core",
      tables: {
        sys_script: { records: {} },
        sys_script_include: { records: {} },
      },
    };
  });

  test("returns the SAME manifest when no tables are requested", function () {
    expect(AppUtils.narrowManifestToTables(manifest, undefined)).toBe(manifest);
    expect(AppUtils.narrowManifestToTables(manifest, [])).toBe(manifest);
  });

  test("returns a NEW manifest and never mutates the input", function () {
    var narrowed = AppUtils.narrowManifestToTables(manifest, ["sys_script"]);

    expect(narrowed).not.toBe(manifest);
    expect(Object.keys(narrowed.tables)).toEqual(["sys_script"]);
    // The corruption guard: the caller still writes `manifest` to disk in full.
    expect(Object.keys(manifest.tables).sort()).toEqual([
      "sys_script",
      "sys_script_include",
    ]);
  });

  test("yields an empty table map when nothing matches", function () {
    var narrowed = AppUtils.narrowManifestToTables(manifest, ["sys_ui_action"]);
    expect(Object.keys(narrowed.tables)).toEqual([]);
    expect(narrowed.scope).toBe("x_cadso_core");
  });

  test("ignores requested tables the scope does not hold", function () {
    var narrowed = AppUtils.narrowManifestToTables(manifest, ["sys_script", "sys_ui_action"]);
    expect(Object.keys(narrowed.tables)).toEqual(["sys_script"]);
  });
});
