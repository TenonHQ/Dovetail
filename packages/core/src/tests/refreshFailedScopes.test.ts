/**
 * `dove refresh` must fail loudly when a scope fails.
 *
 * Regression target: against an instance without the sync API, every scope's
 * getManifest returned HTTP 400, each failure was caught and logged inside
 * syncManifest, and refreshCommand still printed "Refresh complete!" and
 * exited 0 — so scripts and CI read a total failure as success.
 *
 * Contract pinned here:
 *   1. An all-scopes refresh keeps going past a failed scope (the rest still
 *      refresh) and returns every failure in `failedScopes`.
 *   2. refreshCommand prints a per-scope failure summary, sets a non-zero exit
 *      code, and does NOT print "Refresh complete!".
 *   3. A clean refresh still prints "Refresh complete!" and leaves the exit
 *      code alone.
 */

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  setLogLevel: jest.fn(),
  getLogLevel: function () { return "info"; },
};

var mockClient = {
  getManifest: jest.fn(),
  getMissingFiles: jest.fn().mockResolvedValue({}),
};

var mockFUtils = {
  writeScopeManifest: jest.fn().mockResolvedValue(undefined),
  writeFileForce: jest.fn().mockResolvedValue(undefined),
  writeSNFileCurry: jest.fn(() => jest.fn().mockResolvedValue(undefined)),
  createDirRecursively: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../Logger", function () { return { logger: mockLogger }; });
jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
});
jest.mock("../FileUtils", function () { return mockFUtils; });
jest.mock("../snClient", function () {
  return {
    defaultClient: function () { return mockClient; },
    unwrapSNResponse: function (p: Promise<unknown>) { return Promise.resolve(p); },
    processPushResponse: jest.fn(),
    retryOnErr: jest.fn(),
    retryOnHttpErr: jest.fn(),
    unwrapTableAPIFirstItem: jest.fn(),
  };
});

var mockConfig = {
  getConfig: jest.fn(),
  getManifest: jest.fn(),
  getSourcePathForScope: jest.fn().mockReturnValue("/tmp/src"),
  getSourcePath: jest.fn().mockReturnValue("/tmp/src"),
  getManifestPath: jest.fn().mockReturnValue("/tmp/dove.manifest.json"),
  resolveConfigForScope: jest.fn().mockReturnValue({
    tables: ["sys_script_include"],
    fieldOverrides: {},
    apiIncludes: {},
    apiExcludes: {},
  }),
  isMultiScopeManifest: jest.fn().mockReturnValue(true),
  updateManifest: jest.fn(),
};
jest.mock("../config", function () { return mockConfig; });
jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () { return { tick: jest.fn() }; });
});

import * as AppUtils from "../appUtils";
import { refreshCommand } from "../commands";

var SCOPES = ["x_cadso_core", "x_cadso_work", "x_cadso_journey"];

function declareScopes(): void {
  var scopes: Record<string, object> = {};
  var manifest: Record<string, object> = {};
  SCOPES.forEach(function (s) {
    scopes[s] = {};
    manifest[s] = { scope: s, tables: {} };
  });
  mockConfig.getConfig.mockReturnValue({ scopes: scopes });
  mockConfig.getManifest.mockResolvedValue(manifest);
}

function errorLines(): Array<string> {
  return mockLogger.error.mock.calls.map(function (c: Array<unknown>) { return String(c[0]); });
}

describe("syncManifest — failed scopes are collected, not swallowed", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    mockConfig.isMultiScopeManifest.mockReturnValue(true);
    declareScopes();
  });

  test("keeps refreshing past a failed scope and reports it", async function () {
    mockClient.getManifest.mockImplementation(function (scope: string) {
      if (scope === "x_cadso_work") {
        return Promise.reject(new Error("HTTP 400 from api/cadso/dovetail_sync/getManifest/x_cadso_work"));
      }
      return Promise.resolve({ scope: scope, tables: {} });
    });

    var result = await AppUtils.syncManifest();

    var attempted = mockClient.getManifest.mock.calls.map(function (c: Array<unknown>) { return c[0]; });
    expect(attempted).toEqual(SCOPES);
    expect(result.failedScopes).toHaveLength(1);
    expect(result.failedScopes[0].scope).toBe("x_cadso_work");
    expect(result.failedScopes[0].error).toContain("HTTP 400");
    // The scopes either side of the failure still wrote their manifests.
    expect(mockFUtils.writeScopeManifest).toHaveBeenCalledTimes(2);
  });

  test("every scope failing reports every scope", async function () {
    mockClient.getManifest.mockRejectedValue(new Error("HTTP 400"));
    var result = await AppUtils.syncManifest();
    expect(result.failedScopes.map(function (f) { return f.scope; })).toEqual(SCOPES);
  });

  test("a clean refresh reports no failures", async function () {
    mockClient.getManifest.mockImplementation(function (scope: string) {
      return Promise.resolve({ scope: scope, tables: {} });
    });
    var result = await AppUtils.syncManifest();
    expect(result.failedScopes).toEqual([]);
  });

  test("a top-level failure (no manifest) is reported too", async function () {
    mockConfig.getManifest.mockResolvedValue(undefined);
    var result = await AppUtils.syncManifest();
    expect(result.failedScopes).toHaveLength(1);
    expect(result.failedScopes[0].error).toContain("No manifest file loaded");
  });
});

describe("refreshCommand — exit code reflects failed scopes", function () {
  var originalExitCode: typeof process.exitCode;

  beforeEach(function () {
    jest.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(function () {
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });

  test("failed scopes → summary, non-zero exit, no 'Refresh complete!'", async function () {
    jest.spyOn(AppUtils, "syncManifest").mockResolvedValue({
      failedScopes: [
        { scope: "x_cadso_core", error: "HTTP 400" },
        { scope: "x_cadso_work", error: "HTTP 400" },
      ],
    });

    await refreshCommand({} as never);

    expect(process.exitCode).toBe(1);
    expect(mockLogger.success).not.toHaveBeenCalled();
    var lines = errorLines();
    expect(lines.some(function (l) { return l.indexOf("2 failed scopes") !== -1; })).toBe(true);
    expect(lines.some(function (l) { return l.indexOf("x_cadso_core: HTTP 400") !== -1; })).toBe(true);
    expect(lines.some(function (l) { return l.indexOf("x_cadso_work: HTTP 400") !== -1; })).toBe(true);
  });

  test("clean refresh → 'Refresh complete!' and exit code untouched", async function () {
    jest.spyOn(AppUtils, "syncManifest").mockResolvedValue({ failedScopes: [] });

    await refreshCommand({} as never);

    expect(process.exitCode).toBeUndefined();
    expect(mockLogger.success).toHaveBeenCalledWith("Refresh complete!");
  });
});
