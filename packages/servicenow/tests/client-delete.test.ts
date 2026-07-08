// Tests for the deleteRecord + changeUpdateSet client methods added for the
// form/list layout tooling — verifies they hit the right Dovetail REST endpoints.

var mockHttp = {
  request: jest.fn(),
};

jest.mock("axios", function () {
  return {
    default: {
      create: jest.fn(function () {
        return mockHttp;
      }),
    },
    create: jest.fn(function () {
      return mockHttp;
    }),
  };
});

import { createClient } from "../src/client";

function ok(result: any) {
  return { status: 200, data: { result: result } };
}

describe("servicenow client — deleteRecord & changeUpdateSet", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    process.env.SN_INSTANCE = "test.service-now.com";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_REQUEST_INTERVAL_MS = "0";
  });

  it("deleteRecord POSTs to /api/cadso/dovetail_core/deleteRecord with table + sys_id", async function () {
    mockHttp.request.mockResolvedValueOnce(ok({ name: "Old Element" }));
    var client = createClient();

    var result = await client.claude.deleteRecord({
      table: "sys_ui_element",
      sys_id: "el1",
    });

    expect(result).toEqual({ name: "Old Element" });
    expect(mockHttp.request).toHaveBeenCalledTimes(1);
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/api/cadso/dovetail_core/deleteRecord");
    expect(call.data).toEqual({ table: "sys_ui_element", sys_id: "el1" });
  });

  it("changeUpdateSet GETs /api/cadso/dovetail_core/changeUpdateSet with the sysId param", async function () {
    mockHttp.request.mockResolvedValueOnce(ok({ sys_id: "us1" }));
    var client = createClient();

    await client.claude.changeUpdateSet({ sysId: "us1" });

    expect(mockHttp.request).toHaveBeenCalledTimes(1);
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.method).toBe("GET");
    expect(call.url).toBe("/api/cadso/dovetail_core/changeUpdateSet");
    expect(call.params).toEqual({ sysId: "us1" });
  });

  it("deleteRecord falls back to /api/cadso/dovetail/deleteRecord on a 404", async function () {
    mockHttp.request
      .mockResolvedValueOnce({
        status: 404,
        data: { error: { message: "not found" } },
      })
      .mockResolvedValueOnce(ok({ name: "Old Element" }));
    var warnSpy = jest.spyOn(console, "warn").mockImplementation(function () {
      /* swallow */
    });
    var client = createClient();

    await client.claude.deleteRecord({
      table: "sys_ui_element",
      sys_id: "el1",
    });

    expect(mockHttp.request).toHaveBeenCalledTimes(2);
    expect(mockHttp.request.mock.calls[1][0].url).toBe(
      "/api/cadso/dovetail/deleteRecord",
    );
    warnSpy.mockRestore();
  });
});
