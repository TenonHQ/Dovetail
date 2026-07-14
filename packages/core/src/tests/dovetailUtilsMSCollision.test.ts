/**
 * Tests the SERVER half of the sync engine — servicenow/dovetail/sys_script_include/
 * DovetailUtilsMS.js — against the record-name collision that silently dropped records.
 *
 * Before the fix, `records` was keyed by display name, so two records sharing a name
 * collapsed into one entry: one vanished from the manifest with no warning, and because
 * the survivor kept the shared folder, a later push to that folder wrote to the WRONG
 * record.
 *
 * This loads the real script include into a sandbox with minimal ServiceNow stubs
 * (Class / GlideRecord / gs) rather than re-implementing the logic, so the test fails if
 * the deployed source regresses. There is no ATF/SN harness in this repo, and this code
 * is deployed to a shared instance — so this is the only gate it gets before deploy.
 *
 * getFileMap() short-circuits when `includes[table]` carries explicit field overrides,
 * which is why no sys_dictionary / TableUtils stub is needed here.
 */

import fs from "fs";
import path from "path";
import vm from "vm";

const SOURCE = path.join(
  __dirname,
  "../../../../servicenow/dovetail/sys_script_include/DovetailUtilsMS.js",
);

interface FakeRecord {
  sys_id: string;
  name: string;
  script?: string;
}

/** Minimal GlideRecord over a fixture list. Only what buildTableMap touches. */
function makeGlideRecord(rows: FakeRecord[]) {
  return function GlideRecordStub(this: any, _table: string) {
    var i = -1;
    this.addQuery = function () {
      return { addOrCondition: function () {} };
    };
    this.addEncodedQuery = function () {};
    this.query = function () {
      i = -1;
    };
    this.next = function () {
      i += 1;
      return i < rows.length;
    };
    this.getValue = function (field: string) {
      return (rows[i] as any)[field];
    };
    this.getDisplayValue = function (field?: string) {
      // No arg → the record's display value (the name). This is what
      // generateRecordName() uses, and it is where the collision comes from.
      return field ? (rows[i] as any)[field] : rows[i].name;
    };
    this.getElements = function () {
      return null; // metaData capture is skipped; getContents is false below
    };
  };
}

function loadUtils(rows: FakeRecord[]) {
  const warnings: string[] = [];
  const sandbox: any = {
    Class: {
      create: function () {
        return function (this: any) {
          if (this.initialize) this.initialize.apply(this, arguments);
        };
      },
    },
    GlideRecord: makeGlideRecord(rows),
    gs: {
      warn: function (msg: string) {
        warnings.push(msg);
      },
      getProperty: function () {
        return "https://example.service-now.com/";
      },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox);

  return { utils: new sandbox.DovetailUtilsMS(), warnings: warnings };
}

function buildMap(rows: FakeRecord[]) {
  const loaded = loadUtils(rows);
  const result = loaded.utils.buildTableMap({
    tableName: "x_cadso_journey_action",
    scopeId: "scope1",
    getContents: false,
    // Explicit field override → getFileMap short-circuits (no sys_dictionary stub).
    includes: { x_cadso_journey_action: { script: { type: "js" } } },
    excludes: {},
    tableOptions: {},
  });
  return { records: result.records, warnings: loaded.warnings };
}

describe("DovetailUtilsMS.buildTableMap — duplicate display names", () => {
  it("keeps BOTH records when two share a display name (regression: one was silently dropped)", () => {
    const out = buildMap([
      { sys_id: "1607d7f0c373f2d0d4ddf1db05013101", name: "Blueprint" },
      { sys_id: "46ae2decc33f32d0d4ddf1db050131d9", name: "Blueprint" },
    ]);

    const keys = Object.keys(out.records);
    expect(keys).toHaveLength(2); // was 1 — the second overwrote the first

    const sysIds = keys.map((k) => out.records[k].sys_id).sort();
    expect(sysIds).toEqual([
      "1607d7f0c373f2d0d4ddf1db05013101",
      "46ae2decc33f32d0d4ddf1db050131d9",
    ]);
  });

  it("suffixes EVERY member of a colliding set, so no record arbitrarily keeps the bare name", () => {
    // If only the later duplicate were suffixed, which record kept "Blueprint" would
    // depend on query order — and folder names would churn between refreshes.
    const out = buildMap([
      { sys_id: "1607d7f0c373f2d0d4ddf1db05013101", name: "Blueprint" },
      { sys_id: "46ae2decc33f32d0d4ddf1db050131d9", name: "Blueprint" },
    ]);

    expect(Object.keys(out.records).sort()).toEqual([
      "Blueprint (1607d7f0)",
      "Blueprint (46ae2dec)",
    ]);
    expect(out.records["Blueprint"]).toBeUndefined();
  });

  it("keeps record.name identical to the map key (writers build the folder path from it)", () => {
    const out = buildMap([
      { sys_id: "1607d7f0c373f2d0d4ddf1db05013101", name: "Blueprint" },
      { sys_id: "46ae2decc33f32d0d4ddf1db050131d9", name: "Blueprint" },
    ]);

    Object.keys(out.records).forEach((key) => {
      expect(out.records[key].name).toBe(key);
    });
  });

  it("warns on a collision instead of dropping silently", () => {
    const out = buildMap([
      { sys_id: "1607d7f0c373f2d0d4ddf1db05013101", name: "Blueprint" },
      { sys_id: "46ae2decc33f32d0d4ddf1db050131d9", name: "Blueprint" },
    ]);

    expect(out.warnings).toHaveLength(2);
    expect(out.warnings[0]).toContain("duplicate display name");
    expect(out.warnings[0]).toContain("Blueprint");
  });

  it("leaves unique names completely untouched (no suffix, no warning)", () => {
    const out = buildMap([
      { sys_id: "dc2ef56133a0e2507b18bc534d5c7bf5", name: "Send Email" },
      { sys_id: "0d4626f933e826507b18bc534d5c7b37", name: "Send Text" },
    ]);

    expect(Object.keys(out.records).sort()).toEqual(["Send Email", "Send Text"]);
    expect(out.warnings).toHaveLength(0);
  });

  it("handles three-way collisions", () => {
    const out = buildMap([
      { sys_id: "aaaaaaaa11111111", name: "Dup" },
      { sys_id: "bbbbbbbb22222222", name: "Dup" },
      { sys_id: "cccccccc33333333", name: "Dup" },
    ]);

    expect(Object.keys(out.records).sort()).toEqual([
      "Dup (aaaaaaaa)",
      "Dup (bbbbbbbb)",
      "Dup (cccccccc)",
    ]);
  });

  it("disambiguates only the colliding set, not the whole table", () => {
    const out = buildMap([
      { sys_id: "aaaaaaaa11111111", name: "Blueprint" },
      { sys_id: "bbbbbbbb22222222", name: "Blueprint" },
      { sys_id: "cccccccc33333333", name: "Send Email" },
    ]);

    expect(Object.keys(out.records).sort()).toEqual([
      "Blueprint (aaaaaaaa)",
      "Blueprint (bbbbbbbb)",
      "Send Email", // untouched — this is why differentiatorField was the wrong tool
    ]);
  });
});
