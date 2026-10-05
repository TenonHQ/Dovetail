/**
 * Tests the SERVER half of the sync engine — servicenow/dovetail/sys_script_include/
 * DovetailUtilsMS.js — for the two table options that make platform-config tables
 * syncable per scope:
 *
 *  - `scopeQuery`: sys_choice rows carry NO sys_scope (verified on tenonworkstudio:
 *    `sys_scopeISEMPTY` returns every x_cadso_automate_* choice), so the table is never
 *    a sys_metadata child of any app — getTableNames can't discover it and the
 *    sys_scope filter in buildTableMap would return zero rows. scopeQuery replaces that
 *    filter with an encoded query ("nameSTARTSWITH{scope}_") and lists the table.
 *  - `nameTemplate`: sys_choice.label / sys_dictionary.column_label collide across tables
 *    and fields, so the display-value folder name would be "Failed (1a2b3c4d)" ×N.
 *    "{name}.{element}.{value}" names the folder from the fields that ARE unique.
 *
 * Same sandbox approach as dovetailUtilsMSCollision.test.ts: the real script include is
 * loaded with minimal ServiceNow stubs so the test fails if the deployed source regresses.
 */

import fs from "fs";
import path from "path";
import vm from "vm";

const SOURCE = path.join(
  __dirname,
  "../../../../servicenow/dovetail/sys_script_include/DovetailUtilsMS.js",
);

interface FakeRow {
  sys_id: string;
  [field: string]: string | undefined;
}

interface Captured {
  encodedQueries: string[];
  fieldQueries: Array<{ field: string; value: string }>;
}

/**
 * GlideRecord stub over a fixture list. Records the queries it receives so a test can
 * assert WHICH filter buildTableMap applied (sys_scope vs the rendered scopeQuery).
 * `validFields` controls isValidField — sys_choice has no sys_class_name column.
 */
function makeGlideRecord(
  rows: FakeRow[],
  captured: Captured,
  validFields: string[] | null,
) {
  return function GlideRecordStub(this: any, _table: string) {
    var i = -1;
    this.get = function (sysIdOrField: string, value?: string) {
      if (value !== undefined) {
        // sys_app lookup by scope name → one row with a sys_id
        i = rows.findIndex(function (r) {
          return r[sysIdOrField] === value;
        });
        return i !== -1;
      }
      i = rows.findIndex(function (r) {
        return r.sys_id === sysIdOrField;
      });
      return i !== -1;
    };
    this.addQuery = function (field: string, value: string) {
      captured.fieldQueries.push({ field: field, value: value });
      return { addOrCondition: function () {} };
    };
    this.addEncodedQuery = function (q: string) {
      captured.encodedQueries.push(q);
    };
    this.isValidField = function (field: string) {
      return validFields === null ? true : validFields.indexOf(field) !== -1;
    };
    this.query = function () {
      i = -1;
    };
    this.next = function () {
      i += 1;
      return i < rows.length;
    };
    this.getValue = function (field: string) {
      var v = rows[i][field];
      return v === undefined ? null : v;
    };
    this.getDisplayValue = function (field?: string) {
      return field ? rows[i][field] : rows[i].label || rows[i].name;
    };
    this.getElement = function (field: string) {
      var v = rows[i][field];
      return {
        getDisplayValue: function () {
          return v === undefined ? "" : v;
        },
      };
    };
    this.getElements = function () {
      return null;
    };
  };
}

interface LoadOptions {
  rows?: FakeRow[];
  validFields?: string[] | null;
  metadataClasses?: string[];
}

