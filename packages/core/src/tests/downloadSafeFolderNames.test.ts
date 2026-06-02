/**
 * Regression: the download / initScopes writer must produce filesystem-SAFE
 * folder names — even when its caller forgets to normalize the manifest first.
 *
 * `processManifestForScope` (allScopesCommands.ts) builds one folder per record.
 * It used to do `record.name || recordName` with no sanitization, so a record
 * whose ServiceNow display name is Windows-illegal — e.g. a sys_ui_script named
 * `x_cadso_core.` (trailing dot) — was written as a literal `x_cadso_core.`
 * folder. Windows forbids trailing dots/spaces in path segments, so Git aborts
 * the whole checkout (`error: invalid path`) and the clone fails for every
 * Windows dev. It only avoided the bug because one caller happened to call
 * normalizeManifestKeys first; any other caller re-introduced it.
 *
 * The writer now normalizes the manifest itself and routes folder names through
 * toSafeFolderName, so an unsafe name falls back to its sys_id (and the manifest
 * is re-keyed to match — preserving the folder ≡ key invariant `dove push`
 * relies on), while a safe name stays human-readable.
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

// ---------- helpers ----------

var tmpRoot: string;
var UI_SYS_ID = "89295b86334983d07b18bc534d5c7b8a";
var SAFE_SYS_ID = "aa11bb22cc33dd44ee55ff6600112233";

function listFolders(table: string): string[] {
  try { return fs.readdirSync(path.join(tmpRoot, table)).sort(); } catch (e) { return []; }
}

describe("download — folder names are filesystem-safe (self-sufficient writer)", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dove-dl-safe-"));
  });

  afterEach(function () {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  test("a trailing-dot record name is written to its sys_id folder, never `x_cadso_core.`", async function () {
    // Manifest keyed by the raw, Windows-illegal display name — i.e. a caller
    // that did NOT pre-normalize. The writer must defend itself.
    var manifest: any = {
      tables: {
        sys_ui_script: {
          records: {
            "x_cadso_core.": {
              name: "x_cadso_core.",
              sys_id: UI_SYS_ID,
              files: [{ name: "script", type: "js", content: "// ui" }],
            },
          },
        },
      },
    };

    await AllScopes.processManifestForScope(manifest, tmpRoot, true);

    var folders = listFolders("sys_ui_script");
    expect(folders).toContain(UI_SYS_ID);
    expect(folders).not.toContain("x_cadso_core.");
    // File landed inside the sys_id folder.
    expect(
      fs.readFileSync(path.join(tmpRoot, "sys_ui_script", UI_SYS_ID, "script.js"), "utf8"),
    ).toBe("// ui");
    // Folder ≡ manifest-key invariant: the manifest was re-keyed to the sys_id
    // so `dove push` (which looks records up by folder name) still resolves it.
    expect(Object.keys(manifest.tables.sys_ui_script.records)).toEqual([UI_SYS_ID]);
  });

  test("a filesystem-safe name stays human-readable (no needless sys_id fallback)", async function () {
    var manifest: any = {
      tables: {
        sys_ui_script: {
          records: {
            "Tenon Shell": {
              name: "Tenon Shell",
              sys_id: SAFE_SYS_ID,
              files: [{ name: "script", type: "js", content: "// shell" }],
            },
          },
        },
      },
    };

    await AllScopes.processManifestForScope(manifest, tmpRoot, true);

    var folders = listFolders("sys_ui_script");
    expect(folders).toContain("Tenon Shell");
    expect(folders).not.toContain(SAFE_SYS_ID);
  });
});
