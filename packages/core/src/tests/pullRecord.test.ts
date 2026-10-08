/**
 * Tests for the per-record pull (`dove pull <table> <sysId>`, TenonHQ/Dovetail#319).
 *
 * The contract under test, straight from the issue's acceptance:
 *   1. a pull on a clean tree produces exactly ONE new record folder and ONE new
 *      manifest key — every other manifest entry stays byte-identical;
 *   2. a record in another scope than --scope fails with a clear message and
 *      writes NOTHING (no content fetch, no file, no manifest);
 *   3. a table the server-side manifest skips (no script/html column, no field
 *      override) still mirrors — metaData.json only — instead of being skipped;
 *   4. re-running is a no-op (idempotent), and planPull alone never writes;
 *   5. --from-update-set expands to the set's per-record captures and skips the
 *      schema / choice-set / DELETE captures with a reason;
 *   6. the CLI never silently no-ops: a stray `-t` and a missing sys_id are errors.
 */

import { SN } from "@tenonhq/dovetail-types";
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
  setLogLevel: jest.fn(),
  getLogLevel: function () { return "warn"; },
};
var mockFileLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

var mockClient = {
  getRecordScope: jest.fn(),
  getManifest: jest.fn(),
  getMissingFiles: jest.fn(),
  getUpdateSetMembers: jest.fn(),
};

jest.mock("../Logger", function () { return { logger: mockLogger }; });
jest.mock("../FileLogger", function () { return { fileLogger: mockFileLogger }; });
jest.mock("../snClient", function () {
  return {
    defaultClient: function () { return mockClient; },
    unwrapSNResponse: function (p: unknown) {
      return Promise.resolve(p).then(function (r: unknown) {
        // Real unwrapSNResponse returns resp.data.result; the mocks resolve the
        // bare result, so pass through.
        return r;
      });
    },
    processPushResponse: jest.fn(),
    retryOnErr: jest.fn(),
    retryOnHttpErr: jest.fn(),
    unwrapTableAPIFirstItem: jest.fn(),
    setBenchmarkSink: jest.fn(),
  };
});

var tmpRoot = "";
var mockConfig = {
  getConfig: jest.fn(),
  getRootDir: jest.fn(function () { return tmpRoot; }),
  getScopeManifestPath: jest.fn(function (scope: string) {
    return path.join(tmpRoot, "dove.manifest." + scope + ".json");
  }),
  getSourcePathForScope: jest.fn(function (scope: string) {
    return path.join(tmpRoot, "src", scope);
  }),
  getSourcePath: jest.fn(function () { return path.join(tmpRoot, "src"); }),
  getManifestPath: jest.fn(function () { return path.join(tmpRoot, "dove.manifest.json"); }),
  resolveConfigForScope: jest.fn(),
  isMultiScopeManifest: jest.fn().mockReturnValue(true),
  updateManifest: jest.fn(),
  getManifest: jest.fn(),
};
jest.mock("../config", function () { return mockConfig; });

import {
  applyPull,
  normalizeSysIds,
  parseManifestText,
  parseUpdateXmlName,
  planPull,
  serializeManifest,
  spliceManifestRecord,
  targetsFromUpdateSet,
} from "../pullRecord";
import { collectTargets, pullRecordCommand } from "../pullRecordCommand";

// ---------- fixtures ----------

const SCOPE = "x_cadso_journey";
const ID_NEW = "94243ee5c3f78f10d4ddf1db050131a6";
const ID_SIB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const ID_OTHER_SCOPE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const ID_META_ONLY = "ccccccccccccccccccccccccccccccc3";

function config() {
  return {
    scopes: { [SCOPE]: { sourceDirectory: "src/" + SCOPE }, x_cadso_core: {} },
    tableOptions: {},
    includes: { _tables: ["sys_script_include", "sys_security_acl"] },
  };
}

function resolvedScope() {
  return {
    tables: ["sys_script_include", "sys_security_acl"],
    fieldOverrides: { sys_script_include: { script: { type: "js" } } },
    apiIncludes: {},
    apiExcludes: {},
    readOnlyTables: [],
  };
}

// The structure-only manifest getManifest returns for the scope: the sibling is
// already mirrored locally; the new ACL is on the instance but not in the repo.
function serverManifest() {
  return {
    scope: SCOPE,
    tables: {
      sys_script_include: {
        records: {
          Sibling: { name: "Sibling", sys_id: ID_SIB, files: [{ name: "script", type: "js" }] },
        },
      },
      sys_security_acl: {
        records: {
          "x_cadso_journey_skill.*": {
            name: "x_cadso_journey_skill.*",
            sys_id: ID_NEW,
            files: [{ name: "script", type: "js" }],
          },
        },
      },
    },
  };
}

