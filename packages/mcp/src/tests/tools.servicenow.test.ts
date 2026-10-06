jest.mock("@tenonhq/dovetail-servicenow", function () {
  return {
    createClient: jest.fn(function () {
      return { table: { query: jest.fn() } };
    }),
    createClientFromEnvFile: jest.fn(function () {
      return { table: { query: jest.fn() } };
    })
  };
});

import { servicenowQueryTable, resolveEnvFilePath } from "../tools/servicenow";
import { servicenowQueryTableSchema } from "../schemas/servicenow";
import type { ServicenowQueryTableInput } from "../schemas/servicenow";

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

  it("retargets to a per-call env file via clientFromEnvFile, bypassing the default client", async function () {
    var envQuery = jest.fn().mockResolvedValue([{ sys_id: "env" }]);
    var defaultQuery = jest.fn().mockResolvedValue([{ sys_id: "default" }]);
    var fromEnvFile = jest.fn(function (_envPath: string) {
      return { table: { query: envQuery } } as any;
    });
    var deps = {
      safety: { denyTables: [], overrideTables: [] },
      clientFactory: function () {
        return { table: { query: defaultQuery } } as any;
      },
      clientFromEnvFile: fromEnvFile
    };
    var out = await servicenowQueryTable(
      { table: "incident", sysparm_query: "active=true", env: "workshop" } as any,
      deps
    );
    expect(fromEnvFile).toHaveBeenCalledTimes(1);
    // resolved to an absolute .env.workshop path in cwd
    expect(String(fromEnvFile.mock.calls[0][0])).toMatch(/[\\/]\.env\.workshop$/);
    expect(defaultQuery).not.toHaveBeenCalled();
    expect(out.records).toEqual([{ sys_id: "env" }]);
  });
});

describe("resolveEnvFilePath", function () {
  it("maps a bare token to .env.<token> in cwd", function () {
    expect(resolveEnvFilePath("prod")).toBe(require("path").resolve(process.cwd(), ".env.prod"));
  });

  it("accepts a full .env.<name> basename", function () {
    expect(resolveEnvFilePath(".env.workshop")).toBe(
      require("path").resolve(process.cwd(), ".env.workshop")
    );
  });

  it("accepts a bare .env", function () {
    expect(resolveEnvFilePath(".env")).toBe(require("path").resolve(process.cwd(), ".env"));
  });

  it("rejects path separators", function () {
    expect(function () { resolveEnvFilePath("../secrets/.env"); }).toThrow(/no path separators/);
    expect(function () { resolveEnvFilePath("sub/dir"); }).toThrow(/no path separators/);
  });

  it("rejects traversal tokens", function () {
    expect(function () { resolveEnvFilePath(".env..prod"); }).toThrow();
  });
});

describe("servicenow_query_table offset (paging past the 1000-row cap, #298)", function () {
  var SAFETY = { denyTables: [] as string[], overrideTables: [] as string[] };

  it("forwards offset in the options object alongside fields", async function () {
    var query = jest.fn().mockResolvedValue([]);
    var deps = makeDeps(SAFETY, query);
    var args: ServicenowQueryTableInput = {
      table: "incident",
      sysparm_query: "active=true^ORDERBYsys_id",
      fields: ["sys_id"],
      limit: 1000,
      offset: 1000
    };
    await servicenowQueryTable(args, deps);
    expect(query).toHaveBeenCalledWith("incident", "active=true^ORDERBYsys_id", {
      limit: 1000,
      fields: ["sys_id"],
      offset: 1000
    });
  });

  it("forwards offset without fields (options form, no fields key, default limit)", async function () {
    var query = jest.fn().mockResolvedValue([]);
    var deps = makeDeps(SAFETY, query);
    var args: ServicenowQueryTableInput = { table: "incident", sysparm_query: "x=1", offset: 2000 };
    await servicenowQueryTable(args, deps);
    expect(query).toHaveBeenCalledWith("incident", "x=1", { limit: 100, offset: 2000 });
  });

  it("sends offset 0 explicitly when asked", async function () {
    var query = jest.fn().mockResolvedValue([]);
    var deps = makeDeps(SAFETY, query);
    var args: ServicenowQueryTableInput = { table: "incident", sysparm_query: "x=1", limit: 5, offset: 0 };
    await servicenowQueryTable(args, deps);
    expect(query).toHaveBeenCalledWith("incident", "x=1", { limit: 5, offset: 0 });
  });

  it("does not send offset when omitted (numeric-limit form, no offset key anywhere)", async function () {
    var query = jest.fn().mockResolvedValue([]);
    var deps = makeDeps(SAFETY, query);
    var args: ServicenowQueryTableInput = { table: "incident", sysparm_query: "x=1", limit: 25 };
    await servicenowQueryTable(args, deps);
    expect(query).toHaveBeenCalledWith("incident", "x=1", 25);
    var withFields: ServicenowQueryTableInput = { table: "incident", sysparm_query: "x=1", fields: ["sys_id"] };
    await servicenowQueryTable(withFields, deps);
    var lastOptions: unknown = query.mock.calls[1][2];
    expect(lastOptions).toEqual({ limit: 100, fields: ["sys_id"] });
    expect(Object.prototype.hasOwnProperty.call(lastOptions as object, "offset")).toBe(false);
  });

  it("schema accepts a non-negative integer offset and rejects negative / fractional ones", function () {
    var base = { table: "incident", sysparm_query: "x=1" };
    expect(servicenowQueryTableSchema.safeParse(Object.assign({}, base, { offset: 0 })).success).toBe(true);
    expect(servicenowQueryTableSchema.safeParse(Object.assign({}, base, { offset: 1000 })).success).toBe(true);
    expect(servicenowQueryTableSchema.safeParse(base).success).toBe(true);
    expect(servicenowQueryTableSchema.safeParse(Object.assign({}, base, { offset: -1 })).success).toBe(false);
    expect(servicenowQueryTableSchema.safeParse(Object.assign({}, base, { offset: 1.5 })).success).toBe(false);
    expect(servicenowQueryTableSchema.safeParse(Object.assign({}, base, { offset: "10" })).success).toBe(false);
  });
});
