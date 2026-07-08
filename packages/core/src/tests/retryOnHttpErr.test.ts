var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  getLogLevel: function () {
    return "debug";
  },
};

jest.mock("../Logger", function () {
  return { logger: mockLogger };
});

jest.mock("../FileLogger", function () {
  return {
    fileLogger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
});

// Minimal mock for genericUtils — just need wait()
jest.mock("../genericUtils", function () {
  return {
    wait: jest.fn().mockResolvedValue(undefined),
  };
});

import { retryOnHttpErr } from "../snClient";
import { wait } from "../genericUtils";

function makeAxiosError(status: number, headers?: Record<string, string>): any {
  var error: any = new Error("Request failed with status " + status);
  error.isAxiosError = true;
  error.response = {
    status: status,
    headers: headers || {},
    data: {},
  };
  return error;
}

describe("retryOnHttpErr", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("returns successfully on first try when no error", async function () {
    var fn = jest.fn().mockResolvedValue({ status: 200, data: {} });
    var result = await retryOnHttpErr(fn, "test > rec1");
    expect(result).toEqual({ status: 200, data: {} });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // 401/403: Fail immediately
  it("fails immediately on 401 with credential message", async function () {
    var fn = jest.fn().mockRejectedValue(makeAxiosError(401));
    await expect(retryOnHttpErr(fn, "test > rec1")).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Unauthorized (401)"),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("credentials"),
    );
  });

  it("fails immediately on 403 with credential message", async function () {
    var fn = jest.fn().mockRejectedValue(makeAxiosError(403));
    await expect(retryOnHttpErr(fn, "test > rec1")).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Forbidden (403)"),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("credentials"),
    );
  });

  // 404: Fail immediately
  it("fails immediately on 404 with record not found message", async function () {
    var fn = jest.fn().mockRejectedValue(makeAxiosError(404));
    await expect(retryOnHttpErr(fn, "test > rec1")).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Record not found (404)"),
    );
  });

  // 429: Rate limited — honor Retry-After
  it("retries on 429 and honors Retry-After header", async function () {
    var fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(429, { "retry-after": "5" }))
      .mockResolvedValue({ status: 200, data: {} });

    var result = await retryOnHttpErr(fn, "test > rec1");
    expect(result).toEqual({ status: 200, data: {} });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(5000); // 5 seconds from Retry-After
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Rate limited (429)"),
    );
  });

  it("uses default 10s wait on 429 without Retry-After header", async function () {
    var fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(429))
      .mockResolvedValue({ status: 200, data: {} });

    await retryOnHttpErr(fn, "test > rec1");
    expect(wait).toHaveBeenCalledWith(10000);
  });

  // 500/502/503: Exponential backoff
  it("retries 500 with exponential backoff (1s, 2s, 4s)", async function () {
    var fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockResolvedValue({ status: 200, data: {} });

    var result = await retryOnHttpErr(fn, "test > rec1");
    expect(result).toEqual({ status: 200, data: {} });
    expect(fn).toHaveBeenCalledTimes(4); // 3 failures + 1 success
    expect(wait).toHaveBeenNthCalledWith(1, 1000); // 1s
    expect(wait).toHaveBeenNthCalledWith(2, 2000); // 2s
    expect(wait).toHaveBeenNthCalledWith(3, 4000); // 4s
  });

  it("gives up after 3 retries on 500", async function () {
    var fn = jest.fn().mockRejectedValue(makeAxiosError(500));
    await expect(retryOnHttpErr(fn, "test > rec1")).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("after 3 retries"),
    );
  });

  it("retries 502 with exponential backoff", async function () {
    var fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(502))
      .mockResolvedValue({ status: 200, data: {} });

    await retryOnHttpErr(fn, "test > rec1");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1000);
  });

  it("retries 503 with exponential backoff", async function () {
    var fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValue({ status: 200, data: {} });

    await retryOnHttpErr(fn, "test > rec1");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1000);
  });

  it("caps backoff at 8s for server errors", async function () {
    // After 3 retries with backoff doubling: 1s, 2s, 4s
    // If we could do a 4th it would be 8s (capped), but we stop at 3
    var fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockRejectedValueOnce(makeAxiosError(500))
      .mockResolvedValue({ status: 200, data: {} });

    await retryOnHttpErr(fn, "test > rec1");
    // Verify the 3rd wait is 4s (next would be 8s = cap)
    expect(wait).toHaveBeenNthCalledWith(3, 4000);
  });

  // Unknown errors: retry once
  it("retries unknown status code once then fails", async function () {
    var fn = jest.fn().mockRejectedValue(makeAxiosError(418));
    await expect(retryOnHttpErr(fn, "test > rec1")).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 418"),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("after 1 retry"),
    );
  });

  it("retries non-HTTP error once then fails", async function () {
    var fn = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(retryOnHttpErr(fn, "test > rec1")).rejects.toThrow(
      "ECONNRESET",
    );
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown error"),
    );
  });

  it("succeeds on retry for unknown error", async function () {
    var fn = jest
      .fn()
      .mockRejectedValueOnce(makeAxiosError(418))
      .mockResolvedValue({ status: 200, data: {} });

    var result = await retryOnHttpErr(fn, "test > rec1");
    expect(result).toEqual({ status: 200, data: {} });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