function scopeRead(scope: string, cls?: string) {
  return function (table: string, sysId: string) {
    return Promise.resolve({
      sys_id: sysId,
      sys_class_name: cls === undefined ? table : cls,
      sys_scope: { value: "scope-sys-id", link: "x" },
      "sys_scope.scope": scope,
    });
  };
}

function metaContent(table: string, sysId: string, name: string): string {
  return JSON.stringify(
    {
      sys_id: { value: sysId, display_value: sysId },
      name: { value: name, display_value: name },
      sys_updated_on: { value: "2026-10-07 10:00:00", display_value: "2026-10-07 03:00:00" },
      _table: table,
      _sys_id: sysId,
      _name: name,
      _record_link: "https://tenonworkstudio.service-now.com/" + table + ".do?sys_id=" + sysId,
      _lastUpdatedOn: "2026-10-07 10:00:00",
    },
    null,
    2,
  );
}

function bulkDownload(table: string, sysId: string, name: string, files: Array<{ name: string; type: string; content: string }>) {
  const out: Record<string, { records: Record<string, unknown> }> = {};
  out[table] = {
    records: {
      [name]: {
        name,
        sys_id: sysId,
        files: files.concat([{ name: "metaData", type: "json", content: metaContent(table, sysId, name) }]),
      },
    },
  };
  return out;
}

function writeLocalManifest(man: unknown, trailingNewline: boolean) {
  fs.writeFileSync(
    path.join(tmpRoot, "dove.manifest." + SCOPE + ".json"),
    JSON.stringify(man, null, 2) + (trailingNewline ? "\n" : ""),
  );
}

function readLocalManifest(): string {
  return fs.readFileSync(path.join(tmpRoot, "dove.manifest." + SCOPE + ".json"), "utf8");
}

function localManifestWithSibling(): SN.AppManifest {
  return {
    tables: {
      sys_script_include: {
        records: {
          Sibling: { files: [{ name: "script", type: "js" }], name: "Sibling", sys_id: ID_SIB },
        },
      },
    },
    scope: SCOPE,
  };
}

