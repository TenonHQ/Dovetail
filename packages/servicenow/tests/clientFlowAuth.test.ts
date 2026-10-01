/**
 * Flow Designer (processflow) identity tests: /api/now/processflow/* cannot
 * carry a REST API access policy, so under API-key auth those calls go out as
 * basic auth with the dedicated SN_FLOW_* identity — and every other path keeps
 * the main identity untouched.
 */

var createdConfigs: Array<any> = [];
var createdInstances: Array<{ request: jest.Mock }> = [];

jest.mock("axios", function () {
  var create = jest.fn(function (cfg: any) {
    var inst = {
      request: jest.fn(async function () {
        return { status: 200, data: { result: [] } };
      })
    };
    createdConfigs.push(cfg);
    createdInstances.push(inst);
    return inst;
  });
  return { default: { create: create }, create: create };
});

import { createClient, resolveFlowAuth, isProcessflowPath } from "../src/client";

var KEYS = [
  "SN_INSTANCE", "SN_DEV_INSTANCE", "SN_PROD_INSTANCE",
  "SN_USER", "SN_PASSWORD",
  "SN_DEV_USERNAME", "SN_DEV_PASSWORD",
  "SN_PROD_USERNAME", "SN_PROD_PASSWORD",
  "SN_API_KEY", "SN_DEV_API_KEY", "SN_PROD_API_KEY",
  "SN_FLOW_USER", "SN_FLOW_PASSWORD",
  "SN_DEV_FLOW_USER", "SN_DEV_FLOW_PASSWORD",
  "SN_PROD_FLOW_USER", "SN_PROD_FLOW_PASSWORD",
  "SN_REQUEST_INTERVAL_MS"
];

describe("createClient — Flow Designer (processflow) identity", function () {
  var saved: Record<string, string | undefined> = {};

  beforeEach(function () {
    createdConfigs.length = 0;
    createdInstances.length = 0;
    KEYS.forEach(function (k) {
      saved[k] = process.env[k];
      delete process.env[k];
    });
    process.env.SN_INSTANCE = "test.service-now.com";
    process.env.SN_REQUEST_INTERVAL_MS = "0";
  });

  afterEach(function () {
    KEYS.forEach(function (k) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    });
  });

  it("key mode + flow creds: a processflow request uses basic flow creds and NO x-sn-apikey", async function () {
    process.env.SN_API_KEY = "key-abc";
    process.env.SN_FLOW_USER = "flow.bot";
    process.env.SN_FLOW_PASSWORD = "flow-pass";
    var client = createClient({});

    await client.now.get("/api/now/processflow/action/action_types/abc?sysparm_transaction_scope=s");

    expect(createdConfigs).toHaveLength(2);
    var flowCfg = createdConfigs[1];
    expect(flowCfg.auth).toEqual({ username: "flow.bot", password: "flow-pass" });
    expect(flowCfg.headers["x-sn-apikey"]).toBeUndefined();
    expect(Object.keys(flowCfg.headers)).not.toContain("x-sn-apikey");
    // Sent on the flow transport, not the main (key) one.
    expect(createdInstances[1].request).toHaveBeenCalledTimes(1);
    expect(createdInstances[0].request).not.toHaveBeenCalled();
    var sent = createdInstances[1].request.mock.calls[0][0];
    expect(sent.headers).toBeUndefined();
  });

  it("key mode + flow creds: a table request in the same client still uses the key", async function () {
    process.env.SN_API_KEY = "key-abc";
    process.env.SN_FLOW_USER = "flow.bot";
    process.env.SN_FLOW_PASSWORD = "flow-pass";
    var client = createClient({});

    await client.table.query("sys_user", "active=true", 1);

    expect(createdInstances[0].request).toHaveBeenCalledTimes(1);
    expect(createdConfigs[0].headers["x-sn-apikey"]).toBe("key-abc");
    expect(createdConfigs[0].auth).toBeUndefined();
    // The flow transport is lazy — never created for a non-processflow call.
    expect(createdConfigs).toHaveLength(1);
  });

  it("key mode WITHOUT flow creds: a processflow request throws a clear error and sends nothing", async function () {
    process.env.SN_API_KEY = "key-abc";
    var client = createClient({});

    var err: Error | null = null;
    try {
      await client.now.post("/api/now/processflow/action/action_types/abc/snapshot", {});
    } catch (e: unknown) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(String(err && err.message)).toMatch(/SN_FLOW_USER/);
    expect(String(err && err.message)).toMatch(/SN_FLOW_PASSWORD/);
    expect(String(err && err.message)).toMatch(/access policy/);
    expect(createdInstances[0].request).not.toHaveBeenCalled();
    expect(createdConfigs).toHaveLength(1);
  });

  it("the error never contains the configured key", async function () {
    process.env.SN_API_KEY = "key-abc-secret";
    var client = createClient({});
    await expect(client.now.get("/api/now/processflow/flow/x")).rejects.toThrow(/SN_FLOW_USER/);
    await client.now.get("/api/now/processflow/flow/x").catch(function (e: Error) {
      expect(e.message).not.toContain("key-abc-secret");
    });
  });

  it("basic mode WITHOUT flow creds: processflow is unchanged (main basic creds, one transport)", async function () {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    var client = createClient({});

    await client.now.get("/api/now/processflow/flow/abc");

    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0].auth).toEqual({ username: "u", password: "p" });
    expect(createdInstances[0].request).toHaveBeenCalledTimes(1);
  });

  it("basic mode WITH flow creds: processflow uses the flow identity", async function () {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_FLOW_USER = "flow.bot";
    process.env.SN_FLOW_PASSWORD = "flow-pass";
    var client = createClient({});

    await client.now.get("/api/now/processflow/flow/abc");

    expect(createdConfigs).toHaveLength(2);
    expect(createdConfigs[1].auth).toEqual({ username: "flow.bot", password: "flow-pass" });
  });

  it("a partial flow identity fails loudly on processflow, naming the missing var only", async function () {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_FLOW_USER = "flow.bot";
    var client = createClient({});
    await expect(client.now.get("/api/now/processflow/flow/abc")).rejects.toThrow(/SN_FLOW_PASSWORD is not set/);
    expect(createdInstances[0].request).not.toHaveBeenCalled();
  });

  it("explicit config flow creds beat env", async function () {
    process.env.SN_FLOW_USER = "env.flow";
    process.env.SN_FLOW_PASSWORD = "env-pass";
    var client = createClient({ apiKey: "k", flowUser: "cfg.flow", flowPassword: "cfg-pass" });
    await client.now.get("/api/now/processflow/flow/abc");
    expect(createdConfigs[1].auth).toEqual({ username: "cfg.flow", password: "cfg-pass" });
  });
});