function loadUtils(opts: LoadOptions) {
  const rows = opts.rows || [];
  const warnings: string[] = [];
  const captured: Captured = { encodedQueries: [], fieldQueries: [] };
  const metadataClasses = opts.metadataClasses || [];

  const sandbox: any = {
    Class: {
      create: function () {
        return function (this: any) {
          if (this.initialize) this.initialize.apply(this, arguments);
        };
      },
    },
    GlideRecord: makeGlideRecord(
      rows,
      captured,
      opts.validFields === undefined ? null : opts.validFields,
    ),
    // getTableNames aggregates sys_metadata by sys_class_name — one "row" per class.
    GlideAggregate: function GlideAggregateStub(this: any) {
      var i = -1;
      this.addQuery = function () {};
      this.groupBy = function () {};
      this.query = function () {
        i = -1;
      };
      this.next = function () {
        i += 1;
        return i < metadataClasses.length;
      };
      this.getValue = function () {
        return metadataClasses[i];
      };
    },
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

  return {
    utils: new sandbox.DovetailUtilsMS(),
    warnings: warnings,
    captured: captured,
  };
}

const CHOICE_ROWS: FakeRow[] = [
  {
    sys_id: "a21fd5c0c3bf0750d4ddf1db05013100",
    name: "x_cadso_automate_message_batch_recipient",
    element: "last_status",
    value: "delivered",
    label: "Delivered",
  },
  {
    sys_id: "2e1f598c33ff07507b18bc534d5c7b46",
    name: "x_cadso_automate_message_batch_recipient",
    element: "last_status",
    value: "failed",
    label: "Failed",
  },
  {
    sys_id: "b94a7244c3ec8750d4ddf1db0501315e",
    name: "x_cadso_automate_message_batch_recipient",
    element: "state",
    value: "Failed",
    label: "Failed",
  },
  {
    sys_id: "11327be5c3384f90d4ddf1db050131a3",
    name: "x_cadso_automate_message_batch",
    element: "state",
    value: "Failed",
    label: "Failed",
  },
];

function buildChoices(
  tableOptions: Record<string, unknown>,
  validFields: string[] | null = ["name", "element", "value", "label"],
) {
  const loaded = loadUtils({ rows: CHOICE_ROWS, validFields: validFields });
  const result = loaded.utils.buildTableMap({
    tableName: "sys_choice",
    scopeId: "5e9f5f8b87420250369f33373cbb3559",
    scopeName: "x_cadso_automate",
    getContents: false,
    includes: { sys_choice: { label: { type: "txt" } } },
    excludes: {},
    tableOptions: tableOptions,
  });
  return {
    records: result.records,
    warnings: loaded.warnings,
    captured: loaded.captured,
  };
}

describe("DovetailUtilsMS.buildTableMap — scopeQuery", () => {
  it("replaces the sys_scope filter with the rendered scopeQuery ({scope} → scope name)", () => {
    const out = buildChoices({ scopeQuery: "nameSTARTSWITH{scope}_" });

    expect(out.captured.encodedQueries).toContain(
      "nameSTARTSWITHx_cadso_automate_",
    );
    const scopeFilters = out.captured.fieldQueries.filter(
      (q) => q.field === "sys_scope",
    );
    expect(scopeFilters).toHaveLength(0);
  });

  it("renders {scopeId} as the scope sys_id", () => {
    const out = buildChoices({ scopeQuery: "sys_package={scopeId}" });
    expect(out.captured.encodedQueries).toContain(
      "sys_package=5e9f5f8b87420250369f33373cbb3559",
    );
  });

  it("keeps the sys_scope filter when no scopeQuery is set (existing behaviour)", () => {
    const out = buildChoices({});
    const scopeFilters = out.captured.fieldQueries.filter(
      (q) => q.field === "sys_scope",
    );
    expect(scopeFilters).toEqual([
      { field: "sys_scope", value: "5e9f5f8b87420250369f33373cbb3559" },
    ]);
  });

  it("still ANDs the plain `query` option on top of scopeQuery", () => {
    const out = buildChoices({
      scopeQuery: "nameSTARTSWITH{scope}_",
      query: "language=en",
    });
    expect(out.captured.encodedQueries).toEqual([
      "nameSTARTSWITHx_cadso_automate_",
      "language=en",
    ]);
  });

  it("skips the sys_class_name query on a table that has no such column (sys_choice)", () => {
    const out = buildChoices({ scopeQuery: "nameSTARTSWITH{scope}_" }, [
      "name",
      "element",
      "value",
      "label",
    ]);
    const classFilters = out.captured.fieldQueries.filter(
      (q) => q.field === "sys_class_name",
    );
    expect(classFilters).toHaveLength(0);
  });

  it("keeps the sys_class_name query on a table that has the column", () => {
    const out = buildChoices({}, null);
    const classFilters = out.captured.fieldQueries.filter(
      (q) => q.field === "sys_class_name",
    );
    expect(classFilters).toEqual([
      { field: "sys_class_name", value: "sys_choice" },
    ]);
  });

  it("treats an empty scopeQuery as unset", () => {
    const out = buildChoices({ scopeQuery: "" });
    const scopeFilters = out.captured.fieldQueries.filter(
      (q) => q.field === "sys_scope",
    );
    expect(scopeFilters).toHaveLength(1);
    expect(out.captured.encodedQueries).toHaveLength(0);
  });
});

describe("DovetailUtilsMS.generateRecordName — nameTemplate", () => {
  it("names sys_choice folders {name}.{element}.{value} so same-label rows never collide", () => {
    const out = buildChoices({ nameTemplate: "{name}.{element}.{value}" });

    expect(Object.keys(out.records).sort()).toEqual([
      "x_cadso_automate_message_batch.state.Failed",
      "x_cadso_automate_message_batch_recipient.last_status.delivered",
      "x_cadso_automate_message_batch_recipient.last_status.failed",
      "x_cadso_automate_message_batch_recipient.state.Failed",
    ]);
    expect(out.warnings).toHaveLength(0);
  });

  it("without a template, three 'Failed' labels collapse into the sys_id-suffixed collision set", () => {
    const out = buildChoices({});
    const keys = Object.keys(out.records).sort();
    expect(keys).toEqual([
      "Delivered",
      "Failed (11327be5)",
      "Failed (2e1f598c)",
      "Failed (b94a7244)",
    ]);
  });

  it("keeps record.name identical to the map key", () => {
    const out = buildChoices({ nameTemplate: "{name}.{element}.{value}" });
    Object.keys(out.records).forEach((key) => {
      expect(out.records[key].name).toBe(key);
    });
  });

  it("drops an empty token together with the literal before it (sys_dictionary collection row)", () => {
    const loaded = loadUtils({
      rows: [
        {
          sys_id: "c85856cec3a44b10d4ddf1db05013158",
          name: "x_cadso_automate_message_batch_recipient",
          element: "last_status",
        },
        {
          sys_id: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
          name: "x_cadso_automate_message_batch_recipient",
          element: "",
        },
        {
          sys_id: "1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b",
          name: "x_cadso_automate_message_batch",
        },
      ],
    });
    const result = loaded.utils.buildTableMap({
      tableName: "sys_dictionary",
      scopeId: "scope1",
      scopeName: "x_cadso_automate",
      getContents: false,
      includes: { sys_dictionary: { column_label: { type: "txt" } } },
      excludes: {},
      tableOptions: { nameTemplate: "{name}.{element}" },
    });

    expect(Object.keys(result.records).sort()).toEqual([
      "x_cadso_automate_message_batch",
      "x_cadso_automate_message_batch_recipient",
      "x_cadso_automate_message_batch_recipient.last_status",
    ]);
  });

  it("drops a leading empty token and its following literal", () => {
    const loaded = loadUtils({
      rows: [{ sys_id: "aaaaaaaa11111111", element: "state", value: "x" }],
    });
    const result = loaded.utils.buildTableMap({
      tableName: "t",
      scopeId: "s",
      scopeName: "x",
      getContents: false,
      includes: { t: { value: { type: "txt" } } },
      excludes: {},
      tableOptions: { nameTemplate: "{name}.{element}.{value}" },
    });
    expect(Object.keys(result.records)).toEqual(["state.x"]);
  });

  it("falls back to sys_id when every token is empty", () => {
    const loaded = loadUtils({ rows: [{ sys_id: "aaaaaaaa11111111" }] });
    const result = loaded.utils.buildTableMap({
      tableName: "t",
      scopeId: "s",
      scopeName: "x",
      getContents: false,
      includes: { t: { value: { type: "txt" } } },
      excludes: {},
      tableOptions: { nameTemplate: "{name}.{element}" },
    });
    expect(Object.keys(result.records)).toEqual(["aaaaaaaa11111111"]);
  });

  it("sanitizes path separators in template values", () => {
    const loaded = loadUtils({
      rows: [{ sys_id: "aaaaaaaa11111111", name: "t", value: "a/b\\c" }],
    });
    const result = loaded.utils.buildTableMap({
      tableName: "t",
      scopeId: "s",
      scopeName: "x",
      getContents: false,
      includes: { t: { value: { type: "txt" } } },
      excludes: {},
      tableOptions: { nameTemplate: "{name}.{value}" },
    });
    expect(Object.keys(result.records)).toEqual(["t.a〳b〳c"]);
  });

  it("wins over displayField / differentiatorField when both are set", () => {
    const out = buildChoices({
      nameTemplate: "{element}.{value}",
      displayField: "label",
      differentiatorField: "sys_id",
    });
    expect(Object.keys(out.records).sort()).toEqual([
      "last_status.delivered",
      "last_status.failed",
      "state.Failed (11327be5)",
      "state.Failed (b94a7244)",
    ]);
    // Two tables share element+value here — the collision guard still catches it.
    expect(out.warnings).toHaveLength(2);
  });

  it("applies the template in processMissingFiles (bulkDownload) too", () => {
    const loaded = loadUtils({ rows: CHOICE_ROWS });
    const recordMap: Record<string, Array<{ name: string; type: string }>> = {};
    CHOICE_ROWS.forEach((r) => {
      recordMap[r.sys_id] = [{ name: "label", type: "txt" }];
    });
    const result = loaded.utils.processMissingFiles(
      { sys_choice: recordMap },
      { sys_choice: { nameTemplate: "{name}.{element}.{value}" } },
    );
    expect(Object.keys(result.sys_choice.records).sort()).toEqual([
      "x_cadso_automate_message_batch.state.Failed",
      "x_cadso_automate_message_batch_recipient.last_status.delivered",
      "x_cadso_automate_message_batch_recipient.last_status.failed",
      "x_cadso_automate_message_batch_recipient.state.Failed",
    ]);
  });
});

describe("DovetailUtilsMS.getTableNames — scopeQuery tables are listed explicitly", () => {
  it("adds a scopeQuery table that sys_metadata cannot surface", () => {
    const loaded = loadUtils({
      metadataClasses: ["sys_script_include", "sys_dictionary"],
    });
    const tables = loaded.utils.getTableNames({
      scopeId: "scope1",
      includes: { sys_choice: { label: { type: "txt" } } },
      excludes: {},
      tableOptions: { sys_choice: { scopeQuery: "nameSTARTSWITH{scope}_" } },
    });
    expect(tables).toEqual([
      "sys_script_include",
      "sys_dictionary",
      "sys_choice",
    ]);
  });

  it("does not duplicate a table sys_metadata already surfaced", () => {
    const loaded = loadUtils({ metadataClasses: ["sys_dictionary"] });
    const tables = loaded.utils.getTableNames({
      scopeId: "scope1",
      includes: {},
      excludes: {},
      tableOptions: { sys_dictionary: { scopeQuery: "nameSTARTSWITHx_" } },
    });
    expect(tables).toEqual(["sys_dictionary"]);
  });

  it("respects excludes for scopeQuery tables", () => {
    const loaded = loadUtils({ metadataClasses: [] });
    const tables = loaded.utils.getTableNames({
      scopeId: "scope1",
      includes: {},
      excludes: { sys_choice: true },
      tableOptions: { sys_choice: { scopeQuery: "nameSTARTSWITH{scope}_" } },
    });
    expect(tables).toEqual([]);
  });

  it("ignores tableOptions without a scopeQuery (query / nameTemplate alone do not list a table)", () => {
    const loaded = loadUtils({ metadataClasses: [] });
    const tables = loaded.utils.getTableNames({
      scopeId: "scope1",
      includes: {},
      excludes: {},
      tableOptions: {
        sys_choice: { nameTemplate: "{name}" },
        sys_dictionary: { query: "a=b" },
      },
    });
    expect(tables).toEqual([]);
  });

  it("tolerates a missing tableOptions argument (existing callers)", () => {
    const loaded = loadUtils({ metadataClasses: ["sys_script"] });
    const tables = loaded.utils.getTableNames({
      scopeId: "scope1",
      includes: {},
      excludes: {},
    });
    expect(tables).toEqual(["sys_script"]);
  });
});

describe("DovetailUtilsMS.getManifest — wiring", () => {
  it("passes scopeName into buildTableMap so scopeQuery renders, and lists the scope-less table", () => {
    const loaded = loadUtils({
      // sys_app lookup row (getScopeId does appGR.get("scope", name)) + the choice rows
      rows: (
        [
          {
            sys_id: "5e9f5f8b87420250369f33373cbb3559",
            scope: "x_cadso_automate",
          },
        ] as FakeRow[]
      ).concat(CHOICE_ROWS),
      metadataClasses: [],
      validFields: ["name", "element", "value", "label", "scope"],
    });
    const manifest = loaded.utils.getManifest({
      scopeName: "x_cadso_automate",
      includes: { sys_choice: { label: { type: "txt" } } },
      excludes: {},
      tableOptions: {
        sys_choice: {
          scopeQuery: "nameSTARTSWITH{scope}_",
          nameTemplate: "{name}.{element}.{value}",
        },
      },
      getContents: false,
    });

    expect(loaded.captured.encodedQueries).toContain(
      "nameSTARTSWITHx_cadso_automate_",
    );
    expect(Object.keys(manifest.tables)).toEqual(["sys_choice"]);
    // The stub GlideRecord iterates every fixture row regardless of query, so the
    // sys_app row shows up too (named by sys_id: no name/element/value). What matters
    // here is that the four choice rows are present under their templated names.
    const keys = Object.keys(manifest.tables.sys_choice.records);
    expect(keys).toContain(
      "x_cadso_automate_message_batch_recipient.last_status.delivered",
    );
    expect(keys).toContain("x_cadso_automate_message_batch.state.Failed");
  });
});