/** Recursive listing of every file under root, relative, with content. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[path.relative(root, p)] = fs.readFileSync(p, "utf8");
    }
  }
  walk(root);
  return out;
}

function seedSibling() {
  const dir = path.join(tmpRoot, "src", SCOPE, "sys_script_include", "Sibling");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "script.js"), "// sibling — must not change");
  fs.writeFileSync(path.join(dir, "metaData.json"), "{}");
}

beforeEach(function () {
  jest.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dove-pull-test-"));
  mockConfig.getConfig.mockReturnValue(config());
  mockConfig.resolveConfigForScope.mockReturnValue(resolvedScope());
  mockClient.getRecordScope.mockImplementation(scopeRead(SCOPE));
  mockClient.getManifest.mockResolvedValue(serverManifest());
  mockClient.getMissingFiles.mockResolvedValue(
    bulkDownload("sys_security_acl", ID_NEW, "x_cadso_journey_skill.*", [
      { name: "script", type: "js", content: "answer = true;" },
    ]),
  );
  process.exitCode = undefined;
});

afterEach(function () {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exitCode = undefined;
});

// ---------- pure helpers ----------

describe("normalizeSysIds", function () {
  test("accepts positional, comma-separated and mixed-case; de-dupes", function () {
    expect(normalizeSysIds([ID_NEW, ID_SIB + "," + ID_NEW.toUpperCase()])).toEqual([ID_NEW, ID_SIB]);
  });
  test("rejects a malformed sys_id before any network call", function () {
    expect(function () { normalizeSysIds(["not-a-sys-id"]); }).toThrow(/not a sys_id/);
  });
  test("empty input → empty list", function () {
    expect(normalizeSysIds(undefined)).toEqual([]);
    expect(normalizeSysIds([undefined, ""])).toEqual([]);
  });
});

describe("parseUpdateXmlName", function () {
  test("parses a per-record capture", function () {
    expect(parseUpdateXmlName("sys_one_extend_capability_" + ID_NEW)).toEqual({
      table: "sys_one_extend_capability",
      sysId: ID_NEW,
    });
  });
  test("ignores schema / choice-set captures", function () {
    expect(parseUpdateXmlName("sys_dictionary_x_cadso_journey_run_status")).toBeUndefined();
    expect(parseUpdateXmlName("sys_db_object_x_cadso_journey_run")).toBeUndefined();
    expect(parseUpdateXmlName("")).toBeUndefined();
  });
});

describe("spliceManifestRecord", function () {
  const entry = { files: [{ name: "script", type: "js" as const }], name: "New", sys_id: ID_NEW };

  test("adds one key and leaves every other entry byte-identical", function () {
    const before = localManifestWithSibling();
    const beforeText = JSON.stringify(before, null, 2);
    const out = spliceManifestRecord(before, SCOPE, "sys_security_acl", entry);
    // input not mutated
    expect(JSON.stringify(before, null, 2)).toBe(beforeText);
    // other table untouched, new table appended, scope kept last
    expect(Object.keys(out)).toEqual(["tables", "scope"]);
    expect(Object.keys(out.tables)).toEqual(["sys_script_include", "sys_security_acl"]);
    expect(JSON.stringify(out.tables.sys_script_include)).toBe(JSON.stringify(before.tables.sys_script_include));
    expect(out.tables.sys_security_acl.records).toEqual({ New: entry });
  });

  test("replaces an entry under the same key in place (order preserved)", function () {
    const man: SN.AppManifest = {
      tables: { sys_script_include: { records: {
        A: { files: [], name: "A", sys_id: "a".repeat(32) },
        Sibling: { files: [], name: "Sibling", sys_id: ID_SIB },
        Z: { files: [], name: "Z", sys_id: "f".repeat(32) },
      } } },
      scope: SCOPE,
    };
    const out = spliceManifestRecord(man, SCOPE, "sys_script_include", {
      files: [{ name: "script", type: "js" }], name: "Sibling", sys_id: ID_SIB,
    });
    expect(Object.keys(out.tables.sys_script_include.records)).toEqual(["A", "Sibling", "Z"]);
    expect(out.tables.sys_script_include.records.Sibling.files).toEqual([{ name: "script", type: "js" }]);
  });

  test("drops the stale key when the record was renamed on the instance", function () {
    const man = localManifestWithSibling();
    const out = spliceManifestRecord(
      man, SCOPE, "sys_script_include",
      { files: [{ name: "script", type: "js" }], name: "Renamed", sys_id: ID_SIB },
      "Sibling",
    );
    expect(Object.keys(out.tables.sys_script_include.records)).toEqual(["Renamed"]);
  });

  test("creates a manifest when none exists", function () {
    const out = spliceManifestRecord(undefined, SCOPE, "sys_security_acl", entry);
    expect(out).toEqual({ tables: { sys_security_acl: { records: { New: entry } } }, scope: SCOPE });
  });
});

describe("parseManifestText / serializeManifest", function () {
  test("detects Dovetail's own formatting and preserves the trailing newline", function () {
    const man = localManifestWithSibling();
    const withNl = parseManifestText(JSON.stringify(man, null, 2) + "\n");
    expect(withNl.formatPreserved).toBe(true);
    expect(withNl.trailingNewline).toBe(true);
    expect(serializeManifest(withNl.manifest!, withNl.trailingNewline)).toBe(JSON.stringify(man, null, 2) + "\n");
    const noNl = parseManifestText(JSON.stringify(man, null, 2));
    expect(noNl.trailingNewline).toBe(false);
  });
  test("flags a manifest that would not round-trip (e.g. tab-indented)", function () {
    const parsed = parseManifestText(JSON.stringify(localManifestWithSibling(), null, "\t"));
    expect(parsed.formatPreserved).toBe(false);
  });
  test("missing file → no manifest, format trivially preserved", function () {
    expect(parseManifestText(undefined)).toEqual({
      manifest: undefined, formatPreserved: true, trailingNewline: false, existed: false,
    });
  });
  test("rejects non-JSON and non-object manifests", function () {
    expect(function () { parseManifestText("{nope"); }).toThrow(/not valid JSON/);
    expect(function () { parseManifestText("[]"); }).toThrow(/not a JSON object/);
  });
});

// ---------- plan + apply ----------

describe("planPull + applyPull — acceptance", function () {
  test("one new folder, one new manifest key, nothing else touched", async function () {
    seedSibling();
    writeLocalManifest(localManifestWithSibling(), true);
    const before = snapshot(tmpRoot);

    const plan = await planPull([{ table: "sys_security_acl", sysId: ID_NEW }], { scope: SCOPE });

    // planPull is read-only
    expect(snapshot(tmpRoot)).toEqual(before);
    expect(plan.records).toHaveLength(1);
    const rec = plan.records[0];
    expect(rec.key).toBe(ID_NEW); // `<table>.*` is unsafe on Windows → sys_id folder, as refresh does
    expect(rec.manifestAction).toBe("add");
    expect(rec.inServerManifest).toBe(true);
    expect(rec.inWhitelist).toBe(true);
    expect(rec.files.map(function (f) { return path.basename(f.path) + ":" + f.action; }))
      .toEqual(["script.js:write", "metaData.json:write"]);
    // content was fetched for exactly this one record, with its server-side file list
    expect(mockClient.getMissingFiles).toHaveBeenCalledTimes(1);
    expect(mockClient.getMissingFiles.mock.calls[0][0]).toEqual({
      sys_security_acl: { [ID_NEW]: [{ name: "script", type: "js" }] },
    });

    const result = await applyPull(plan);
    expect(result.filesWritten).toBe(2);
    expect(result.manifestsWritten).toHaveLength(1);

    const after = snapshot(tmpRoot);
    const changed = Object.keys(after).filter(function (k) { return after[k] !== before[k]; }).sort();
    expect(changed).toEqual([
      "dove.manifest." + SCOPE + ".json",
      path.join("src", SCOPE, "sys_security_acl", ID_NEW, "metaData.json"),
      path.join("src", SCOPE, "sys_security_acl", ID_NEW, "script.js"),
    ]);
    expect(after[path.join("src", SCOPE, "sys_security_acl", ID_NEW, "script.js")]).toBe("answer = true;");

    // metaData is stamped like refresh: host stripped, _lastUpdatedOn gone, datetime display dropped
    const meta = JSON.parse(after[path.join("src", SCOPE, "sys_security_acl", ID_NEW, "metaData.json")]);
    expect(meta._record_link).toBe("/sys_security_acl.do?sys_id=" + ID_NEW);
    expect(meta._lastUpdatedOn).toBeUndefined();
    expect(meta.sys_updated_on).toEqual({ value: "2026-10-07 10:00:00" });

    // the manifest gained exactly one key; the sibling entry is byte-identical; newline kept
    const text = readLocalManifest();
    expect(text.endsWith("\n")).toBe(true);
    const man = JSON.parse(text);
    expect(Object.keys(man.tables)).toEqual(["sys_script_include", "sys_security_acl"]);
    expect(man.tables.sys_security_acl.records).toEqual({
      [ID_NEW]: { files: [{ name: "script", type: "js" }], name: ID_NEW, sys_id: ID_NEW },
    });
    const expected = JSON.parse(before["dove.manifest." + SCOPE + ".json"]);
    expected.tables.sys_security_acl = man.tables.sys_security_acl;
    expect(text).toBe(JSON.stringify(expected, null, 2) + "\n");
  });

  test("re-running is a no-op: every file unchanged, manifest not rewritten", async function () {
    writeLocalManifest(localManifestWithSibling(), false);
    await applyPull(await planPull([{ table: "sys_security_acl", sysId: ID_NEW }]));
    const once = snapshot(tmpRoot);

    const plan = await planPull([{ table: "sys_security_acl", sysId: ID_NEW }]);
    expect(plan.records[0].manifestAction).toBe("unchanged");
    expect(plan.records[0].files.every(function (f) { return f.action === "unchanged"; })).toBe(true);
    const result = await applyPull(plan);
    expect(result.filesWritten).toBe(0);
    expect(result.manifestsWritten).toEqual([]);
    expect(snapshot(tmpRoot)).toEqual(once);
  });

  test("--force rewrites files that already match", async function () {
    await applyPull(await planPull([{ table: "sys_security_acl", sysId: ID_NEW }]));
    const plan = await planPull([{ table: "sys_security_acl", sysId: ID_NEW }], { force: true });
    expect(plan.records[0].files.every(function (f) { return f.action === "write"; })).toBe(true);
  });

  test("creates the scope manifest when the branch has none", async function () {
    const plan = await planPull([{ table: "sys_security_acl", sysId: ID_NEW }]);
    expect(plan.manifests[0].existed).toBe(false);
    await applyPull(plan);
    expect(JSON.parse(readLocalManifest())).toEqual({
      tables: { sys_security_acl: { records: {
        [ID_NEW]: { files: [{ name: "script", type: "js" }], name: ID_NEW, sys_id: ID_NEW },
      } } },
      scope: SCOPE,
    });
  });
});

describe("planPull — scope refusal (writes nothing)", function () {
  test("record in another scope than --scope → clear error, no fetch, no write", async function () {
    writeLocalManifest(localManifestWithSibling(), true);
    const before = snapshot(tmpRoot);
    mockClient.getRecordScope.mockImplementation(scopeRead("x_cadso_core"));

    await expect(
      planPull([{ table: "sys_security_acl", sysId: ID_OTHER_SCOPE }], { scope: SCOPE }),
    ).rejects.toThrow(/belongs to scope 'x_cadso_core', not the requested 'x_cadso_journey'/);

    expect(mockClient.getManifest).not.toHaveBeenCalled();
    expect(mockClient.getMissingFiles).not.toHaveBeenCalled();
    expect(snapshot(tmpRoot)).toEqual(before);
  });

  test("one bad record in a batch refuses the WHOLE batch", async function () {
    mockClient.getRecordScope.mockImplementation(function (table: string, sysId: string) {
      return scopeRead(sysId === ID_OTHER_SCOPE ? "x_cadso_core" : SCOPE)(table, sysId);
    });
    await expect(
      planPull(
        [{ table: "sys_security_acl", sysId: ID_NEW }, { table: "sys_security_acl", sysId: ID_OTHER_SCOPE }],
        { scope: SCOPE },
      ),
    ).rejects.toThrow(/Refusing to pull/);
    expect(mockClient.getMissingFiles).not.toHaveBeenCalled();
  });

  test("record in a scope not declared in dove.config.js → refused", async function () {
    mockClient.getRecordScope.mockImplementation(scopeRead("x_cadso_undeclared"));
    await expect(planPull([{ table: "sys_security_acl", sysId: ID_NEW }]))
      .rejects.toThrow(/not declared in dove.config.js/);
    expect(mockClient.getMissingFiles).not.toHaveBeenCalled();
  });

  test("--scope that is not declared → refused before any read", async function () {
    await expect(planPull([{ table: "sys_security_acl", sysId: ID_NEW }], { scope: "x_nope" }))
      .rejects.toThrow(/--scope 'x_nope' is not declared/);
    expect(mockClient.getRecordScope).not.toHaveBeenCalled();
  });

  test("record not found (404) → named clearly", async function () {
    mockClient.getRecordScope.mockRejectedValue({ response: { status: 404 } });
    await expect(planPull([{ table: "sys_security_acl", sysId: ID_NEW }]))
      .rejects.toThrow(/not found on the instance/);
  });

  test("record read through a parent class → refused, names the real class", async function () {
    mockClient.getRecordScope.mockImplementation(scopeRead(SCOPE, "sys_script_include"));
    await expect(planPull([{ table: "sys_metadata", sysId: ID_NEW }]))
      .rejects.toThrow(/class is 'sys_script_include', not 'sys_metadata'/);
  });

  test("record with no sys_scope needs --scope", async function () {
    mockClient.getRecordScope.mockResolvedValue({ sys_id: ID_NEW, sys_scope: "", "sys_scope.scope": "" });
    await expect(planPull([{ table: "sys_choice", sysId: ID_NEW }]))
      .rejects.toThrow(/carries no sys_scope/);
    // with --scope it is placed there
    mockClient.getMissingFiles.mockResolvedValue(bulkDownload("sys_choice", ID_NEW, "x_cadso_journey_run.status.active", []));
    const plan = await planPull([{ table: "sys_choice", sysId: ID_NEW }], { scope: SCOPE });
    expect(plan.records[0].scope).toBe(SCOPE);
  });
});

describe("planPull — tables the server-side manifest skips", function () {
  test("no script/html column, no override → metaData.json only, with a warning", async function () {
    mockClient.getMissingFiles.mockResolvedValue(
      bulkDownload("sys_one_extend_capability", ID_META_ONLY, "Skill Capability", []),
    );
    const plan = await planPull([{ table: "sys_one_extend_capability", sysId: ID_META_ONLY }]);
    const rec = plan.records[0];
    expect(rec.inServerManifest).toBe(false);
    expect(rec.inWhitelist).toBe(false);
    expect(rec.key).toBe("Skill Capability");
    // asked the server for the record with an EMPTY field list → it still answers with metaData
    expect(mockClient.getMissingFiles.mock.calls[0][0]).toEqual({
      sys_one_extend_capability: { [ID_META_ONLY]: [] },
    });
    expect(rec.files.map(function (f) { return path.basename(f.path); })).toEqual(["metaData.json"]);
    expect(rec.manifestEntry).toEqual({ files: [], name: "Skill Capability", sys_id: ID_META_ONLY });
    expect(rec.warnings.join("\n")).toMatch(/metaData.json only/);
    expect(rec.warnings.join("\n")).toMatch(/not in includes._tables/);

    await applyPull(plan);
    expect(fs.existsSync(path.join(tmpRoot, "src", SCOPE, "sys_one_extend_capability", "Skill Capability", "metaData.json"))).toBe(true);
    expect(JSON.parse(readLocalManifest()).tables.sys_one_extend_capability.records["Skill Capability"].files).toEqual([]);
  });

  test("not in the server manifest but has a field override → override drives the file list", async function () {
    mockConfig.resolveConfigForScope.mockReturnValue(Object.assign(resolvedScope(), {
      fieldOverrides: { x_cadso_journey_action: { configurations: { type: "json" } } },
    }));
    mockClient.getMissingFiles.mockResolvedValue(
      bulkDownload("x_cadso_journey_action", ID_META_ONLY, "Send Email", [
        { name: "configurations", type: "json", content: "{}" },
      ]),
    );
    const plan = await planPull([{ table: "x_cadso_journey_action", sysId: ID_META_ONLY }]);
    expect(mockClient.getMissingFiles.mock.calls[0][0]).toEqual({
      x_cadso_journey_action: { [ID_META_ONLY]: [{ name: "configurations", type: "json" }] },
    });
    expect(plan.records[0].manifestEntry.files).toEqual([{ name: "configurations", type: "json" }]);
  });
});

describe("planPull — renamed record", function () {
  test("replaces the stale key, warns about the old folder", async function () {
    writeLocalManifest({
      tables: { sys_security_acl: { records: {
        OldName: { files: [{ name: "script", type: "js" }], name: "OldName", sys_id: ID_NEW },
      } } },
      scope: SCOPE,
    }, false);
    const plan = await planPull([{ table: "sys_security_acl", sysId: ID_NEW }]);
    expect(plan.records[0].previousKey).toBe("OldName");
    expect(plan.records[0].manifestAction).toBe("update");
    expect(plan.records[0].warnings.join("\n")).toMatch(/renamed on the instance/);
    await applyPull(plan);
    expect(Object.keys(JSON.parse(readLocalManifest()).tables.sys_security_acl.records)).toEqual([ID_NEW]);
  });

  test("a manifest Dovetail did not write is flagged for formatting churn", async function () {
    fs.writeFileSync(
      path.join(tmpRoot, "dove.manifest." + SCOPE + ".json"),
      JSON.stringify(localManifestWithSibling(), null, "\t"),
    );
    const plan = await planPull([{ table: "sys_security_acl", sysId: ID_NEW }]);
    expect(plan.manifests[0].formatPreserved).toBe(false);
    expect(plan.warnings.join("\n")).toMatch(/formatting differs/);
  });
});

describe("planPull — manifest key collisions (never overwrite another sys_id)", function () {
  const TABLE = "sys_one_extend_capability";
  const ID_DUP = "ddddddddddddddddddddddddddddddd4";
  const NAME = "Skill Capability";

  function metaFolder(key: string): string {
    return path.join(tmpRoot, "src", SCOPE, TABLE, key, "metaData.json");
  }

  test("two same-named metaData-only records pulled one after the other → both entries + both folders survive", async function () {
    mockClient.getMissingFiles.mockResolvedValue(bulkDownload(TABLE, ID_META_ONLY, NAME, []));
    await applyPull(await planPull([{ table: TABLE, sysId: ID_META_ONLY }]));

    mockClient.getMissingFiles.mockResolvedValue(bulkDownload(TABLE, ID_DUP, NAME, []));
    const plan = await planPull([{ table: TABLE, sysId: ID_DUP }]);
    const dupKey = NAME + " (" + ID_DUP.substring(0, 8) + ")";
    expect(plan.records[0].key).toBe(dupKey);
    expect(plan.records[0].manifestAction).toBe("add");
    await applyPull(plan);

    const records = JSON.parse(readLocalManifest()).tables[TABLE].records;
    expect(Object.keys(records)).toEqual([NAME, dupKey]);
    expect(records[NAME].sys_id).toBe(ID_META_ONLY);
    expect(records[dupKey]).toEqual({ files: [], name: dupKey, sys_id: ID_DUP });
    expect(JSON.parse(fs.readFileSync(metaFolder(NAME), "utf8"))._sys_id).toBe(ID_META_ONLY);
    expect(JSON.parse(fs.readFileSync(metaFolder(dupKey), "utf8"))._sys_id).toBe(ID_DUP);

    // re-pulling either record is a no-op: the suffixed key is stable
    const again = await planPull([{ table: TABLE, sysId: ID_DUP }]);
    expect(again.records[0].key).toBe(dupKey);
    expect(again.records[0].manifestAction).toBe("unchanged");
    mockClient.getMissingFiles.mockResolvedValue(bulkDownload(TABLE, ID_META_ONLY, NAME, []));
    const first = await planPull([{ table: TABLE, sysId: ID_META_ONLY }]);
    expect(first.records[0].key).toBe(NAME);
    expect(first.records[0].manifestAction).toBe("unchanged");
  });

  test("two same-named metaData-only records in ONE batch → both entries + both folders survive", async function () {
    const a = bulkDownload(TABLE, ID_META_ONLY, NAME, [])[TABLE].records[NAME];
    const b = bulkDownload(TABLE, ID_DUP, NAME, [])[TABLE].records[NAME];
    mockClient.getMissingFiles.mockResolvedValue({ [TABLE]: { records: { [ID_META_ONLY]: a, [ID_DUP]: b } } });

    const plan = await planPull([{ table: TABLE, sysId: ID_META_ONLY }, { table: TABLE, sysId: ID_DUP }]);
    const dupKey = NAME + " (" + ID_DUP.substring(0, 8) + ")";
    expect(plan.records.map(function (r) { return r.key + ":" + r.manifestAction; }))
      .toEqual([NAME + ":add", dupKey + ":add"]);
    await applyPull(plan);

    const records = JSON.parse(readLocalManifest()).tables[TABLE].records;
    expect(Object.keys(records)).toEqual([NAME, dupKey]);
    expect(records[NAME].sys_id).toBe(ID_META_ONLY);
    expect(records[dupKey].sys_id).toBe(ID_DUP);
    expect(JSON.parse(fs.readFileSync(metaFolder(NAME), "utf8"))._sys_id).toBe(ID_META_ONLY);
    expect(JSON.parse(fs.readFileSync(metaFolder(dupKey), "utf8"))._sys_id).toBe(ID_DUP);
  });

  test("a fallback key never takes a key the server manifest gives another record", async function () {
    mockClient.getManifest.mockResolvedValue({
      scope: SCOPE,
      tables: { [TABLE]: { records: { [NAME]: { name: NAME, sys_id: ID_META_ONLY, files: [{ name: "script", type: "js" }] } } } },
    });
    mockClient.getMissingFiles.mockResolvedValue(bulkDownload(TABLE, ID_DUP, NAME, []));
    const plan = await planPull([{ table: TABLE, sysId: ID_DUP }]);
    expect(plan.records[0].key).toBe(NAME + " (" + ID_DUP.substring(0, 8) + ")");
  });

  test("a server-provided key held locally by a DIFFERENT sys_id → refused, points at dove refresh -t, writes nothing", async function () {
    // Local manifest says "Sibling" is ID_SIB; the server now hands "Sibling" to
    // another record (its duplicate-suffix order moved since the last refresh).
    seedSibling();
    writeLocalManifest(localManifestWithSibling(), true);
    const before = snapshot(tmpRoot);
    mockClient.getManifest.mockResolvedValue({
      scope: SCOPE,
      tables: { sys_script_include: { records: {
        Sibling: { name: "Sibling", sys_id: ID_NEW, files: [{ name: "script", type: "js" }] },
      } } },
    });

    await expect(planPull([{ table: "sys_script_include", sysId: ID_NEW }]))
      .rejects.toThrow(/manifest key 'Sibling' already belongs to sys_id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1[\s\S]*dove refresh -t sys_script_include/);
    expect(mockClient.getMissingFiles).not.toHaveBeenCalled();
    expect(snapshot(tmpRoot)).toEqual(before);
  });

  test("spliceManifestRecord refuses to overwrite a key held by a different sys_id", function () {
    expect(function () {
      spliceManifestRecord(localManifestWithSibling(), SCOPE, "sys_script_include", {
        files: [], name: "Sibling", sys_id: ID_NEW,
      });
    }).toThrow(/already belongs to sys_id/);
  });
});

// ---------- --from-update-set ----------

describe("targetsFromUpdateSet", function () {
  const SET = "d".repeat(32);

  test("expands per-record captures, skips schema and DELETE captures, pages", async function () {
    const page1 = [];
    for (let i = 0; i < 1000; i++) {
      page1.push({ sys_id: "x", name: "sys_script_include_" + ("0".repeat(28) + String(1000 + i)).slice(-32), action: "INSERT_OR_UPDATE" });
    }
    const page2 = [
      { sys_id: "y1", name: "sys_security_acl_" + ID_NEW, action: "INSERT_OR_UPDATE" },
      { sys_id: "y2", name: "sys_security_acl_" + ID_NEW, action: "INSERT_OR_UPDATE" }, // duplicate capture
      { sys_id: "y3", name: "sys_dictionary_x_cadso_journey_run_status", action: "INSERT_OR_UPDATE" },
      { sys_id: "y4", name: "sys_script_include_" + ID_SIB, action: "DELETE" },
    ];
    mockClient.getUpdateSetMembers
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const out = await targetsFromUpdateSet(SET);
    expect(mockClient.getUpdateSetMembers).toHaveBeenCalledTimes(2);
    expect(mockClient.getUpdateSetMembers.mock.calls[1][1]).toBe(1000); // offset paged
    expect(out.targets).toHaveLength(1001);
    expect(out.targets[1000]).toEqual({ table: "sys_security_acl", sysId: ID_NEW });
    expect(out.skipped).toEqual([
      "sys_dictionary_x_cadso_journey_run_status (not a per-record capture)",
      "sys_script_include_" + ID_SIB + " (DELETE)",
    ]);
  });

  test("empty set / unknown sys_id → error", async function () {
    mockClient.getUpdateSetMembers.mockResolvedValue([]);
    await expect(targetsFromUpdateSet(SET)).rejects.toThrow(/no customer updates found/);
  });

  test("malformed sys_id → error before any read", async function () {
    await expect(targetsFromUpdateSet("nope")).rejects.toThrow(/not a sys_id/);
    expect(mockClient.getUpdateSetMembers).not.toHaveBeenCalled();
  });
});

// ---------- CLI surface ----------

describe("pullRecordCommand", function () {
  const base = { logLevel: "warn" };

  test("collectTargets composes positional + --sys-ids + --from-update-set", async function () {
    mockClient.getUpdateSetMembers.mockResolvedValue([
      { sys_id: "y", name: "sys_script_include_" + ID_SIB, action: "INSERT_OR_UPDATE" },
    ]);
    const out = await collectTargets(Object.assign({}, base, {
      table: "sys_security_acl",
      sysId: [ID_NEW],
      "sys-ids": ID_OTHER_SCOPE,
      fromUpdateSet: "d".repeat(32),
    }));
    expect(out.targets).toEqual([
      { table: "sys_security_acl", sysId: ID_NEW },
      { table: "sys_security_acl", sysId: ID_OTHER_SCOPE },
      { table: "sys_script_include", sysId: ID_SIB },
    ]);
  });

  test("a table with no sys_id is an error, not a silent no-op", async function () {
    await expect(collectTargets(Object.assign({}, base, { table: "sys_security_acl" })))
      .rejects.toThrow(/give at least one sys_id/);
  });

  test("a stray -t (the refresh spelling) is an error, not a silent no-op", async function () {
    await pullRecordCommand(Object.assign({}, base, { t: "sys_security_acl", fromUpdateSet: "d".repeat(32) }));
    expect(process.exitCode).toBe(1);
    expect(String(mockLogger.error.mock.calls[0][0])).toMatch(/has no -t\/--table flag/);
    expect(mockClient.getUpdateSetMembers).not.toHaveBeenCalled();
  });

  test("--dry-run plans, reports, and writes nothing", async function () {
    const before = snapshot(tmpRoot);
    await pullRecordCommand(Object.assign({}, base, { table: "sys_security_acl", sysId: [ID_NEW], dryRun: true }));
    expect(process.exitCode).toBeUndefined();
    expect(snapshot(tmpRoot)).toEqual(before);
    const lines = mockLogger.info.mock.calls.map(function (c) { return String(c[0]); }).join("\n");
    expect(lines).toMatch(/Dry run/);
    expect(lines).toMatch(/script\.js/);
    expect(lines).toMatch(/metaData\.json/);
    expect(lines).toMatch(/manifest key "94243ee5c3f78f10d4ddf1db050131a6"/);
    expect(lines).toMatch(/would splice 1 entry/);
  });

  test("live run writes and reports success", async function () {
    await pullRecordCommand(Object.assign({}, base, { table: "sys_security_acl", sysId: [ID_NEW] }));
    expect(process.exitCode).toBeUndefined();
    expect(String(mockLogger.success.mock.calls[0][0])).toMatch(/Pulled 1 record\(s\): 2 file\(s\) written/);
    expect(fs.existsSync(path.join(tmpRoot, "src", SCOPE, "sys_security_acl", ID_NEW, "script.js"))).toBe(true);
  });

  test("a refusal exits non-zero with the message", async function () {
    mockClient.getRecordScope.mockImplementation(scopeRead("x_cadso_core"));
    await pullRecordCommand(Object.assign({}, base, { table: "sys_security_acl", sysId: [ID_NEW], scope: SCOPE }));
    expect(process.exitCode).toBe(1);
    expect(String(mockLogger.error.mock.calls[0][0])).toMatch(/belongs to scope 'x_cadso_core'/);
  });
});
