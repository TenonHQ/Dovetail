/**
 * Regression: `dove refresh --metadata-only` must not write the scope manifest.
 *
 * The mode's contract — stated in its CLI help and in CLAUDE.md — is that the
 * resulting git diff is `metaData.json` and nothing else. The first
 * implementation gated `ConfigManager.updateManifest` (the in-MEMORY manifest
 * update) but not `fUtils.writeScopeManifest` (the actual FILE write), so a real
 * run against tenonworkstudio rewrote all 8 `dove.manifest.x_cadso_*.json`
 * files with unrelated record-name disambiguation drift.
 *
 * The companion tests in syncManifestRefresh.test.ts could not catch this: that
 * suite mocks `writeScopeManifest` to a no-op, so nothing there ever observes
 * the write. That mock is why the bug shipped.
 *
 * So this file deliberately leaves FileUtils REAL and asserts against the
 * filesystem — the manifest file on disk must be byte-identical after a
 * metadata-only run, and must still be updated by a plain refresh (proving the
 * gate is scoped, not a blanket disable).
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
    unwrapSNResponse: function (p: any) { return Promise.resolve(p); },
    processPushResponse: jest.fn(),
    retryOnErr: jest.fn(),
    retryOnHttpErr: jest.fn(),
    unwrapTableAPIFirstItem: jest.fn(),
  };
});

var manifestPath = "";

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
  getManifestPath: jest.fn(function () { return manifestPath; }),
  // The real writeScopeManifest resolves its target through this.
  getScopeManifestPath: jest.fn(function () { return manifestPath; }),
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
  return jest.fn().mockImplementation(function () {
    return { tick: jest.fn() };
  });
});

// NOTE: FileUtils is deliberately NOT mocked. Stubbing writeScopeManifest is
// exactly what hid this bug.

import * as AppUtils from "../appUtils";

// ---------- scaffolding ----------

var tmpRoot: string;

var SENTINEL = JSON.stringify({ tables: { sentinel: "untouched" } }, null, 2);

function writeLocalRecord(record: string, content: string) {
  var recDir = path.join(tmpRoot, "sys_script_include", record);
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, "script.js"), content);
}

function serverResponse(record: string, scriptContent: string) {
  var records: Record<string, any> = {};
  records[record] = {
    name: record,
    sys_id: "sysid_" + record,
    files: [
      { name: "script", type: "js", content: scriptContent },
      {
        name: "metaData",
        type: "json",
        content: JSON.stringify({
          sys_updated_on: { value: "2026-04-29 14:38:51" },
          _record_link: "https://tenonworkstudio.service-now.com/x.do?sys_id=1",
        }),
      },
    ],
  };
  return { sys_script_include: { records: records } };
}

describe("--metadata-only does not write the scope manifest (real FileUtils)", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dove-manifest-gate-"));
    manifestPath = path.join(tmpRoot, "dove.manifest.x_cadso_core.json");
    fs.writeFileSync(manifestPath, SENTINEL);
    mockConfig.getSourcePathForScope.mockReturnValue(tmpRoot);
    mockConfig.getSourcePath.mockReturnValue(tmpRoot);

    // The manifest the "instance" returns differs from the sentinel on disk, so
    // any write at all is detectable.
    mockClient.getManifest.mockResolvedValue({
      scope: "x_cadso_core",
      tables: {
        sys_script_include: {
          records: {
            Rec: { name: "Rec", sys_id: "sysid_Rec", files: [{ name: "script", type: "js" }] },
          },
        },
      },
    });
    mockClient.getMissingFiles.mockResolvedValue(serverResponse("Rec", "var x = 1;"));
  });

  afterEach(function () {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  test("leaves the manifest file byte-identical", async function () {
    writeLocalRecord("Rec", "var x = 1;");

    await AppUtils.syncManifest("x_cadso_core", { metadataOnly: true });

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(SENTINEL);
  });

  test("still rewrites the record's metaData.json (the gate is narrow)", async function () {
    writeLocalRecord("Rec", "var x = 1;");

    await AppUtils.syncManifest("x_cadso_core", { metadataOnly: true });

    var meta = fs.readFileSync(
      path.join(tmpRoot, "sys_script_include", "Rec", "metaData.json"),
      "utf8",
    );
    expect(JSON.parse(meta)._record_link).toBe("/x.do?sys_id=1");
  });

  test("a plain refresh DOES write the manifest", async function () {
    // Proves the gate is conditional, not a blanket disable — without this a
    // hard-coded skip would pass the test above.
    writeLocalRecord("Rec", "var x = 1;");

    await AppUtils.syncManifest("x_cadso_core");

    expect(fs.readFileSync(manifestPath, "utf8")).not.toBe(SENTINEL);
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).tables).toHaveProperty(
      "sys_script_include",
    );
  });
});
