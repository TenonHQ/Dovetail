// snClient.getScopeId must resolve a scope name to exactly one sys_scope row.
// `scope=global` also matches sys_app rows on live instances, so Global is
// addressed by its fixed sys_id; any other name with >1 row is refused.

jest.mock("../Logger", function () {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      getLogLevel: function () { return "debug"; },
    },
  };
});

jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
});

import { snClient, unwrapSNResponse } from "../snClient";

import type { AxiosRequestConfig } from "axios";

// Rows keyed by the encoded query the client sends.
function stubGet(
  c: ReturnType<typeof snClient>,
  rowsByQuery: Record<string, Array<{ sys_id: string }>>,
): string[] {
  var queries: string[] = [];
  jest.spyOn(c.client, "get").mockImplementation(async function (_url: string, config?: AxiosRequestConfig) {
    var params = (config && config.params) as { sysparm_query?: string } | undefined;
    var q = (params && params.sysparm_query) || "";
    queries.push(q);
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      config: {},
      data: { result: rowsByQuery[q] || [] },
    };
  });
  return queries;
}

describe("snClient.getScopeId", function () {
  it("resolves global to the real Global scope even when sys_app rows share scope=global", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    var queries = stubGet(c, {
      "scope=global": [{ sys_id: "489827aabbccdd" }, { sys_id: "global" }],
      "sys_id=global": [{ sys_id: "global" }],
    });

    var rows = await unwrapSNResponse(c.getScopeId("global"));

    expect(rows).toHaveLength(1);
    expect(rows[0].sys_id).toBe("global");
    expect(queries).toEqual(["sys_id=global"]);
  });

  it("throws when a non-global scope name matches more than one row", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    stubGet(c, { "scope=x_dup": [{ sys_id: "a1" }, { sys_id: "b2" }] });

    await expect(c.getScopeId("x_dup")).rejects.toThrow(/ambiguous.*a1, b2/);
  });

  it("returns the single row for an unambiguous scope", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    stubGet(c, { "scope=x_one": [{ sys_id: "s1" }] });

    var rows = await unwrapSNResponse(c.getScopeId("x_one"));

    expect(rows).toEqual([{ sys_id: "s1" }]);
  });

  it("returns no rows for an unknown scope (callers handle the empty case)", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    stubGet(c, {});

    var rows = await unwrapSNResponse(c.getScopeId("x_missing"));

    expect(rows).toEqual([]);
  });
});