describe("resolveFlowAuth", function () {
  var saved: Record<string, string | undefined> = {};
  beforeEach(function () {
    KEYS.forEach(function (k) {
      saved[k] = process.env[k];
      delete process.env[k];
    });
  });
  afterEach(function () {
    KEYS.forEach(function (k) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    });
  });

  it("falls back SN_FLOW_* > SN_DEV_FLOW_* > SN_PROD_FLOW_*", function () {
    process.env.SN_PROD_FLOW_USER = "prod";
    process.env.SN_PROD_FLOW_PASSWORD = "prodp";
    expect(resolveFlowAuth({})).toEqual({ mode: "basic", user: "prod", password: "prodp" });
    process.env.SN_DEV_FLOW_USER = "dev";
    process.env.SN_DEV_FLOW_PASSWORD = "devp";
    expect(resolveFlowAuth({})).toEqual({ mode: "basic", user: "dev", password: "devp" });
    process.env.SN_FLOW_USER = "main";
    process.env.SN_FLOW_PASSWORD = "mainp";
    expect(resolveFlowAuth({})).toEqual({ mode: "basic", user: "main", password: "mainp" });
  });

  it("a config that pins the main identity never borrows flow creds from env", function () {
    process.env.SN_FLOW_USER = "leaked";
    process.env.SN_FLOW_PASSWORD = "leakedp";
    expect(resolveFlowAuth({ apiKey: "k" })).toEqual({ mode: "none" });
    expect(resolveFlowAuth({ user: "u", password: "p" })).toEqual({ mode: "none" });
  });

  it("isProcessflowPath matches only the processflow prefix", function () {
    expect(isProcessflowPath("/api/now/processflow/flow/x")).toBe(true);
    expect(isProcessflowPath("/api/now/table/sys_hub_flow")).toBe(false);
    expect(isProcessflowPath("/api/now/processflowx")).toBe(false);
    expect(isProcessflowPath(undefined)).toBe(false);
  });
});
