/**
 * listIndexes — the read side of the index capability.
 *
 * The contract this pins:
 *   - `v_db_index` is the ONLY surface read. sys_index is API-level-ACL 403 and
 *     sys_index_column does not exist, so neither is ever touched.
 *   - `column_names` arrives BRACKETED ("[phone]", "[a;b]" — semicolons live) and is PARSED, never
 *     handed back raw as if it were a column name.
 *   - UNIQUENESS IS NEVER CLAIMED: the view has no uniqueness field, so `unique` is
 *     left absent and "uniqueness-enforced" is in `unverified` on every result.
 *   - A table name is validated BEFORE it reaches an encoded query — a value with a
 *     separator, space or dot never gets interpolated.
 *   - Rows are re-checked against the requested table name, because an encoded query
 *     ServiceNow does not understand returns the UNFILTERED set rather than erroring.
 */

import { listIndexes } from "../src/table/listIndexes";
import { makeMockClient } from "./mockClient";
import type { ServiceNowClient } from "../src/client";

var TABLE = "x_cadso_automate_message_batch_recipient";

function row(name: string, columns: string, table: string = TABLE) {
  return {
    table_name: table,
    index_name: name,
    column_names: columns,
    access_method: "btree",
  };
}

/** Every method throws — any test using it proves the path touched no network. */
function noNetworkClient(): ServiceNowClient {
  var boom = function (): never {
    throw new Error("no network call expected");
  };
  return {
    table: { query: boom },
    buildAgent: { runQuery: boom, getTableSchema: boom },
    claude: {
      createRecord: boom,
      pushWithUpdateSet: boom,
      currentUpdateSet: boom,
      changeUpdateSet: boom,
      deleteRecord: boom,
    },
    now: { get: boom, post: boom, put: boom, delete: boom, invoke: boom },
    attachment: { listFor: boom, upload: boom, remove: boom },
  } as unknown as ServiceNowClient;
}

describe("listIndexes — identifier validation", function () {
  var bad = [
    "phone;DROP",
    "x_cadso phone",
    "x_cadso.phone",
    "phone^ORsys_id!=1",
    "phone=1",
    "9starts_with_digit",
    "",
    "   ",
  ];

  bad.forEach(function (value) {
    it(
      "refuses the injection-shaped table name " + JSON.stringify(value),
      async function () {
        await expect(
          listIndexes({ client: noNetworkClient(), table: value }),
        ).rejects.toThrow(/index-list:/);
      },
    );
  });

  it("rejects a bad name BEFORE any query is issued", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    await expect(
      listIndexes({ client: ctx.client, table: "phone;DROP" }),
    ).rejects.toThrow();
    expect(ctx.calls.tableQuery).toHaveLength(0);
  });

  it("accepts a normal scoped table name", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [row("PRIMARY", "[sys_id]")];
      },
    });
    var result = await listIndexes({ client: ctx.client, table: TABLE });
    expect(result.table).toBe(TABLE);
    expect(ctx.calls.tableQuery[0].table).toBe("v_db_index");
  });
});

