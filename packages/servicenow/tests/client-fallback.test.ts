// Tests for the /api/cadso/dovetail_core/* -> /api/cadso/dovetail/* 404 fallback
// in packages/servicenow/src/client.ts (the `dovetailRequest` helper, exposed
// through the `client.claude.*` namespace).

var mockHttp = {
  request: jest.fn(),
};

jest.mock("axios", function () {
  return {
    default: { create: jest.fn(function () { return mockHttp; }) },
    create: jest.fn(function () { return mockHttp; }),
  };
});

import { createClient } from "../src/client";

function ok(result: any) {
  return { status: 200, data: { result: result } };
}

function notFound() {
  return { status: 404, data: { error: { message: "endpoint not found" } } };
}

function unauth() {
  return { status: 401, data: { error: { message: "unauthorized" } } };
}

describe("servicenow client dovetail->claude 404 fallback", function () {
  var warnSpy: jest.SpyInstance;

  beforeEach(function () {
    jest.clearAllMocks();
    process.env.SN_INSTANCE = "test.service-now.com";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_REQUEST_INTERVAL_MS = "0";
    warnSpy = jest.spyOn(console, "warn").mockImplementation(function () { /* swallow */ });
  });

  afterEach(function () {
    warnSpy.mockRestore();
  });

  it("first call hits /api/cadso/dovetail_core/<op>", async function () {
    mockHttp.request.mockResolvedValueOnce(ok({ sys_id: "abc" }));
    var client = createClient();

    await client.claude.currentUpdateSet();

    expect(mockHttp.request).toHaveBeenCalledTimes(1);
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.url).toBe("/api/cadso/dovetail_core/currentUpdateSet");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("on 404, retries against /api/cadso/dovetail/<op> and warns once", async function () {
    mockHttp.request
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(ok({ sys_id: "abc" }));
    var client = createClient();

    var result = await client.claude.currentUpdateSet();

    expect(result).toEqual({ sys_id: "abc" });
    expect(mockHttp.request).toHaveBeenCalledTimes(2);
    expect(mockHttp.request.mock.calls[0][0].url).toBe("/api/cadso/dovetail_core/currentUpdateSet");
    expect(mockHttp.request.mock.calls[1][0].url).toBe("/api/cadso/dovetail/currentUpdateSet");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("[deprecation]");
    expect(warnSpy.mock.calls[0][0]).toContain("/api/cadso/dovetail_core/currentUpdateSet");
  });

  it("after latching, subsequent calls go straight to /api/cadso/dovetail/<op>", async function () {
    mockHttp.request
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(ok({ sys_id: "abc" }))
      .mockResolvedValueOnce(ok({ sys_id: "def" }))
      .mockResolvedValueOnce(ok({ sys_id: "ghi" }));
    var client = createClient();

    await client.claude.currentUpdateSet();
    await client.claude.createRecord({ table: "incident", fields: { short_description: "x" } });
    await client.claude.pushWithUpdateSet({
      update_set_sys_id: "us1",
      table: "incident",
      record_sys_id: "rec1",
      fields: {},
    });

    expect(mockHttp.request).toHaveBeenCalledTimes(4);
    expect(mockHttp.request.mock.calls[2][0].url).toBe("/api/cadso/dovetail/createRecord");
    expect(mockHttp.request.mock.calls[3][0].url).toBe("/api/cadso/dovetail/pushWithUpdateSet");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back on 401 (auth error throws immediately)", async function () {
    mockHttp.request.mockResolvedValueOnce(unauth());
    var client = createClient();

    await expect(client.claude.currentUpdateSet()).rejects.toThrow(/SN auth error 401/);

    expect(mockHttp.request).toHaveBeenCalledTimes(1);
    expect(mockHttp.request.mock.calls[0][0].url).toBe("/api/cadso/dovetail_core/currentUpdateSet");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("each createClient() call gets a fresh fallback latch (closure isolation)", async function () {
    mockHttp.request.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(ok({}));
    var clientA = createClient();
    await clientA.claude.currentUpdateSet();
    // clientA latched. Now create a fresh client — should start on dovetail again.

    mockHttp.request.mockResolvedValueOnce(ok({ sys_id: "abc" }));
    var clientB = createClient();
    await clientB.claude.currentUpdateSet();

    var lastCall = mockHttp.request.mock.calls[mockHttp.request.mock.calls.length - 1][0];
    expect(lastCall.url).toBe("/api/cadso/dovetail_core/currentUpdateSet");
  });
});
