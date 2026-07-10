// Tests for the now.put / now.delete / now.invoke client methods added for
// dove-sn invoke-rest (TenonHQ/Dovetail#212) — verifies they ride the shared
// transport, that invoke passes non-2xx responses through verbatim, and that
// the pre-existing get/post error contract is unchanged by the requestRaw
// refactor.

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

describe("servicenow client — now.put / now.delete / now.invoke", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    process.env.SN_INSTANCE = "test.service-now.com";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_REQUEST_INTERVAL_MS = "0";
  });

  it("now.put PUTs the body to the path and returns the response body", async function () {
    mockHttp.request.mockResolvedValueOnce({ status: 200, data: { result: "updated" } });
    var client = createClient();

    var result = await client.now.put("/api/x_cadso_core/testkit/resource/abc", { name: "n" });

    expect(result).toEqual({ result: "updated" });
    expect(mockHttp.request).toHaveBeenCalledTimes(1);
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("/api/x_cadso_core/testkit/resource/abc");
    expect(call.data).toEqual({ name: "n" });
  });

  it("now.delete DELETEs the path", async function () {
    mockHttp.request.mockResolvedValueOnce({ status: 204, data: "" });
    var client = createClient();

    await client.now.delete("/api/x_cadso_core/testkit/resource/abc");

    expect(mockHttp.request).toHaveBeenCalledTimes(1);
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.method).toBe("DELETE");
    expect(call.url).toBe("/api/x_cadso_core/testkit/resource/abc");
  });

  it("now.invoke returns { status, body } on 2xx", async function () {
    mockHttp.request.mockResolvedValueOnce({ status: 201, data: { result: { sys_id: "abc" } } });
    var client = createClient();

    var response = await client.now.invoke({
      method: "POST",
      path: "/api/x_cadso_core/testkit/resource",
      body: { name: "n" }
    });

    expect(response).toEqual({ status: 201, body: { result: { sys_id: "abc" } } });
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/api/x_cadso_core/testkit/resource");
    expect(call.data).toEqual({ name: "n" });
  });

  it("now.invoke passes a 404 through verbatim instead of throwing", async function () {
    mockHttp.request.mockResolvedValueOnce({ status: 404, data: { error: { message: "nope" } } });
    var client = createClient();

    var response = await client.now.invoke({
      method: "DELETE",
      path: "/api/x_cadso_core/testkit/resource/gone"
    });

    expect(response).toEqual({ status: 404, body: { error: { message: "nope" } } });
  });

  it("now.invoke passes a 403 through verbatim instead of throwing", async function () {
    mockHttp.request.mockResolvedValueOnce({ status: 403, data: { error: { message: "denied" } } });
    var client = createClient();

    var response = await client.now.invoke({ method: "GET", path: "/api/now/table/x" });

    expect(response.status).toBe(403);
  });

  it("now.invoke returns the last 5xx response verbatim once retries are exhausted", async function () {
    mockHttp.request.mockResolvedValue({ status: 503, data: { error: "down" } });
    var client = createClient({ maxRetries5xx: 0, maxRetries429: 0 });

    var response = await client.now.invoke({ method: "GET", path: "/api/now/table/x" });

    expect(response).toEqual({ status: 503, body: { error: "down" } });
  });

  it("now.invoke still throws on a network failure (no HTTP response at all)", async function () {
    mockHttp.request.mockRejectedValue(new Error("ECONNREFUSED"));
    var client = createClient({ maxRetries5xx: 0 });

    await expect(client.now.invoke({ method: "GET", path: "/api/now/table/x" }))
      .rejects.toThrow(/SN network error/);
  });

  it("now.get still throws on 404 — the pre-existing contract is unchanged", async function () {
    mockHttp.request.mockResolvedValueOnce({ status: 404, data: { error: {} } });
    var client = createClient();

    await expect(client.now.get("/api/now/processflow/flow/missing"))
      .rejects.toThrow(/SN 404/);
  });

  it("now.put surfaces auth errors with the standard message", async function () {
    mockHttp.request.mockResolvedValueOnce({ status: 401, data: {} });
    var client = createClient();

    await expect(client.now.put("/api/now/table/x/1", {}))
      .rejects.toThrow(/SN auth error 401/);
  });
});