describe("listIndexes — column_names parsing", function () {
  async function listWith(rows: Array<Record<string, string>>) {
    var ctx = makeMockClient({
      query: async function () {
        return rows;
      },
    });
    return listIndexes({ client: ctx.client, table: TABLE });
  }

  it("parses a single bracketed column", async function () {
    var result = await listWith([row("phone", "[phone]")]);
    expect(result.indexes[0].columns).toEqual(["phone"]);
    expect(result.indexes[0].rawColumns).toBe("[phone]");
  });

  it("parses a composite list and trims the spacing", async function () {
    var result = await listWith([row("ab", "[a, b]")]);
    expect(result.indexes[0].columns).toEqual(["a", "b"]);
  });

  it("parses a composite list with no spacing", async function () {
    var result = await listWith([row("ab", "[a,b]")]);
    expect(result.indexes[0].columns).toEqual(["a", "b"]);
  });

  it("parses the LIVE semicolon-separated composite form", async function () {
    // Read from tenonworkstudio 2026-10-08: a 4-column btree index.
    var result = await listWith([
      row("sys_created_on", "[sys_created_on;status;version_step;version]"),
    ]);
    expect(result.indexes[0].columns).toEqual([
      "sys_created_on",
      "status",
      "version_step",
      "version",
    ]);
  });

  it("a semicolon composite is NOT one column with a semicolon in it", async function () {
    var result = await listWith([row("ab", "[a;b]")]);
    expect(result.indexes[0].columns).not.toEqual(["a;b"]);
    expect(result.indexes[0].columns).toHaveLength(2);
  });

  it("tolerates an unbracketed cell", async function () {
    var result = await listWith([row("phone", "phone")]);
    expect(result.indexes[0].columns).toEqual(["phone"]);
  });

  it("yields an empty column list for an empty cell rather than ['']", async function () {
    var result = await listWith([row("odd", "[]")]);
    expect(result.indexes[0].columns).toEqual([]);
  });
});

describe("listIndexes — what it refuses to claim", function () {
  it("never populates `unique` and always reports it unverified", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [row("phone", "[phone]"), row("PRIMARY", "[sys_id]")];
      },
    });
    var result = await listIndexes({ client: ctx.client, table: TABLE });
    result.indexes.forEach(function (idx) {
      expect(idx.unique).toBeUndefined();
    });
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("drops rows for another table — an unfiltered result must not be relabelled", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [row("mine", "[a]"), row("theirs", "[b]", "some_other_table")];
      },
    });
    var result = await listIndexes({ client: ctx.client, table: TABLE });
    expect(result.indexes).toHaveLength(1);
    expect(result.indexes[0].name).toBe("mine");
  });

  it("says an empty result probably means a wrong table name", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    var result = await listIndexes({ client: ctx.client, table: TABLE });
    expect(result.indexes).toEqual([]);
    expect(result.note).toMatch(/NO index/);
    expect(result.note).toMatch(/PRIMARY/);
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("reads v_db_index and never sys_index or sys_index_column", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [row("phone", "[phone]")];
      },
    });
    await listIndexes({ client: ctx.client, table: TABLE });
    var tables = ctx.calls.tableQuery.map(function (c) {
      return c.table;
    });
    expect(tables).toEqual(["v_db_index"]);
  });

  it("maps a realistic five-index table into shape", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [
          row("x_cadso_journey_instance_step", "[x_cadso_journey_instance_step]"),
          row("message_batch", "[message_batch]"),
          row("sys_domain", "[sys_domain]"),
          row("contact_detail", "[contact_detail]"),
          row("PRIMARY", "[sys_id]"),
        ];
      },
    });
    var result = await listIndexes({ client: ctx.client, table: TABLE });
    expect(result.indexes).toHaveLength(5);
    expect(
      result.indexes.map(function (i) {
        return i.name;
      }),
    ).toContain("message_batch");
    expect(
      result.indexes.map(function (i) {
        return i.columns.join(",");
      }),
    ).not.toContain("phone");
    expect(result.indexes[0].type).toBe("btree");
  });
});

