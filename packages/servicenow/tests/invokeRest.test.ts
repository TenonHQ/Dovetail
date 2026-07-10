/**
 * invokeRest — the dove-sn invoke-rest / invoke_rest MCP primitive.
 *
 * Contract under test (TenonHQ/Dovetail#212):
 *   - dry-run by DEFAULT: nothing is sent (and no client/credentials are
 *     needed) unless confirm is exactly true; dryRun:true beats confirm.
 *   - method/path validation: only GET/POST/PUT/DELETE, instance-relative
 *     /api/ paths, no body on GET.
 *   - on send, the response passes through verbatim as { httpStatus, ok, body }
 *     — non-2xx included.
 *   - bodies are never logged (no console output at all).
 */

import { invokeRest } from "../src/invokeRest";
import type { NowInvokeParams, NowInvokeResponse, ServiceNowClient } from "../src/client";

var SN_ENV_KEYS = [
  "SN_INSTANCE", "SN_DEV_INSTANCE", "SN_PROD_INSTANCE",
  "SN_USER", "SN_PASSWORD",
  "SN_DEV_USERNAME", "SN_DEV_PASSWORD",
  "SN_PROD_USERNAME", "SN_PROD_PASSWORD"
];

function stubClient(response?: NowInvokeResponse): { client: ServiceNowClient; invokes: Array<NowInvokeParams> } {
  var invokes: Array<NowInvokeParams> = [];
  var client = {
    now: {
      invoke: async function (params: NowInvokeParams): Promise<NowInvokeResponse> {
        invokes.push(params);
        return response || { status: 200, body: { result: "ok" } };
      }
    }
  } as unknown as ServiceNowClient;
  return { client: client, invokes: invokes };
}

