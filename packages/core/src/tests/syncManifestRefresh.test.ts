/**
 * Tests for the refresh content-compare path.
 *
 * Regression target: `npx dove refresh` previously only downloaded files that
 * were absent from disk. Files edited on the ServiceNow instance would never
 * propagate to a developer's local copy — the refresh command silently
 * skipped existing files without checking content.
 *
 * These tests assert:
 *   1. refresh fetches content for EVERY file in the manifest (not just missing)
 *   2. Files whose local content differs are overwritten
 *   3. Files whose local content matches are left alone (no rewrite)
 *   4. Files missing locally are created
 *   5. --force bypasses the content check and writes all files unconditionally
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

// Silence ProgressBar's stdout writes.
jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () {
    return { tick: jest.fn() };
  });
});

// Stub writeScopeManifest so we don't actually write a manifest file. Leave
// the other FileUtils exports (writeSNFileCurry, writeSNFileIfDifferent,
// createDirRecursively, etc.) as real implementations so we can assert
// against the file system.
jest.mock("../FileUtils", function () {
  var actual = jest.requireActual("../FileUtils");
  return Object.assign({}, actual, {
    writeScopeManifest: jest.fn().mockResolvedValue(undefined),
  });
});

import * as AppUtils from "../appUtils";

// ---------- tmp dir scaffolding ----------

var tmpRoot: string;

function setupScope(files: Array<{ record: string; name: string; type: string; content: string }>) {
  // Build a manifest whose single table (sys_script_include) contains the
  // supplied records/files. Content is stripped (manifests do not carry it).
  var records: Record<string, any> = {};
  files.forEach(function (f) {
    if (!records[f.record]) {
      records[f.record] = { name: f.record, sys_id: "sysid_" + f.record, files: [] };
    }
    records[f.record].files.push({ name: f.name, type: f.type });
  });
  return {
    scope: "x_cadso_core",
    tables: {
      sys_script_include: { records: records },
    },
  };
}

function writeLocal(record: string, name: string, type: string, content: string) {
  var recDir = path.join(tmpRoot, "sys_script_include", record);
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, name + "." + type), content);
}

function readLocal(record: string, name: string, type: string): string | null {
  var p = path.join(tmpRoot, "sys_script_include", record, name + "." + type);
  try { return fs.readFileSync(p, "utf8"); } catch (e) { return null; }
}

function statMtime(record: string, name: string, type: string): number {
  var p = path.join(tmpRoot, "sys_script_include", record, name + "." + type);
  return fs.statSync(p).mtimeMs;
}

describe("syncManifest — refresh pulls instance edits down", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sinc-refresh-test-"));
    mockConfig.getSourcePathForScope.mockReturnValue(tmpRoot);
    mockConfig.getSourcePath.mockReturnValue(tmpRoot);
  });

  afterEach(function () {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  test("overwrites existing file when instance content differs", async function () {
    writeLocal("Foo", "script", "js", "var x = 1;"); // stale local

    var manifest = setupScope([{ record: "Foo", name: "script", type: "js", content: "" }]);
    mockClient.getManifest.mockResolvedValue(manifest);
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: {
        records: {
          Foo: {
            name: "Foo",
            sys_id: "sysid_Foo",
            files: [{ name: "script", type: "js", content: "var x = 2; // from instance" }],
          },
        },
      },
    });

    await AppUtils.syncManifest("x_cadso_core");

    expect(mockClient.getMissingFiles).toHaveBeenCalledTimes(1);
    expect(readLocal("Foo", "script", "js")).toBe("var x = 2; // from instance");
  });

  test("does not rewrite a file when content already matches", async function () {
    var identical = "var answer = 42;";
    writeLocal("Bar", "script", "js", identical);
    var beforeMtime = statMtime("Bar", "script", "js");

    var manifest = setupScope([{ record: "Bar", name: "script", type: "js", content: "" }]);
    mockClient.getManifest.mockResolvedValue(manifest);
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: {
        records: {
          Bar: {
            name: "Bar",
            sys_id: "sysid_Bar",
            files: [{ name: "script", type: "js", content: identical }],
          },
        },
      },
    });

    // Give the fs a moment so any write would register a different mtime.
    await new Promise(function (r) { setTimeout(r, 10); });
    await AppUtils.syncManifest("x_cadso_core");

    expect(readLocal("Bar", "script", "js")).toBe(identical);
    expect(statMtime("Bar", "script", "js")).toBe(beforeMtime);
    // metaData should NOT be written when nothing changed in the record
    expect(readLocal("Bar", "metaData", "json")).toBeNull();
  });

  test("creates the file when it is missing locally", async function () {
    var manifest = setupScope([{ record: "Baz", name: "script", type: "js", content: "" }]);
    mockClient.getManifest.mockResolvedValue(manifest);
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: {
        records: {
          Baz: {
            name: "Baz",
            sys_id: "sysid_Baz",
            files: [{ name: "script", type: "js", content: "// fresh file" }],
          },
        },
      },
    });

    await AppUtils.syncManifest("x_cadso_core");

    expect(readLocal("Baz", "script", "js")).toBe("// fresh file");
    expect(readLocal("Baz", "metaData", "json")).not.toBeNull();
  });

  test("--force overwrites even when local content already matches", async function () {
    var identical = "var same = true;";
    writeLocal("Qux", "script", "js", identical);

    var manifest = setupScope([{ record: "Qux", name: "script", type: "js", content: "" }]);
    mockClient.getManifest.mockResolvedValue(manifest);
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: {
        records: {
          Qux: {
            name: "Qux",
            sys_id: "sysid_Qux",
            files: [{ name: "script", type: "js", content: identical }],
          },
        },
      },
    });

    var beforeMtime = statMtime("Qux", "script", "js");
    await new Promise(function (r) { setTimeout(r, 10); });
    await AppUtils.syncManifest("x_cadso_core", { force: true });

    // Force path rewrites regardless — mtime should advance.
    expect(statMtime("Qux", "script", "js")).toBeGreaterThan(beforeMtime);
    expect(readLocal("Qux", "metaData", "json")).not.toBeNull();
  });

  test("bulkDownload is requested for EVERY file in the manifest, not just missing ones", async function () {
    writeLocal("RecA", "script", "js", "local A");
    writeLocal("RecB", "script", "js", "local B");

    var manifest = setupScope([
      { record: "RecA", name: "script", type: "js", content: "" },
      { record: "RecB", name: "script", type: "js", content: "" },
    ]);
    mockClient.getManifest.mockResolvedValue(manifest);
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: {
        records: {
          RecA: {
            name: "RecA", sys_id: "sysid_RecA",
            files: [{ name: "script", type: "js", content: "local A" }],
          },
          RecB: {
            name: "RecB", sys_id: "sysid_RecB",
            files: [{ name: "script", type: "js", content: "local B" }],
          },
        },
      },
    });

    await AppUtils.syncManifest("x_cadso_core");

    expect(mockClient.getMissingFiles).toHaveBeenCalledTimes(1);
    var missingArg = mockClient.getMissingFiles.mock.calls[0][0];
    expect(Object.keys(missingArg.sys_script_include).sort()).toEqual(["sysid_RecA", "sysid_RecB"]);
  });
});

/**
 * `--metadata-only` exists so a mirror can be settled after a change to the
 * metadata writer without the source churn `--force` produces. The guarantee it
 * has to make is narrow and total: the resulting diff is metaData.json and
 * nothing else — no field file, no manifest, no new record directory.
 */
