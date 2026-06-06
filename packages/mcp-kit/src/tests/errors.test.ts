import { mapToolError } from "../errors";

describe("mapToolError", function () {
  it("preserves the upstream message verbatim", function () {
    var e = mapToolError(new Error("ServiceNow table not found: foo"));
    expect(e.message).toBe("ServiceNow table not found: foo");
    expect(e.retryable).toBe(false);
  });

  it("stringifies non-Error throws", function () {
    expect(mapToolError("plain string").message).toBe("plain string");
    expect(mapToolError({ toString: function () { return "obj"; } }).message).toBe("obj");
  });

  it("classifies transient failures as retryable", function () {
    [
      "rate limit exceeded",
      "HTTP 429 Too Many Requests",
      "network unreachable",
      "connect ETIMEDOUT 1.2.3.4:443",
      "read ECONNRESET",
      "retries exhausted after 5 attempts"
    ].forEach(function (msg) {
      expect(mapToolError(new Error(msg)).retryable).toBe(true);
    });
  });

  it("is case-insensitive on the retryable signal", function () {
    expect(mapToolError(new Error("Rate Limit hit")).retryable).toBe(true);
  });

  it("classifies non-transient failures as not retryable", function () {
    ["404 not found", "validation failed", "permission denied"].forEach(function (msg) {
      expect(mapToolError(new Error(msg)).retryable).toBe(false);
    });
  });
});
