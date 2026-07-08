// Tests for the createRecord sys_db_object guard. A bare insert into
// sys_db_object creates only an orphaned metadata row (no physical table,
// no ACLs), so createRecord must refuse it before any network call. A
// non-guarded table must still flow through to the Dovetail REST transport.

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

describe("servicenow client — createRecord sys_db_object guard", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    process.env.SN_INSTANCE = "test.service-now.com";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_REQUEST_INTERVAL_MS = "0";
  });

  it("rejects createRecord into sys_db_object with a message mentioning sys_db_object", async function () {
    var client = createClient();

    await expect(
      client.claude.createRecord({ table: "sys_db_object", fields: {} }),
    ).rejects.toThrow(/sys_db_object/);
  });

  it("never hits the network when sys_db_object is blocked", async function () {
    var client = createClient();

    await expect(
      client.claude.createRecord({ table: "sys_db_object", fields: {} }),
    ).rejects.toThrow();

    expect(mockHttp.request).not.toHaveBeenCalled();
  });

  it("does not block a non-guarded table — createRecord flows to the Dovetail REST transport", async function () {
    mockHttp.request.mockResolvedValueOnce(ok({ sys_id: "rec1" }));
    var client = createClient();

    var result = await client.claude.createRecord({
      table: "x_cadso_core_setting",
      fields: { name: "demo" },
    });

    expect(result).toEqual({ sys_id: "rec1" });
    expect(mockHttp.request).toHaveBeenCalledTimes(1);
    var call = mockHttp.request.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/api/cadso/dovetail_core/createRecord");
    expect(call.data).toEqual({
      table: "x_cadso_core_setting",
      fields: { name: "demo" },
    });
  });
});
