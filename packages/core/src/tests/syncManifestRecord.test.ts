/**
 * Tests for the single-record narrowing of syncManifest — the `record` option
 * used by `dove create`'s post-create round-trip.
 *
 * Regression target: `dove create <table>` previously called syncManifest(scope)
 * with no narrowing, which re-downloaded and rewrote EVERY record in the scope.
 * Creating one record churned ~1,892 files in a scope like x_cadso_text_spoke.
 * The fix scopes the file refresh to just the created record.
 *
 * These tests assert:
 *   1. narrowManifestToRecord returns only the matching record, never mutating input
 *   2. narrowManifestToRecord returns an empty table map when the record is absent
 *   3. syncManifest({ record }) fetches + writes ONLY the target record's files
 *   4. sibling records already on disk are left untouched (never re-fetched)
 *   5. a record absent from the fetched manifest → warn, no fetch, no throw
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------- mocks (must come before importing the module under test) ----------

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  getLogLevel: function () { return "warn"; },
};

var mockFileLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

var mockClient = {
  getManifest: jest.fn(),
  getMissingFiles: jest.fn(),
};

jest.mock("../Logger", function () { return { logger: mockLogger }; });
jest.mock("../FileLogger", function () { return { fileLogger: mockFileLogger }; });
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

var mockConfig: any = {
  getConfig: jest.fn().mockReturnValue({
    scopes: { x_cadso_core: {} },
    tableOptions: {},
  }),
  getManifest: jest.fn().mockResolvedValue({
    x_cadso_core: { scope: "x_cadso_core", tables: {} },
  }),
  getSourcePathForScope: jest.fn(),
  getSourcePath: jest.fn(),
  getManifestPath: jest.fn().mockReturnValue("/tmp/dove.manifest.json"),
  resolveConfigForScope: jest.fn().mockImplementation(function () {
    return {
      tables: ["sys_script_include"],
      fieldOverrides: {},
      apiIncludes: {},
      apiExcludes: {},
    };
  }),
  isMultiScopeManifest: jest.fn().mockReturnValue(true),
  updateManifest: jest.fn(),
};

jest.mock("../config", function () { return mockConfig; });

jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () {
    return { tick: jest.fn() };
  });
});

// Stub writeScopeManifest so the test never writes a manifest file. Leave the
// other FileUtils exports real so we can assert against the file system.
jest.mock("../FileUtils", function () {
  var actual = jest.requireActual("../FileUtils");
  return Object.assign({}, actual, {
    writeScopeManifest: jest.fn().mockResolvedValue(undefined),
  });
});

import * as AppUtils from "../appUtils";

// ---------- fixtures ----------

// A three-record scope manifest, all in sys_script_include, matching the shape
// client.getManifest returns (files carry name+type only; no content).
function threeRecordManifest() {
  return {
    scope: "x_cadso_core",
    tables: {
      sys_script_include: {
        records: {
          New: { name: "New", sys_id: "sysid_New", files: [{ name: "script", type: "js" }] },
          Sib1: { name: "Sib1", sys_id: "sysid_Sib1", files: [{ name: "script", type: "js" }] },
          Sib2: { name: "Sib2", sys_id: "sysid_Sib2", files: [{ name: "script", type: "js" }] },
        },
      },
    },
  };
}

var tmpRoot: string;

function writeLocal(record: string, name: string, type: string, content: string) {
  var recDir = path.join(tmpRoot, "sys_script_include", record);
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, name + "." + type), content);
}

function readLocal(record: string, name: string, type: string): string | null {
  var p = path.join(tmpRoot, "sys_script_include", record, name + "." + type);
  try { return fs.readFileSync(p, "utf8"); } catch (e) { return null; }
}

// ---------- pure helper ----------

describe("narrowManifestToRecord", function () {
  test("returns only the matching record and does NOT mutate the input", function () {
    var manifest: any = threeRecordManifest();
    var out = AppUtils.narrowManifestToRecord(manifest, "sys_script_include", "sysid_New");

    // input untouched — all three records still present
    expect(Object.keys(manifest.tables.sys_script_include.records).sort())
      .toEqual(["New", "Sib1", "Sib2"]);
    // output holds exactly the one record
    expect(Object.keys(out.tables)).toEqual(["sys_script_include"]);
    expect(Object.keys((out.tables as any).sys_script_include.records)).toEqual(["New"]);
    expect((out.tables as any).sys_script_include.records.New.sys_id).toBe("sysid_New");
  });

  test("returns an empty table map when the sys_id is absent", function () {
    var manifest: any = threeRecordManifest();
    var out = AppUtils.narrowManifestToRecord(manifest, "sys_script_include", "sysid_Missing");
    expect(Object.keys(out.tables)).toEqual([]);
  });

  test("returns an empty table map when the table is absent", function () {
    var manifest: any = threeRecordManifest();
    var out = AppUtils.narrowManifestToRecord(manifest, "sys_ui_action", "sysid_New");
    expect(Object.keys(out.tables)).toEqual([]);
  });
});

// ---------- syncManifest({ record }) ----------

describe("syncManifest — single-record round-trip (dove create)", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sinc-record-test-"));
    mockConfig.getSourcePathForScope.mockReturnValue(tmpRoot);
    mockConfig.getSourcePath.mockReturnValue(tmpRoot);
  });

  afterEach(function () {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  test("fetches + writes ONLY the target record; siblings are never re-fetched", async function () {
    // A stale sibling file already on disk — it must be left exactly as-is.
    writeLocal("Sib1", "script", "js", "STALE SIBLING — must not change");

    mockClient.getManifest.mockResolvedValue(threeRecordManifest());
    // getMissingFiles should be asked for the new record ONLY; return its content.
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: {
        records: {
          New: {
            name: "New", sys_id: "sysid_New",
            files: [{ name: "script", type: "js", content: "// fresh created record" }],
          },
        },
      },
    });

    await AppUtils.syncManifest("x_cadso_core", {
      record: { table: "sys_script_include", sysId: "sysid_New" },
    });

    // exactly one content fetch, scoped to the one record
    expect(mockClient.getMissingFiles).toHaveBeenCalledTimes(1);
    var missingArg = mockClient.getMissingFiles.mock.calls[0][0];
    expect(Object.keys(missingArg.sys_script_include)).toEqual(["sysid_New"]);

    // the new record landed
    expect(readLocal("New", "script", "js")).toBe("// fresh created record");
    // siblings untouched
    expect(readLocal("Sib1", "script", "js")).toBe("STALE SIBLING — must not change");
    expect(readLocal("Sib2", "script", "js")).toBeNull();
  });

  test("record absent from the fetched manifest → warn, no fetch, no throw", async function () {
    mockClient.getManifest.mockResolvedValue(threeRecordManifest());

    await AppUtils.syncManifest("x_cadso_core", {
      record: { table: "sys_script_include", sysId: "sysid_DoesNotExist" },
    });

    // empty narrowed manifest → refreshAllFiles no-ops, so no content fetch
    expect(mockClient.getMissingFiles).not.toHaveBeenCalled();
    // and the user is told to run a full refresh
    var warned = mockLogger.warn.mock.calls.some(function (c: any[]) {
      return typeof c[0] === "string" && c[0].indexOf("sysid_DoesNotExist") !== -1;
    });
    expect(warned).toBe(true);
  });
});