describe("listIndexes — table-per-hierarchy children (indexes live on the storage root)", function () {
  var CHILD = "x_cadso_work_campaign";
  var MIDDLE = "x_cadso_work_item";
  var ROOT = "task";
  var CHILD_ID = "11111111111111111111111111111111";
  var MIDDLE_ID = "22222222222222222222222222222222";
  var ROOT_ID = "33333333333333333333333333333333";

  /** sys_db_object + v_db_index served per query, as the instance would. */
  function hierarchyClient(opts: {
    objects: Array<{ sys_id: string; name: string; super_class: string }>;
    indexesByTable: Record<string, Array<Record<string, string>>>;
  }) {
    return makeMockClient({
      query: async function (table: string, query?: string) {
        var q = String(query || "");
        if (table === "v_db_index") {
          var name = q.replace(/^table_name=/, "");
          return opts.indexesByTable[name] || [];
        }
        if (table === "sys_db_object") {
          return opts.objects
            .filter(function (o) {
              return q === "name=" + o.name || q === "sys_id=" + o.sys_id;
            })
            .map(function (o) {
              return {
                sys_id: o.sys_id,
                name: o.name,
                super_class: o.super_class ? { value: o.super_class } : "",
              };
            });
        }
        throw new Error("unexpected table " + table);
      },
    });
  }

  var OBJECTS = [
    { sys_id: CHILD_ID, name: CHILD, super_class: MIDDLE_ID },
    { sys_id: MIDDLE_ID, name: MIDDLE, super_class: ROOT_ID },
    { sys_id: ROOT_ID, name: ROOT, super_class: "" },
  ];
  var ROOT_INDEXES: Record<string, Array<Record<string, string>>> = {};
  ROOT_INDEXES[ROOT] = [
    row("PRIMARY", "[sys_id]", ROOT),
    row("task_number", "[number]", ROOT),
  ];

  it("lists the storage root's indexes and names the root", async function () {
    var ctx = hierarchyClient({ objects: OBJECTS, indexesByTable: ROOT_INDEXES });
    var result = await listIndexes({ client: ctx.client, table: CHILD });
    expect(result.table).toBe(CHILD);
    expect(result.storageTable).toBe(ROOT);
    expect(
      result.indexes.map(function (i) {
        return i.name;
      }),
    ).toEqual(["PRIMARY", "task_number"]);
    expect(result.note).toMatch(/stored in 'task''s physical table/);
    expect(result.note).toMatch(/table-per-hierarchy/);
    expect(result.note).toMatch(/x_cadso_work_campaign -> x_cadso_work_item -> task/);
    // The old "the table name is wrong" guess must NOT be made for a table that exists.
    expect(result.note).not.toMatch(/name is wrong/);
    expect(result.unverified).toContain("uniqueness-enforced");
  });

  it("a table with its own rows is its own storage table and walks nothing", async function () {
    var byTable: Record<string, Array<Record<string, string>>> = {};
    byTable[CHILD] = [row("PRIMARY", "[sys_id]", CHILD)];
    var ctx = hierarchyClient({ objects: OBJECTS, indexesByTable: byTable });
    var result = await listIndexes({ client: ctx.client, table: CHILD });
    expect(result.storageTable).toBe(CHILD);
    expect(result.indexes).toHaveLength(1);
    expect(
      ctx.calls.tableQuery.some(function (c) {
        return c.table === "sys_db_object";
      }),
    ).toBe(false);
  });

  it("a table that does not exist says the name is wrong", async function () {
    var ctx = hierarchyClient({ objects: OBJECTS, indexesByTable: ROOT_INDEXES });
    var result = await listIndexes({ client: ctx.client, table: "x_cadso_nope" });
    expect(result.storageTable).toBe("x_cadso_nope");
    expect(result.indexes).toEqual([]);
    expect(result.note).toMatch(/not found in sys_db_object/);
  });

  it("an existing table with no indexed ancestor is reported as unreadable, not unindexed", async function () {
    var ctx = hierarchyClient({ objects: OBJECTS, indexesByTable: {} });
    var result = await listIndexes({ client: ctx.client, table: CHILD });
    expect(result.indexes).toEqual([]);
    expect(result.storageTable).toBe(CHILD);
    expect(result.note).toMatch(/NOT evidence the table is unindexed/);
  });

  it("a cyclic super_class chain terminates", async function () {
    var cyclic = [
      { sys_id: CHILD_ID, name: CHILD, super_class: MIDDLE_ID },
      { sys_id: MIDDLE_ID, name: MIDDLE, super_class: CHILD_ID },
    ];
    var ctx = hierarchyClient({ objects: cyclic, indexesByTable: {} });
    var result = await listIndexes({ client: ctx.client, table: CHILD });
    expect(result.indexes).toEqual([]);
    expect(ctx.calls.tableQuery.length).toBeLessThan(10);
  });
});
