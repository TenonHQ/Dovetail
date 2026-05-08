jest.mock("@tenonhq/dovetail-servicenow", function () {
  return {
    createClient: jest.fn(function () {
      return { table: { query: jest.fn() } };
    })
  };
});

import { servicenowQueryTable } from "../tools/servicenow";

function makeDeps(safety: { denyTables: string[]; overrideTables: string[] }, queryImpl: any) {
  return {
    safety: safety,
    clientFactory: function () {
      return {
        table: { query: queryImpl }
      } as any;
    }
  };
}

describe("servicenow_query_table", function () {
  it("rejects denied tables with an actionable message", async function () {
    var deps = makeDeps(
      { denyTables: ["sys_user_password"], overrideTables: [] },
      jest.fn()
    );
    await expect(servicenowQueryTable(
      { table: "sys_user_password", sysparm_query: "name=admin" } as any,
      deps
    )).rejects.toThrow(/deny list.*SINC_MCP_SN_TABLE_OVERRIDE/);
  });

  it("allows a denied table when listed in overrideTables", async function () {
    var query = jest.fn().mockResolvedValue([{ sys_id: "x" }]);
    var deps = makeDeps(
      { denyTables: ["sys_credential"], overrideTables: ["sys_credential"] },
      query
    );
    var result = await servicenowQueryTable(
      { table: "sys_credential", sysparm_query: "active=true" } as any,
      deps
    );
    expect(result.records).toEqual([{ sys_id: "x" }]);
    expect(query).toHaveBeenCalledWith("sys_credential", "active=true", 100);
  });

  it("calls table.query with options object when fields are provided", async function () {
    var query = jest.fn().mockResolvedValue([]);
    var deps = makeDeps(
      { denyTables: [], overrideTables: [] },
      query
    );
    await servicenowQueryTable(
      {
        table: "incident",
        sysparm_query: "active=true",
        fields: ["sys_id", "number"],
        limit: 50
      } as any,
      deps
    );
    expect(query).toHaveBeenCalledWith("incident", "active=true", {
      limit: 50,
      fields: ["sys_id", "number"]
    });
  });

  it("calls table.query with numeric limit when fields are not provided", async function () {
    var query = jest.fn().mockResolvedValue([]);
    var deps = makeDeps(
      { denyTables: [], overrideTables: [] },
      query
    );
    await servicenowQueryTable(
      { table: "incident", sysparm_query: "x=1", limit: 25 } as any,
      deps
    );
    expect(query).toHaveBeenCalledWith("incident", "x=1", 25);
  });

  it("returns shape { table, count, records }", async function () {
    var rows = [{ a: 1 }, { a: 2 }];
    var query = jest.fn().mockResolvedValue(rows);
    var deps = makeDeps(
      { denyTables: [], overrideTables: [] },
      query
    );
    var out = await servicenowQueryTable(
      { table: "incident", sysparm_query: "" } as any,
      deps
    );
    expect(out).toEqual({ table: "incident", count: 2, records: rows });
  });
});
