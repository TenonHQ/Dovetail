import { createClient } from "../src/client";

describe("createClient — env precedence", function () {
  var savedEnv: Record<string, string | undefined> = {};
  var keys = [
    "SN_INSTANCE",
    "SN_DEV_INSTANCE",
    "SN_PROD_INSTANCE",
    "SN_USER",
    "SN_PASSWORD",
    "SN_DEV_USERNAME",
    "SN_DEV_PASSWORD",
    "SN_PROD_USERNAME",
    "SN_PROD_PASSWORD",
  ];

  beforeEach(function () {
    keys.forEach(function (k) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(function () {
    keys.forEach(function (k) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    });
  });

  it("uses explicit cfg over all env vars", function () {
    process.env.SN_INSTANCE = "fromenv.service-now.com";
    process.env.SN_USER = "envuser";
    process.env.SN_PASSWORD = "envpass";
    expect(function () {
      createClient({
        instance: "explicit.service-now.com",
        user: "u",
        password: "p",
      });
    }).not.toThrow();
  });

  it("falls back to SN_DEV_INSTANCE and appends .service-now.com to bare names", function () {
    process.env.SN_DEV_INSTANCE = "TenonWorkStudio";
    process.env.SN_DEV_USERNAME = "u";
    process.env.SN_DEV_PASSWORD = "p";
    expect(function () {
      createClient({});
    }).not.toThrow();
  });

  it("prefers SN_INSTANCE over SN_DEV_INSTANCE when both set", function () {
    process.env.SN_INSTANCE = "preferred.service-now.com";
    process.env.SN_DEV_INSTANCE = "ignored";
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    expect(function () {
      createClient({});
    }).not.toThrow();
  });

  it("falls back to SN_PROD_* when SN_* and SN_DEV_* are missing", function () {
    process.env.SN_PROD_INSTANCE = "prod.service-now.com";
    process.env.SN_PROD_USERNAME = "u";
    process.env.SN_PROD_PASSWORD = "p";
    expect(function () {
      createClient({});
    }).not.toThrow();
  });

  it("throws when no instance source is configured", function () {
    process.env.SN_USER = "u";
    process.env.SN_PASSWORD = "p";
    expect(function () {
      createClient({});
    }).toThrow(/instance not configured/);
  });

  it("throws when no credential source is configured", function () {
    process.env.SN_INSTANCE = "x.service-now.com";
    expect(function () {
      createClient({});
    }).toThrow(/credentials missing/);
  });
});
