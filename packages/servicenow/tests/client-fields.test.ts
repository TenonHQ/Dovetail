// --- Mock setup (must be before imports) ---

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

// --- Imports (after mocks) ---

import { createClient } from "../src/client";

function makeOk(result: any[]) {
  return { status: 200, data: { result: result } };
}

describe("client.table.query overloads", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    process.env.SN_INSTANCE = "test.service-now.com";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_REQUEST_INTERVAL_MS = "0";
  });

  it("uses default limit and no sysparm_fields when limit arg is omitted", async function () {
    mockHttp.request.mockResolvedValueOnce(makeOk([{ sys_id: "abc" }]));
    var client = createClient();
    var rows = await client.table.query("incident", "active=true");
    expect(rows).toEqual([{ sys_id: "abc" }]);
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.method).toBe("GET");
    expect(call.url).toBe("/api/now/table/incident");
    expect(call.params).toEqual({
      sysparm_query: "active=true",
      sysparm_limit: 100,
      sysparm_display_value: false,
    });
    expect(call.params.sysparm_fields).toBeUndefined();
  });

  it("accepts a numeric limit (back-compat 3-arg form)", async function () {
    mockHttp.request.mockResolvedValueOnce(makeOk([]));
    var client = createClient();
    await client.table.query("incident", "active=true", 25);
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.params.sysparm_limit).toBe(25);
    expect(call.params.sysparm_fields).toBeUndefined();
  });

  it("accepts an options object with fields and joins them with commas", async function () {
    mockHttp.request.mockResolvedValueOnce(makeOk([]));
    var client = createClient();
    await client.table.query("incident", "active=true", {
      limit: 50,
      fields: ["sys_id", "number", "short_description"],
    });
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.params.sysparm_limit).toBe(50);
    expect(call.params.sysparm_fields).toBe("sys_id,number,short_description");
  });

  it("defaults limit to 100 when only fields are provided in the options form", async function () {
    mockHttp.request.mockResolvedValueOnce(makeOk([]));
    var client = createClient();
    await client.table.query("incident", "active=true", { fields: ["sys_id"] });
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.params.sysparm_limit).toBe(100);
    expect(call.params.sysparm_fields).toBe("sys_id");
  });

  it("omits sysparm_fields when fields is an empty array", async function () {
    mockHttp.request.mockResolvedValueOnce(makeOk([]));
    var client = createClient();
    await client.table.query("incident", "active=true", {
      limit: 10,
      fields: [],
    });
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.params.sysparm_fields).toBeUndefined();
  });
});