describe("invokeRest — dry-run gate", function () {
  var savedEnv: Record<string, string | undefined> = {};

  beforeEach(function () {
    SN_ENV_KEYS.forEach(function (k) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(function () {
    SN_ENV_KEYS.forEach(function (k) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    });
  });

  it("is a dry-run by default — nothing sent, no client touched", async function () {
    var ctx = stubClient();
    var result = await invokeRest({
      client: ctx.client,
      method: "DELETE",
      path: "/api/x_cadso_core/testkit/resource/abc"
    });
    expect(result.status).toBe("dry-run");
    expect(ctx.invokes).toHaveLength(0);
    expect(result.note).toContain("confirm");
  });

  it("a dry-run needs no credentials at all (no client, no SN_* env)", async function () {
    var result = await invokeRest({
      method: "GET",
      path: "/api/x_cadso_core/testkit/resource"
    });
    expect(result.status).toBe("dry-run");
  });

  it("echoes the request body on dry-run so the plan is auditable", async function () {
    var result = await invokeRest({
      method: "POST",
      path: "/api/x_cadso_core/testkit/resource",
      body: { name: "fixture" }
    });
    expect(result.status).toBe("dry-run");
    expect(result.requestBody).toEqual({ name: "fixture" });
    expect(result.method).toBe("POST");
    expect(result.path).toBe("/api/x_cadso_core/testkit/resource");
  });

  it("dryRun:true forces a dry-run even with confirm:true", async function () {
    var ctx = stubClient();
    var result = await invokeRest({
      client: ctx.client,
      method: "DELETE",
      path: "/api/x_cadso_core/testkit/resource/abc",
      confirm: true,
      dryRun: true
    });
    expect(result.status).toBe("dry-run");
    expect(ctx.invokes).toHaveLength(0);
  });

  it("only confirm === true sends — a truthy string is not enough", async function () {
    var ctx = stubClient();
    var result = await invokeRest({
      client: ctx.client,
      method: "DELETE",
      path: "/api/x_cadso_core/testkit/resource/abc",
      confirm: "yes" as unknown as boolean
    });
    expect(result.status).toBe("dry-run");
    expect(ctx.invokes).toHaveLength(0);
  });
});

describe("invokeRest — validation", function () {
  it("rejects methods outside GET/POST/PUT/DELETE", async function () {
    await expect(invokeRest({ method: "PATCH", path: "/api/x/y/z" }))
      .rejects.toThrow(/method must be one of/);
  });

  it("normalizes method case", async function () {
    var ctx = stubClient();
    var result = await invokeRest({
      client: ctx.client,
      method: "delete",
      path: "/api/x_cadso_core/testkit/resource/abc",
      confirm: true
    });
    expect(result.method).toBe("DELETE");
    expect(ctx.invokes[0].method).toBe("DELETE");
  });

  it("rejects a missing path", async function () {
    await expect(invokeRest({ method: "GET", path: "" }))
      .rejects.toThrow(/path is required/);
  });

  it("rejects paths that do not start with /api/", async function () {
    await expect(invokeRest({ method: "GET", path: "/nav_to.do" }))
      .rejects.toThrow(/start with \/api\//);
  });

  it("rejects absolute URLs", async function () {
    await expect(invokeRest({ method: "GET", path: "https://evil.example/api/now/table/x" }))
      .rejects.toThrow(/start with \/api\//);
  });

  it("rejects paths containing whitespace", async function () {
    await expect(invokeRest({ method: "GET", path: "/api/now/table/x?q=a b" }))
      .rejects.toThrow(/whitespace/);
  });

  it("rejects a request body on GET", async function () {
    await expect(invokeRest({ method: "GET", path: "/api/x/y/z", body: { nope: true } }))
      .rejects.toThrow(/not allowed with GET/);
  });
});

describe("invokeRest — send path", function () {
  it("sends via client.now.invoke and returns { httpStatus, ok, body } verbatim", async function () {
    var ctx = stubClient({ status: 201, body: { result: { sys_id: "abc" } } });
    var result = await invokeRest({
      client: ctx.client,
      method: "POST",
      path: "/api/x_cadso_core/testkit/resource",
      body: { name: "fixture" },
      confirm: true
    });
    expect(result.status).toBe("sent");
    expect(result.httpStatus).toBe(201);
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ result: { sys_id: "abc" } });
    expect(ctx.invokes).toHaveLength(1);
    expect(ctx.invokes[0]).toEqual({
      method: "POST",
      path: "/api/x_cadso_core/testkit/resource",
      body: { name: "fixture" }
    });
  });

  it("returns a non-2xx response verbatim with ok:false instead of throwing", async function () {
    var ctx = stubClient({ status: 404, body: { error: { message: "No such record" } } });
    var result = await invokeRest({
      client: ctx.client,
      method: "DELETE",
      path: "/api/x_cadso_core/testkit/resource/gone",
      confirm: true
    });
    expect(result.status).toBe("sent");
    expect(result.httpStatus).toBe(404);
    expect(result.ok).toBe(false);
    expect(result.body).toEqual({ error: { message: "No such record" } });
    expect(result.note).toContain("404");
  });

  it("hints at credentials on 401/403 without throwing", async function () {
    var ctx = stubClient({ status: 403, body: { error: { message: "Insufficient rights" } } });
    var result = await invokeRest({
      client: ctx.client,
      method: "PUT",
      path: "/api/x_cadso_core/testkit/resource/abc",
      body: { name: "x" },
      confirm: true
    });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("ACLs");
  });

  it("never logs request or response bodies (no console output at all)", async function () {
    var logSpy = jest.spyOn(console, "log").mockImplementation(function () { /* record only */ });
    var warnSpy = jest.spyOn(console, "warn").mockImplementation(function () { /* record only */ });
    var errorSpy = jest.spyOn(console, "error").mockImplementation(function () { /* record only */ });
    var infoSpy = jest.spyOn(console, "info").mockImplementation(function () { /* record only */ });
    try {
      var ctx = stubClient({ status: 500, body: { secret: "caller payload" } });
      await invokeRest({
        client: ctx.client,
        method: "POST",
        path: "/api/x_cadso_core/testkit/resource",
        body: { secret: "caller payload" },
        confirm: true
      });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
