/**
 * Regression: the all-scopes writer must normalize metaData.json, exactly like
 * the `refresh` path does.
 *
 * `processManifestForScope` (allScopesCommands.ts) is what `dove initScopes` and
 * `dove watchAllScopes` write through. It used to `fsp.writeFile` every server
 * file verbatim, so on that path metaData.json kept the server's raw payload:
 *
 *   - `_record_link` with the full `https://<instance>.service-now.com` host,
 *     making the on-disk artifact instance-bound — re-pull from another instance
 *     and every file rewrites;
 *   - every field's live `display_value`, which is resolved server-side at pull
 *     time, so renaming one referenced record re-churns every file pointing at
 *     it (and timestamp display_values render in the *puller's* timezone, so two
 *     developers churn each other);
 *
 * and when the server sent no metadata at all it wrote a stub stamped
 * `_generatedAt: new Date().toISOString()` — a value that changed on every run,
 * by construction.
 *
 * The result: records written here diffed against the same records written by
 * `refresh`, and a pull that changed nothing still dirtied the tree. The writer
 * now routes every file through the shared `stampMetadataContent` and writes a
 * deterministic placeholder instead of the timestamp stub.
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

jest.mock("../Logger", function () { return { logger: mockLogger }; });
jest.mock("../FileLogger", function () { return { fileLogger: mockFileLogger }; });
jest.mock("../config", function () { return {}; });
jest.mock("../snClient", function () {
  return {
    defaultClient: function () { return {}; },
    unwrapSNResponse: function (p: any) { return Promise.resolve(p); },
  };
});
jest.mock("../wizard", function () {
  return { setupDotEnv: jest.fn(), getLoginInfo: jest.fn() };
});
jest.mock("../commands", function () { return { setLogLevel: jest.fn() }; });
jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () {
    return { tick: jest.fn() };
  });
});

import * as AllScopes from "../allScopesCommands";
import { EMPTY_METADATA_CONTENT } from "../appUtils";

// ---------- helpers ----------

var tmpRoot: string;
var SYS_ID = "24a3a804c3eb7250d4ddf1db05013165";
var ISO_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** The metaData.json payload a real instance returns: absolute link, display_values. */
function serverMetadata(): string {
  return JSON.stringify({
    name: { value: "UIFilterApiMS", display_value: "UIFilterApiMS" },
    sys_updated_on: {
      value: "2026-04-29 14:38:51",
      // Rendered in the puller's local timezone — the churn source.
      display_value: "2026-04-29 07:38:51",
    },
    sys_scope: {
      value: "4e4449a5475c255085d19fd8036d43a0",
      display_value: "Tenon Marketing Work Management",
    },
    // A plain reference — kept, so the sys_id -> name mapping survives.
    action: {
      value: "85de623c33ef2a107b18bc534d5c7b92",
      display_value: "Parse hashes for to_addresses",
    },
    _table: "sys_script_include",
    _sys_id: SYS_ID,
    _record_link:
      "https://tenonworkstudio.service-now.com/sys_script_include.do?sys_id=" + SYS_ID,
    _localOnly: true,
    _lastUpdatedOn: "2026-04-29 14:38:51",
    _description: "Complete field metadata for record - DO NOT SYNC TO SERVICENOW",
  });
}

function manifestWith(files: any[]): any {
  return {
    tables: {
      sys_script_include: {
        records: {
          UIFilterApiMS: { name: "UIFilterApiMS", sys_id: SYS_ID, files: files },
        },
      },
    },
  };
}

function readRecordFile(name: string): string {
  return fs.readFileSync(
    path.join(tmpRoot, "sys_script_include", "UIFilterApiMS", name),
    "utf8",
  );
}

describe("all-scopes writer — metaData.json is normalized, not written raw", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dove-allscopes-meta-"));
  });

  afterEach(function () {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  test("strips the instance host from _record_link", async function () {
    await AllScopes.processManifestForScope(
      manifestWith([{ name: "metaData", type: "json", content: serverMetadata() }]),
      tmpRoot,
      true,
    );

    var written = JSON.parse(readRecordFile("metaData.json"));
    expect(written._record_link).toBe("/sys_script_include.do?sys_id=" + SYS_ID);
    expect(readRecordFile("metaData.json")).not.toContain("service-now.com");
  });

  test("applies the selective display_value policy, same as the refresh path", async function () {
    await AllScopes.processManifestForScope(
      manifestWith([{ name: "metaData", type: "json", content: serverMetadata() }]),
      tmpRoot,
      true,
    );

    var written = JSON.parse(readRecordFile("metaData.json"));
    // Dropped: identical, datetime (puller's timezone), sys_scope (whole-tree).
    expect(written.name).toEqual({ value: "UIFilterApiMS" });
    expect(written.sys_updated_on).toEqual({ value: "2026-04-29 14:38:51" });
    expect(written.sys_scope).toEqual({ value: "4e4449a5475c255085d19fd8036d43a0" });
    // Kept: the readable reference name.
    expect(written.action).toEqual({
      value: "85de623c33ef2a107b18bc534d5c7b92",
      display_value: "Parse hashes for to_addresses",
    });
  });

  test("drops _lastUpdatedOn and writes no wall-clock value", async function () {
    await AllScopes.processManifestForScope(
      manifestWith([{ name: "metaData", type: "json", content: serverMetadata() }]),
      tmpRoot,
      true,
    );

    var raw = readRecordFile("metaData.json");
    expect(JSON.parse(raw)._lastUpdatedOn).toBeUndefined();
    expect(raw).not.toMatch(ISO_STAMP);
  });

  test("two runs over the same server payload produce identical bytes", async function () {
    // The contract in one assertion: a pull that changed nothing changes nothing.
    await AllScopes.processManifestForScope(
      manifestWith([{ name: "metaData", type: "json", content: serverMetadata() }]),
      tmpRoot,
      true,
    );
    var first = readRecordFile("metaData.json");

    await AllScopes.processManifestForScope(
      manifestWith([{ name: "metaData", type: "json", content: serverMetadata() }]),
      tmpRoot,
      true,
    );
    expect(readRecordFile("metaData.json")).toBe(first);
  });

  test("writes the deterministic placeholder when the server sends no metadata", async function () {
    await AllScopes.processManifestForScope(
      manifestWith([{ name: "script", type: "js", content: "// no metadata came back" }]),
      tmpRoot,
      true,
    );

    var raw = readRecordFile("metaData.json");
    expect(raw).toBe(EMPTY_METADATA_CONTENT);
    // The old stub's two churn keys are gone.
    expect(raw).not.toContain("_generatedAt");
    expect(raw).not.toMatch(ISO_STAMP);
  });

  test("leaves regular field files untouched", async function () {
    // stampMetadataContent must be a no-op on anything that isn't metaData.json.
    await AllScopes.processManifestForScope(
      manifestWith([
        { name: "script", type: "js", content: "var x = 1;\n" },
        { name: "metaData", type: "json", content: serverMetadata() },
      ]),
      tmpRoot,
      true,
    );

    expect(readRecordFile("script.js")).toBe("var x = 1;\n");
  });
});
