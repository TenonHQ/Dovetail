// Tests for snClient.createUpdateSet: it must prefer the scope-safe Dovetail
// `createUpdateSet` server op (normalizing its {sys_id,...} body to the
// {result:{...}} shape unwrapSNResponse expects), and fall back to the raw
// Table API ONLY when the endpoint is missing (404 / 400 "Requested URI ...").
// A 500 or an unrelated 400 must NOT trigger the fallback.

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  getLogLevel: function () { return "debug"; },
};

jest.mock("../Logger", function () {
  return { logger: mockLogger };
});

jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
});

jest.mock("../genericUtils", function () {
  return { wait: jest.fn().mockResolvedValue(undefined) };
});

import { snClient, _resetDovetailApiFallback } from "../snClient";

function makeAxiosError(status: number, data?: any): any {
  var error: any = new Error("Request failed with status " + status);
  error.isAxiosError = true;
  error.response = { status: status, headers: {}, data: data === undefined ? {} : data };
  return error;
}

function makeAxiosResponse<T>(data: T): any {
  return { status: 200, data: data, headers: {}, statusText: "OK", config: {} };
}

var MISSING_ENDPOINT_BODY = {
  error: { message: "Requested URI does not represent any resource", detail: null },
  status: "failure",
};

describe("snClient.createUpdateSet", function () {
  beforeEach(function () {
    _resetDovetailApiFallback();
    jest.clearAllMocks();
  });

  it("calls the createUpdateSet endpoint and normalizes the response to {result}", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    var post = jest.spyOn(c.client, "post").mockImplementation(async function () {
      return makeAxiosResponse({ success: true, sys_id: "abc123", name: "My Set", application: "scopeSys" });
    });

    var resp = await c.createUpdateSet("My Set", "scopeSys", "a description");

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toContain("dovetail_core/createUpdateSet");
    expect(post.mock.calls[0][1]).toMatchObject({
      name: "My Set",
      application: "scopeSys",
      description: "a description",
      state: "in progress",
    });
    expect((resp.data as any).result.sys_id).toBe("abc123");
    expect((resp.data as any).result.application).toBe("scopeSys");
  });

  it("falls back to the Table API when the endpoint 404s", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    var urls: string[] = [];
    jest.spyOn(c.client, "post").mockImplementation(async function (url: string) {
      urls.push(url);
      if (url.indexOf("dovetail") !== -1) {
        throw makeAxiosError(404, {});
      }
      return makeAxiosResponse({ result: { sys_id: "tbl1", name: "My Set" } });
    });

    var resp = await c.createUpdateSet("My Set", "scopeSys");

    // dovetail_core -> legacy dovetail (404 fallback) -> Table API
    expect(urls[urls.length - 1]).toBe("api/now/table/sys_update_set");
    expect((resp.data as any).result.sys_id).toBe("tbl1");
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("falls back to the Table API on the 400 missing-endpoint body", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    var urls: string[] = [];
    jest.spyOn(c.client, "post").mockImplementation(async function (url: string) {
      urls.push(url);
      if (url.indexOf("dovetail") !== -1) {
        throw makeAxiosError(400, MISSING_ENDPOINT_BODY);
      }
      return makeAxiosResponse({ result: { sys_id: "tbl2", name: "My Set" } });
    });

    var resp = await c.createUpdateSet("My Set", "scopeSys");

    expect(urls[urls.length - 1]).toBe("api/now/table/sys_update_set");
    expect((resp.data as any).result.sys_id).toBe("tbl2");
  });

  it("does NOT fall back on an unrelated 400 (rethrows)", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    var tableHit = false;
    jest.spyOn(c.client, "post").mockImplementation(async function (url: string) {
      if (url.indexOf("dovetail") !== -1) {
        throw makeAxiosError(400, { error: { message: "Invalid update set name" } });
      }
      tableHit = true;
      return makeAxiosResponse({ result: { sys_id: "should-not-happen" } });
    });

    await expect(c.createUpdateSet("My Set", "scopeSys")).rejects.toBeDefined();
    expect(tableHit).toBe(false);
  });

  it("does NOT fall back on a 500 (rethrows)", async function () {
    var c = snClient("https://x.service-now.com/", "u", "p");
    var tableHit = false;
    jest.spyOn(c.client, "post").mockImplementation(async function (url: string) {
      if (url.indexOf("dovetail") !== -1) {
        throw makeAxiosError(500, { error: { message: "boom" } });
      }
      tableHit = true;
      return makeAxiosResponse({ result: { sys_id: "should-not-happen" } });
    });

    await expect(c.createUpdateSet("My Set", "scopeSys")).rejects.toBeDefined();
    expect(tableHit).toBe(false);
  });
});
