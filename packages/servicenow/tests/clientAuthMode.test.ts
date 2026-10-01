/**
 * Auth-mode selection tests: assert the exact axios.create config createClient
 * builds — an inbound API key becomes the x-sn-apikey header and basic auth is
 * NOT sent; without a key, basic auth is sent and the header is absent.
 */

import axios from "axios";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

function captureCreateConfig(): Array<any> {
  var configs: Array<any> = [];
  (mockedAxios as any).create = jest.fn(function (cfg: any) {
    configs.push(cfg);
    return { request: jest.fn() };
  });
  return configs;
}

describe("createClient — auth mode selection", function () {
  var savedEnv: Record<string, string | undefined> = {};
  var keys = [
    "SN_INSTANCE", "SN_DEV_INSTANCE", "SN_PROD_INSTANCE",
    "SN_USER", "SN_PASSWORD",
    "SN_DEV_USERNAME", "SN_DEV_PASSWORD",
    "SN_PROD_USERNAME", "SN_PROD_PASSWORD",
    "SN_API_KEY", "SN_DEV_API_KEY", "SN_PROD_API_KEY"
  ];

  beforeEach(function () {
    keys.forEach(function (k) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
    process.env.SN_INSTANCE = "test.service-now.com";
  });

  afterEach(function () {
    keys.forEach(function (k) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    });
  });

  it("key mode: sends x-sn-apikey header and NO basic auth", function () {
    process.env.SN_API_KEY = "key-abc";
    var configs = captureCreateConfig();
    var clientModule = require("../src/client");
    clientModule.createClient({});
    expect(configs).toHaveLength(1);
    expect(configs[0].headers["x-sn-apikey"]).toBe("key-abc");
    expect(configs[0].auth).toBeUndefined();
  });

  it("basic mode: sends auth and NO x-sn-apikey header", function () {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    var configs = captureCreateConfig();
    var clientModule = require("../src/client");
    clientModule.createClient({});
    expect(configs).toHaveLength(1);
    expect(configs[0].auth).toEqual({ username: "u", password: "p" });
    expect(configs[0].headers["x-sn-apikey"]).toBeUndefined();
  });

  it("key wins when both key and basic creds are in the environment", function () {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    process.env.SN_API_KEY = "key-abc";
    var configs = captureCreateConfig();
    var clientModule = require("../src/client");
    clientModule.createClient({});
    expect(configs[0].headers["x-sn-apikey"]).toBe("key-abc");
    expect(configs[0].auth).toBeUndefined();
  });

  it("cfg.apiKey wins over everything", function () {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    var configs = captureCreateConfig();
    var clientModule = require("../src/client");
    clientModule.createClient({ apiKey: "cfg-key" });
    expect(configs[0].headers["x-sn-apikey"]).toBe("cfg-key");
    expect(configs[0].auth).toBeUndefined();
  });

  it("cfg user/password pins basic auth even when env has SN_API_KEY", function () {
    process.env.SN_API_KEY = "env-key";
    var configs = captureCreateConfig();
    var clientModule = require("../src/client");
    clientModule.createClient({ user: "cfg-u", password: "cfg-p" });
    expect(configs[0].auth).toEqual({ username: "cfg-u", password: "cfg-p" });
    expect(configs[0].headers["x-sn-apikey"]).toBeUndefined();
  });

  it("json content headers survive in both modes", function () {
    process.env.SN_API_KEY = "key-abc";
    var configs = captureCreateConfig();
    var clientModule = require("../src/client");
    clientModule.createClient({});
    expect(configs[0].headers.accept).toBe("application/json");
    expect(configs[0].headers["content-type"]).toBe("application/json");
  });
});
