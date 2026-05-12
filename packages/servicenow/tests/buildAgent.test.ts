/**
 * buildAgent.runQuery / getTableSchema fallback tests.
 *
 * The contract: try the sn_build_agent endpoint first; on 403 (role missing)
 * or 404 (app not deployed), fall back transparently to the plain Table API
 * (or sys_dictionary for getTableSchema). On other errors, propagate.
 */

import axios from "axios";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

interface ScriptedRequest {
  match: RegExp;
  status: number;
  data: any;
}

function installAxiosScript(reqs: Array<ScriptedRequest>): Array<{ url: string; method: string }> {
  var seen: Array<{ url: string; method: string }> = [];
  var instance: any = {
    request: function (cfg: any) {
      var url = cfg.url as string;
      var method = (cfg.method || "GET") as string;
      seen.push({ url: url, method: method });
      for (var i = 0; i < reqs.length; i++) {
        if (reqs[i].match.test(url)) {
          return Promise.resolve({ status: reqs[i].status, data: reqs[i].data });
        }
      }
      return Promise.resolve({ status: 500, data: { error: "no script matched: " + url } });
    },
  };
  // axios.create is what client.ts calls.
  (mockedAxios as any).create = jest.fn(function () { return instance; });
  return seen;
}

describe("buildAgent.runQuery fallback", function () {
  beforeEach(function () {
    process.env.SN_INSTANCE = "test.service-now.com";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
  });

  it("uses sn_build_agent endpoint when available", async function () {
    var seen = installAxiosScript([
      {
        match: /\/api\/sn_build_agent\/build_agent_api\/runQuery\/table\/sys_hub_flow/,
        status: 200,
        data: { result: [{ sys_id: "f1", name: "N" }] },
      },
    ]);
    // Lazy require so the jest.mock is in effect.
    var clientModule = require("../src/client");
    var client = clientModule.createClient();
    var rows = await client.buildAgent.runQuery({ table: "sys_hub_flow", query: "active=true" });
    expect(rows).toEqual([{ sys_id: "f1", name: "N" }]);
    expect(seen[0].url).toContain("/api/sn_build_agent/build_agent_api/runQuery/table/sys_hub_flow");
  });

  it("falls back to plain Table API on 403", async function () {
    var seen = installAxiosScript([
      {
        match: /\/api\/sn_build_agent\/build_agent_api\/runQuery/,
        status: 403,
        data: { error: { message: "no role" } },
      },
      {
        match: /\/api\/now\/table\/sys_hub_flow/,
        status: 200,
        data: { result: [{ sys_id: "fb1", name: "fallback" }] },
      },
    ]);
    var clientModule = require("../src/client");
    var client = clientModule.createClient();
    var rows = await client.buildAgent.runQuery({ table: "sys_hub_flow", query: "active=true" });
    expect(rows).toEqual([{ sys_id: "fb1", name: "fallback" }]);
    // Two requests: build_agent first, then plain Table API.
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toContain("/api/sn_build_agent/");
    expect(seen[1].url).toContain("/api/now/table/sys_hub_flow");
  });

  it("falls back to plain Table API on 404 (sn_build_agent not deployed)", async function () {
    var seen = installAxiosScript([
      {
        match: /\/api\/sn_build_agent\/build_agent_api\/runQuery/,
        status: 404,
        data: { error: { message: "not found" } },
      },
      {
        match: /\/api\/now\/table\/sys_hub_flow_input/,
        status: 200,
        data: { result: [] },
      },
    ]);
    var clientModule = require("../src/client");
    var client = clientModule.createClient();
    var rows = await client.buildAgent.runQuery({ table: "sys_hub_flow_input", query: "flow=x" });
    expect(rows).toEqual([]);
    expect(seen[0].url).toContain("/api/sn_build_agent/");
    expect(seen[1].url).toContain("/api/now/table/sys_hub_flow_input");
  });

  it("does NOT fall back on 500 — surfaces the server error after retries", async function () {
    var seen = installAxiosScript([
      {
        match: /\/api\/sn_build_agent\//,
        status: 500,
        data: { error: { message: "boom" } },
      },
    ]);
    var clientModule = require("../src/client");
    var client = clientModule.createClient({ maxRetries5xx: 0 });
    await expect(client.buildAgent.runQuery({ table: "sys_hub_flow", query: "" }))
      .rejects.toThrow(/SN 500/);
    // Should NOT have called the Table API fallback.
    expect(seen.every(function (r) { return r.url.indexOf("/api/now/table/") < 0; })).toBe(true);
  });

  it("accepts both { result: [...] } and bare-array response shapes", async function () {
    installAxiosScript([
      { match: /\/api\/sn_build_agent\//, status: 200, data: [{ sys_id: "bare" }] },
    ]);
    var clientModule = require("../src/client");
    var client = clientModule.createClient();
    var rows = await client.buildAgent.runQuery({ table: "sys_hub_flow", query: "" });
    expect(rows).toEqual([{ sys_id: "bare" }]);
  });
});

describe("buildAgent.getTableSchema fallback", function () {
  beforeEach(function () {
    process.env.SN_INSTANCE = "test.service-now.com";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
  });

  it("returns the sn_build_agent schema when available", async function () {
    installAxiosScript([
      {
        match: /\/api\/sn_build_agent\/build_agent_api\/getTableSchema\/sys_hub_flow/,
        status: 200,
        data: {
          result: {
            fields: [
              { name: "name", type: "string", mandatory: true, reference_table: null },
              { name: "sys_scope", type: "reference", mandatory: true, reference_table: "sys_scope" },
            ],
            primary_key: "sys_id",
          },
        },
      },
    ]);
    var clientModule = require("../src/client");
    var client = clientModule.createClient();
    var schema = await client.buildAgent.getTableSchema("sys_hub_flow");
    expect(schema.primary_key).toBe("sys_id");
    expect(schema.fields).toHaveLength(2);
    expect(schema.fields[1].reference_table).toBe("sys_scope");
  });

  it("falls back to sys_dictionary on 404, synthesizing the schema", async function () {
    var seen = installAxiosScript([
      {
        match: /\/api\/sn_build_agent\//,
        status: 404,
        data: { error: { message: "not deployed" } },
      },
      {
        match: /\/api\/now\/table\/sys_dictionary/,
        status: 200,
        data: {
          result: [
            { element: "name", internal_type: "string", mandatory: "true", reference_table: "" },
            { element: "active", internal_type: "boolean", mandatory: "false", reference_table: "" },
            { element: "sys_scope", internal_type: "reference", mandatory: "true", reference_table: "sys_scope" },
          ],
        },
      },
    ]);
    var clientModule = require("../src/client");
    var client = clientModule.createClient();
    var schema = await client.buildAgent.getTableSchema("sys_hub_flow");
    expect(schema.primary_key).toBe("sys_id");
    expect(schema.fields.find(function (f: any) { return f.name === "name"; })).toEqual({
      name: "name",
      type: "string",
      mandatory: true,
      reference_table: null,
    });
    expect(schema.fields.find(function (f: any) { return f.name === "sys_scope"; }))
      .toEqual({ name: "sys_scope", type: "reference", mandatory: true, reference_table: "sys_scope" });
    // Both endpoints were called.
    expect(seen[0].url).toContain("/api/sn_build_agent/");
    expect(seen[1].url).toContain("/api/now/table/sys_dictionary");
  });
});
