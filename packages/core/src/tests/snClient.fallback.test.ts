// Tests for the /api/cadso/dovetail_core/* -> /api/cadso/dovetail/* 404 fallback
// in _callDovetailApi (snClient.ts). Covers: first call hits the dovetail
// endpoint, 404 latches the legacy path with a one-time warning, subsequent
// calls skip dovetail, and non-404 errors do NOT trigger fallback.

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

import {
  _callDovetailApi,
  _resetDovetailApiFallback,
  _isUsingLegacyPath,
} from "../snClient";

function makeAxiosError(status: number, data?: any): any {
  var error: any = new Error("Request failed with status " + status);
  error.isAxiosError = true;
  error.response = { status: status, headers: {}, data: data === undefined ? {} : data };
  return error;
}

function makeAxiosResponse<T>(data: T): { status: number; data: T; headers: any; statusText: string; config: any } {
  return { status: 200, data: data, headers: {}, statusText: "OK", config: {} };
}

describe("_callDovetailApi 404 fallback", function () {
  beforeEach(function () {
    _resetDovetailApiFallback();
    jest.clearAllMocks();
  });

  it("first request hits /api/cadso/dovetail_core/<op>", async function () {
    var seen: string[] = [];
    var call = jest.fn(async function (endpoint: string) {
      seen.push(endpoint);
      return makeAxiosResponse({ ok: true });
    });

    await _callDovetailApi("changeScope", call);

    expect(seen).toEqual(["api/cadso/dovetail_core/changeScope"]);
    expect(_isUsingLegacyPath()).toBe(false);
  });

  it("on 404, retries against legacy /api/cadso/dovetail/<op> and warns once", async function () {
    var seen: string[] = [];
    var call = jest.fn(async function (endpoint: string) {
      seen.push(endpoint);
      if (endpoint.indexOf("api/cadso/dovetail_core/") === 0) {
        throw makeAxiosError(404);
      }
      return makeAxiosResponse({ ok: true });
    });

    var result = await _callDovetailApi<{ ok: boolean }>("changeScope", call);

    expect(result.data).toEqual({ ok: true });
    expect(seen).toEqual([
      "api/cadso/dovetail_core/changeScope",
      "api/cadso/dovetail/changeScope",
    ]);
    expect(_isUsingLegacyPath()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toContain("[deprecation]");
    expect(mockLogger.warn.mock.calls[0][0]).toContain("/api/cadso/dovetail_core/changeScope");
    expect(mockLogger.warn.mock.calls[0][0]).toContain("/api/cadso/dovetail/changeScope");
  });

  it("after latching, subsequent calls skip dovetail and warn no more", async function () {
    var seen: string[] = [];
    var call = jest.fn(async function (endpoint: string) {
      seen.push(endpoint);
      if (endpoint.indexOf("api/cadso/dovetail_core/") === 0) {
        throw makeAxiosError(404);
      }
      return makeAxiosResponse({ ok: true });
    });

    await _callDovetailApi("currentUpdateSet", call);
    seen.length = 0;
    mockLogger.warn.mockClear();

    await _callDovetailApi("changeScope", call);
    await _callDovetailApi("changeUpdateSet", call);

    expect(seen).toEqual([
      "api/cadso/dovetail/changeScope",
      "api/cadso/dovetail/changeUpdateSet",
    ]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("does NOT fall back on 401 (auth failure)", async function () {
    var call = jest.fn(async function (_endpoint: string) {
      throw makeAxiosError(401);
    });

    await expect(_callDovetailApi("changeScope", call)).rejects.toMatchObject({
      response: { status: 401 },
    });

    expect(call).toHaveBeenCalledTimes(1);
    expect(_isUsingLegacyPath()).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("does NOT fall back on 500 (server error)", async function () {
    var call = jest.fn(async function (_endpoint: string) {
      throw makeAxiosError(500);
    });

    await expect(_callDovetailApi("changeScope", call)).rejects.toMatchObject({
      response: { status: 500 },
    });

    expect(call).toHaveBeenCalledTimes(1);
    expect(_isUsingLegacyPath()).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("does NOT fall back on a network error with no response", async function () {
    var call = jest.fn(async function (_endpoint: string) {
      throw new Error("ECONNREFUSED");
    });

    await expect(_callDovetailApi("changeScope", call)).rejects.toThrow("ECONNREFUSED");

    expect(call).toHaveBeenCalledTimes(1);
    expect(_isUsingLegacyPath()).toBe(false);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  describe("descriptive error enrichment", function () {
    it("includes status, endpoint, and response body on a 401", async function () {
      var call = jest.fn(async function (_endpoint: string) {
        throw makeAxiosError(401, { error: { message: "User Not Authenticated" } });
      });

      try {
        await _callDovetailApi("changeScope", call);
        throw new Error("expected rejection");
      } catch (e: any) {
        expect(e.response.status).toBe(401);
        expect(e.message).toContain("HTTP 401");
        expect(e.message).toContain("api/cadso/dovetail_core/changeScope");
        expect(e.message).toContain("User Not Authenticated");
      }
    });

    it("adds the missing-endpoint hint when SN returns its 400 'Requested URI does not represent any resource'", async function () {
      var snBody = {
        error: { message: "Requested URI does not represent any resource", detail: null },
        status: "failure",
      };
      var call = jest.fn(async function (_endpoint: string) {
        throw makeAxiosError(400, snBody);
      });

      try {
        await _callDovetailApi("changeScope", call);
        throw new Error("expected rejection");
      } catch (e: any) {
        expect(e.response.status).toBe(400);
        expect(e.message).toContain("HTTP 400");
        expect(e.message).toContain("api/cadso/dovetail_core/changeScope");
        expect(e.message).toContain("Install the Dovetail application's Scripted REST APIs");
      }
    });

    it("does NOT add the missing-endpoint hint for unrelated 400s", async function () {
      var call = jest.fn(async function (_endpoint: string) {
        throw makeAxiosError(400, { error: { message: "Invalid scope name" } });
      });

      try {
        await _callDovetailApi("changeScope", call);
        throw new Error("expected rejection");
      } catch (e: any) {
        expect(e.message).toContain("HTTP 400");
        expect(e.message).toContain("Invalid scope name");
        expect(e.message).not.toContain("Install the Dovetail application's Scripted REST APIs");
      }
    });

    it("after fallback latches, errors from the legacy path are also enriched", async function () {
      var calls: string[] = [];
      var call = jest.fn(async function (endpoint: string) {
        calls.push(endpoint);
        if (endpoint.indexOf("api/cadso/dovetail_core/") === 0) {
          throw makeAxiosError(404, {});
        }
        throw makeAxiosError(500, { error: { message: "boom" } });
      });

      try {
        await _callDovetailApi("changeScope", call);
        throw new Error("expected rejection");
      } catch (e: any) {
        expect(calls).toEqual([
          "api/cadso/dovetail_core/changeScope",
          "api/cadso/dovetail/changeScope",
        ]);
        expect(e.response.status).toBe(500);
        expect(e.message).toContain("HTTP 500");
        expect(e.message).toContain("api/cadso/dovetail/changeScope");
        expect(e.message).toContain("boom");
      }
    });

    it("leaves non-axios errors untouched", async function () {
      var call = jest.fn(async function (_endpoint: string) {
        throw new Error("ECONNREFUSED");
      });

      await expect(_callDovetailApi("changeScope", call)).rejects.toThrow("ECONNREFUSED");
    });
  });
});
