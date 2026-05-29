import { diffSchemas } from "../diff";
import { normalizeField } from "../snapshot";
import { NormalizedField, NormalizedSchema, NormalizedTable } from "../types";

function field(overrides: Partial<NormalizedField>): NormalizedField {
  var base: NormalizedField = {
    name: "f",
    label: "F",
    type: "string",
    max_length: "40",
    mandatory: false,
    reference: "",
    default_value: "",
  };
  return Object.assign({}, base, overrides);
}

function table(name: string, fields: NormalizedField[]): NormalizedTable {
  return { table_name: name, label: name, scope: "x_cadso_journey", fields };
}

function schema(tables: NormalizedTable[]): NormalizedSchema {
  var map: { [k: string]: NormalizedTable } = {};
  for (var i = 0; i < tables.length; i++) {
    map[tables[i].table_name] = tables[i];
  }
  return { instance: "demo.service-now.com", generated_at: null, tables: map };
}

function run(from: NormalizedSchema, to: NormalizedSchema) {
  return diffSchemas({ from, to, fromRef: "from", toRef: "to", scope: "x_cadso_journey" });
}

describe("diffSchemas — table-level", function () {
  it("flags a removed table as BREAKING and exits non-zero", function () {
    var from = schema([table("x_cadso_journey_option", [field({ name: "state" })])]);
    var to = schema([]);
    var diff = run(from, to);
    expect(diff.tables).toEqual([
      { table: "x_cadso_journey_option", change: "removed", severity: "BREAKING" },
    ]);
    expect(diff.summary.breaking).toBe(1);
    expect(diff.exit_code).toBe(1);
  });

  it("flags an added table as INFO and exits zero", function () {
    var from = schema([]);
    var to = schema([table("x_cadso_journey_checkpoint", [field({ name: "state" })])]);
    var diff = run(from, to);
    expect(diff.tables).toEqual([
      { table: "x_cadso_journey_checkpoint", change: "added", severity: "INFO" },
    ]);
    expect(diff.exit_code).toBe(0);
  });
});

describe("diffSchemas — field-level severity", function () {
  function oneField(f: Partial<NormalizedField>) {
    return schema([table("x_cadso_journey_action", [field(f)])]);
  }

  it("removed field => BREAKING", function () {
    var diff = diffSchemas({
      from: schema([table("x_cadso_journey_action", [field({ name: "retry_count" })])]),
      to: schema([table("x_cadso_journey_action", [])]),
      fromRef: "a",
      toRef: "b",
    });
    expect(diff.fields[0]).toMatchObject({
      field: "retry_count",
      change: "removed",
      severity: "BREAKING",
    });
  });

  it("added field => INFO", function () {
    var diff = diffSchemas({
      from: schema([table("x_cadso_journey_action", [])]),
      to: schema([table("x_cadso_journey_action", [field({ name: "last_run_at", type: "glide_date_time" })])]),
      fromRef: "a",
      toRef: "b",
    });
    expect(diff.fields[0]).toMatchObject({ field: "last_run_at", change: "added", severity: "INFO" });
  });

  it("retyped field => BREAKING", function () {
    var diff = run(oneField({ name: "priority", type: "string" }), oneField({ name: "priority", type: "integer" }));
    expect(diff.fields[0]).toMatchObject({ change: "retyped", from: "string", to: "integer", severity: "BREAKING" });
  });

  it("shrunk max_length => BREAKING, grown => INFO", function () {
    var shrunk = run(oneField({ name: "x", max_length: "100" }), oneField({ name: "x", max_length: "40" }));
    expect(shrunk.fields[0]).toMatchObject({ change: "length_shrunk", severity: "BREAKING" });
    var grown = run(oneField({ name: "x", max_length: "40" }), oneField({ name: "x", max_length: "100" }));
    expect(grown.fields[0]).toMatchObject({ change: "length_grew", severity: "INFO" });
  });

  it("newly mandatory => BREAKING, now optional => INFO", function () {
    var mand = run(oneField({ name: "owner", mandatory: false }), oneField({ name: "owner", mandatory: true }));
    expect(mand.fields[0]).toMatchObject({ change: "newly_mandatory", severity: "BREAKING" });
    var opt = run(oneField({ name: "owner", mandatory: true }), oneField({ name: "owner", mandatory: false }));
    expect(opt.fields[0]).toMatchObject({ change: "now_optional", severity: "INFO" });
  });

  it("retargeted reference => BREAKING; cleared reference is not breaking", function () {
    var retarget = run(
      oneField({ name: "ref", type: "reference", reference: "sys_user" }),
      oneField({ name: "ref", type: "reference", reference: "sys_user_group" })
    );
    expect(retarget.fields.some(function (c) { return c.change === "retargeted" && c.severity === "BREAKING"; })).toBe(true);

    var cleared = run(
      oneField({ name: "ref", type: "reference", reference: "sys_user" }),
      oneField({ name: "ref", type: "reference", reference: "" })
    );
    expect(cleared.fields.some(function (c) { return c.change === "retargeted"; })).toBe(false);
  });

  it("default_value change => WARN", function () {
    var diff = run(oneField({ name: "state", default_value: "draft" }), oneField({ name: "state", default_value: "pending" }));
    expect(diff.fields[0]).toMatchObject({ change: "default_changed", severity: "WARN" });
    expect(diff.exit_code).toBe(0);
  });

  it("label change => INFO", function () {
    var diff = run(oneField({ name: "state", label: "State" }), oneField({ name: "state", label: "Status" }));
    expect(diff.fields[0]).toMatchObject({ change: "label_changed", severity: "INFO" });
  });
});

describe("diffSchemas — noise immunity", function () {
  it("object-shaped vs string-shaped type/reference produce no drift", function () {
    // legacy baseline shape ({link,value}) vs current pull shape (string)
    var legacy = normalizeField({
      element: "ref",
      name: "ref",
      label: "Ref",
      type: { link: "https://x/sys_glide_object?name=reference", value: "reference" },
      max_length: "32",
      mandatory: "false",
      reference: { link: "https://x/sys_db_object?name=sys_user", value: "sys_user" },
      default_value: "",
      inherited_from: "sys_metadata",
    });
    var current = normalizeField({
      name: "ref",
      label: "Ref",
      type: "reference",
      max_length: "32",
      mandatory: false,
      reference: "sys_user",
      default_value: "",
      inherited_from: null,
    });
    var diff = run(schema([table("t", [legacy])]), schema([table("t", [current])]));
    expect(diff.tables).toEqual([]);
    expect(diff.fields).toEqual([]);
    expect(diff.exit_code).toBe(0);
  });
});
