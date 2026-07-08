/**
 * Tests for the enhanced error path in unwrapSNResponse.
 *
 * When a ServiceNow REST call throws, the catch block must:
 *  - Log a structured one-liner via logger.error including HTTP status, method, URL
 *    and (when present) the ServiceNow-shaped error message from the response body.
 *  - Dump the full error surface (status, statusText, responseData, responseHeaders,
 *    scope extracted from /getManifest/:scope URLs) via fileLogger.debug.
 *  - Re-throw the original error so upstream callers see identical behaviour.
 *
 * Non-Axios errors must preserve the original log shape ("Error from <instance>: <msg>")
 * and also produce a debug dump for future triage.
 */

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  getLogLevel: function () {
    return "debug";
  },
};

var mockFileLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock("../Logger", function () {
  return { logger: mockLogger };
});

jest.mock("../FileLogger", function () {
  return { fileLogger: mockFileLogger };
});

import { unwrapSNResponse } from "../snClient";

function makeAxiosError(overrides: {
  status: number;
  method?: string;
  url?: string;
  data?: any;
  statusText?: string;
  headers?: Record<string, string>;
}): any {
  var error: any = new Error(
    "Request failed with status code " + overrides.status,
  );
  error.isAxiosError = true;
  error.config = {
    method: overrides.method || "post",
    url: overrides.url || "api/cadso/dovetail_sync/getManifest/x_cadso_example",
  };
  error.response = {
    status: overrides.status,
    statusText: overrides.statusText || "",
    headers: overrides.headers || { "x-test": "1" },
    data: overrides.data,
  };
  return error;
}

describe("unwrapSNResponse — error handling", function () {
  var origInstance: string | undefined;

  beforeAll(function () {
    origInstance = process.env.SN_INSTANCE;
    process.env.SN_INSTANCE = "tenontest.service-now.com";
  });

  afterAll(function () {
    if (origInstance === undefined) delete process.env.SN_INSTANCE;
    else process.env.SN_INSTANCE = origInstance;
  });

  beforeEach(function () {
    jest.clearAllMocks();
  });

  test("Axios 500 with ServiceNow-shaped body: one-liner includes status + URL + SN message, debug dump carries full detail", async function () {
    var snBody = {
      error: {
        message: "org.mozilla.javascript.EcmaError: TypeError",
        detail: "Cannot read property 'name' of null",
      },
      status: "failure",
    };
    var axErr = makeAxiosError({
      status: 500,
      method: "post",
      url: "api/cadso/dovetail_sync/getManifest/x_cadso_automate",
      data: snBody,
      statusText: "Internal Server Error",
    });

    var rejected = Promise.reject(axErr);
    // Silence the unhandled-rejection warning before jest inspects it
    rejected.catch(function () {});

    await expect(unwrapSNResponse(rejected as any)).rejects.toBe(axErr);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    var userLine = mockLogger.error.mock.calls[0][0];
    expect(userLine).toContain("tenontest.service-now.com");
    expect(userLine).toContain("HTTP 500");
    expect(userLine).toContain("POST");
    expect(userLine).toContain("getManifest/x_cadso_automate");
    expect(userLine).toContain("org.mozilla.javascript.EcmaError");

    expect(mockFileLogger.debug).toHaveBeenCalledTimes(1);
    var debugLabel = mockFileLogger.debug.mock.calls[0][0];
    var debugPayload = mockFileLogger.debug.mock.calls[0][1];
    expect(debugLabel).toBe("REST error detail");
    expect(debugPayload).toMatchObject({
      instance: "tenontest.service-now.com",
      scope: "x_cadso_automate",
      method: "POST",
      status: 500,
      statusText: "Internal Server Error",
      responseData: snBody,
      responseHeaders: { "x-test": "1" },
    });
    expect(debugPayload.url).toContain("getManifest/x_cadso_automate");
  });

  test("Axios 500 with non-SN body: one-liner falls back cleanly, no crash", async function () {
    var axErr = makeAxiosError({
      status: 500,
      method: "get",
      url: "api/now/table/sys_script_include",
      data: "<html><body>Gateway error</body></html>",
    });
    var rejected = Promise.reject(axErr);
    rejected.catch(function () {});

    await expect(unwrapSNResponse(rejected as any)).rejects.toBe(axErr);

    var userLine = mockLogger.error.mock.calls[0][0];
    expect(userLine).toContain("HTTP 500");
    expect(userLine).toContain("GET");
    expect(userLine).toContain("table/sys_script_include");
    // No SN message to append; no em dash
    expect(userLine).not.toContain(" — ");

    expect(mockFileLogger.debug).toHaveBeenCalledTimes(1);
    var debugPayload = mockFileLogger.debug.mock.calls[0][1];
    // Non-manifest URL — scope should be undefined
    expect(debugPayload.scope).toBeUndefined();
    expect(debugPayload.responseData).toBe(
      "<html><body>Gateway error</body></html>",
    );
  });

  test("Non-Axios error: preserves legacy log shape and re-throws", async function () {
    var nonAxios = new Error("socket hang up");
    var rejected = Promise.reject(nonAxios);
    rejected.catch(function () {});

    await expect(unwrapSNResponse(rejected as any)).rejects.toBe(nonAxios);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    var userLine = mockLogger.error.mock.calls[0][0];
    expect(userLine).toBe(
      "Error from tenontest.service-now.com: socket hang up",
    );

    expect(mockFileLogger.debug).toHaveBeenCalledTimes(1);
    var debugLabel = mockFileLogger.debug.mock.calls[0][0];
    expect(debugLabel).toBe("Non-Axios error detail");
    var debugPayload = mockFileLogger.debug.mock.calls[0][1];
    expect(debugPayload.message).toBe("socket hang up");
    expect(debugPayload.errorName).toBe("Error");
    expect(typeof debugPayload.errorStack).toBe("string");
  });
});
