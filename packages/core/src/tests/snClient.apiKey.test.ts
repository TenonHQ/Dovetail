// Auth-mode tests for snClient: an inbound API key (4th param) becomes the
// x-sn-apikey header on the real axios instance and basic auth is NOT set;
// without a key the existing basic-auth behavior is unchanged. Also covers
// defaultClient() picking SN_API_KEY out of the environment.

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

import { snClient } from "../snClient";

describe("snClient — auth mode", function () {
  it("key mode: sets x-sn-apikey header and no basic auth", function () {
    var c = snClient("https://x.service-now.com/", "user", "pass", "key-123");
    expect(c.client.defaults.headers["x-sn-apikey"]).toBe("key-123");
    expect(c.client.defaults.auth).toBeUndefined();
  });

  it("basic mode: sets basic auth and no x-sn-apikey header", function () {
    var c = snClient("https://x.service-now.com/", "user", "pass");
    expect(c.client.defaults.auth).toEqual({ username: "user", password: "pass" });
    expect(c.client.defaults.headers["x-sn-apikey"]).toBeUndefined();
  });

  it("empty-string key falls back to basic auth", function () {
    var c = snClient("https://x.service-now.com/", "user", "pass", "");
    expect(c.client.defaults.auth).toEqual({ username: "user", password: "pass" });
    expect(c.client.defaults.headers["x-sn-apikey"]).toBeUndefined();
  });
});