describe("syncManifest — --metadata-only rewrites metadata and nothing else", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sinc-metaonly-test-"));
    mockConfig.getSourcePathForScope.mockReturnValue(tmpRoot);
    mockConfig.getSourcePath.mockReturnValue(tmpRoot);
  });

  afterEach(function () {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  function respondWith(record: string, files: any[]) {
    var records: Record<string, any> = {};
    records[record] = { name: record, sys_id: "sysid_" + record, files: files };
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: { records: records },
    });
  }

  test("rewrites metaData.json even though no field file changed", async function () {
    var identical = "var same = true;";
    writeLocal("Rec", "script", "js", identical);

    mockClient.getManifest.mockResolvedValue(
      setupScope([{ record: "Rec", name: "script", type: "js", content: "" }]),
    );
    respondWith("Rec", [
      { name: "script", type: "js", content: identical },
      {
        name: "metaData",
        type: "json",
        content: JSON.stringify({
          sys_updated_on: { value: "2026-04-29 14:38:51", display_value: "2026-04-29 07:38:51" },
          _record_link: "https://tenonworkstudio.service-now.com/sys_script_include.do?sys_id=1",
          _lastUpdatedOn: "2026-04-29 14:38:51",
        }),
      },
    ]);

    await AppUtils.syncManifest("x_cadso_core", { metadataOnly: true });

    var meta = readLocal("Rec", "metaData", "json");
    expect(meta).not.toBeNull();
    var parsed = JSON.parse(meta as string);
    // Normalized on the way in — the whole reason to regenerate.
    expect(parsed._record_link).toBe("/sys_script_include.do?sys_id=1");
    expect(parsed._lastUpdatedOn).toBeUndefined();
    // datetime display_value is the puller's local timezone — dropped.
    expect(parsed.sys_updated_on).toEqual({ value: "2026-04-29 14:38:51" });
  });

  test("does not touch field files, even when the instance content differs", async function () {
    writeLocal("Rec", "script", "js", "var local = 1;");
    var beforeMtime = statMtime("Rec", "script", "js");

    mockClient.getManifest.mockResolvedValue(
      setupScope([{ record: "Rec", name: "script", type: "js", content: "" }]),
    );
    respondWith("Rec", [
      { name: "script", type: "js", content: "var fromInstance = 2;" },
      { name: "metaData", type: "json", content: JSON.stringify({ sys_id: { value: "1" } }) },
    ]);

    await new Promise(function (r) { setTimeout(r, 10); });
    await AppUtils.syncManifest("x_cadso_core", { metadataOnly: true });

    // Unchanged on disk AND untouched — a rewrite with identical bytes would
    // still be a write, and this mode promises none.
    expect(readLocal("Rec", "script", "js")).toBe("var local = 1;");
    expect(statMtime("Rec", "script", "js")).toBe(beforeMtime);
  });

  test("skips records that are not checked out locally (no orphan directories)", async function () {
    // Writing metaData for a record with no directory would leave a folder
    // holding a lone metaData.json and zero field files.
    //
    // The absent-record check MUST NOT throw. syncManifest swallows errors into
    // logger.error, so an exception here would abort the whole scope while this
    // test's file assertions still passed — "no directory, no metaData" is
    // trivially true when nothing ran. The logger.error assertion is what makes
    // this test real: it caught fUtils.isDirectory rejecting on ENOENT.
    mockClient.getManifest.mockResolvedValue(
      setupScope([{ record: "NotOnDisk", name: "script", type: "js", content: "" }]),
    );
    respondWith("NotOnDisk", [
      { name: "script", type: "js", content: "// new on the instance" },
      { name: "metaData", type: "json", content: JSON.stringify({ sys_id: { value: "1" } }) },
    ]);

    await AppUtils.syncManifest("x_cadso_core", { metadataOnly: true });

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpRoot, "sys_script_include", "NotOnDisk"))).toBe(false);
    expect(readLocal("NotOnDisk", "metaData", "json")).toBeNull();
  });

  test("an absent record does not stop the records that ARE checked out", async function () {
    // The real shape of a metadata-only run: the instance holds records this
    // branch never pulled, interleaved with ones it did. An abort on the first
    // absent record would silently settle only part of the mirror.
    writeLocal("OnDisk", "script", "js", "var x = 1;");

    mockClient.getManifest.mockResolvedValue(
      setupScope([
        { record: "Absent", name: "script", type: "js", content: "" },
        { record: "OnDisk", name: "script", type: "js", content: "" },
      ]),
    );
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: {
        records: {
          Absent: {
            name: "Absent",
            sys_id: "sysid_Absent",
            files: [
              { name: "script", type: "js", content: "// only on the instance" },
              { name: "metaData", type: "json", content: JSON.stringify({ sys_id: { value: "a" } }) },
            ],
          },
          OnDisk: {
            name: "OnDisk",
            sys_id: "sysid_OnDisk",
            files: [
              { name: "script", type: "js", content: "var x = 1;" },
              {
                name: "metaData",
                type: "json",
                content: JSON.stringify({
                  sys_id: { value: "b" },
                  _record_link: "https://tenonworkstudio.service-now.com/x.do?sys_id=b",
                }),
              },
            ],
          },
        },
      },
    });

    await AppUtils.syncManifest("x_cadso_core", { metadataOnly: true });

    expect(mockLogger.error).not.toHaveBeenCalled();
    // The absent one stayed absent...
    expect(fs.existsSync(path.join(tmpRoot, "sys_script_include", "Absent"))).toBe(false);
    // ...and the present one was still settled.
    var meta = readLocal("OnDisk", "metaData", "json");
    expect(meta).not.toBeNull();
    expect(JSON.parse(meta as string)._record_link).toBe("/x.do?sys_id=b");
  });

  test("does not persist the manifest", async function () {
    writeLocal("Rec", "script", "js", "var x = 1;");

    mockClient.getManifest.mockResolvedValue(
      setupScope([{ record: "Rec", name: "script", type: "js", content: "" }]),
    );
    respondWith("Rec", [
      { name: "script", type: "js", content: "var x = 1;" },
      { name: "metaData", type: "json", content: JSON.stringify({ sys_id: { value: "1" } }) },
    ]);

    await AppUtils.syncManifest("x_cadso_core", { metadataOnly: true });

    // A manifest write would put record adds/drops/renames into a diff that is
    // supposed to be metaData.json only.
    expect(mockConfig.updateManifest).not.toHaveBeenCalled();
  });

  test("a plain refresh still persists the manifest (the gate is scoped)", async function () {
    writeLocal("Rec", "script", "js", "var x = 1;");

    mockClient.getManifest.mockResolvedValue(
      setupScope([{ record: "Rec", name: "script", type: "js", content: "" }]),
    );
    respondWith("Rec", [{ name: "script", type: "js", content: "var x = 1;" }]);

    await AppUtils.syncManifest("x_cadso_core");

    expect(mockConfig.updateManifest).toHaveBeenCalled();
  });

  test("writes the deterministic placeholder when the server sends no metadata", async function () {
    writeLocal("Rec", "script", "js", "var x = 1;");

    mockClient.getManifest.mockResolvedValue(
      setupScope([{ record: "Rec", name: "script", type: "js", content: "" }]),
    );
    respondWith("Rec", [{ name: "script", type: "js", content: "var x = 1;" }]);

    await AppUtils.syncManifest("x_cadso_core", { metadataOnly: true });

    expect(readLocal("Rec", "metaData", "json")).toBe(AppUtils.EMPTY_METADATA_CONTENT);
  });
});
