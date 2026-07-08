// Tests for resolveConfigFromEnvFile / createClientFromEnvFile — the pure
// per-call instance resolver used by the MCP server to retarget a read without
// mutating process.env.

import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveConfigFromEnvFile,
  createClientFromEnvFile,
} from "../src/createClientFromEnvFile";

describe("resolveConfigFromEnvFile", function () {
  var tmpDir: string;
  var leakedKeys = [
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
  var savedEnv: Record<string, string | undefined> = {};

  function writeEnv(name: string, body: string): string {
    var p = path.join(tmpDir, name);
    fs.writeFileSync(p, body, "utf8");
    return p;
  }

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-envfile-"));
    leakedKeys.forEach(function (k) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(function () {
    leakedKeys.forEach(function (k) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k] as string;
    });
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch (e) {
      // best-effort cleanup
    }
  });

  it("resolves instance/user/password from SN_* keys", function () {
    var p = writeEnv(
      ".env.prod",
      "SN_INSTANCE=prod.service-now.com\nSN_USER=admin\nSN_PASSWORD=secret\n",
    );
    expect(resolveConfigFromEnvFile(p)).toEqual({
      instance: "prod.service-now.com",
      user: "admin",
      password: "secret",
    });
  });

  it("falls back to SN_DEV_* / SN_PROD_* names", function () {
    var p = writeEnv(
      ".env.workshop",
      "SN_DEV_INSTANCE=TenonWorkShop\nSN_DEV_USERNAME=dev\nSN_DEV_PASSWORD=devpass\n",
    );
    expect(resolveConfigFromEnvFile(p)).toEqual({
      instance: "TenonWorkShop",
      user: "dev",
      password: "devpass",
    });
  });

  it("prefers SN_INSTANCE over SN_DEV_INSTANCE when both present", function () {
    var p = writeEnv(
      ".env.mixed",
      "SN_INSTANCE=preferred\nSN_DEV_INSTANCE=ignored\nSN_USER=u\nSN_PASSWORD=p\n",
    );
    expect(resolveConfigFromEnvFile(p).instance).toBe("preferred");
  });

  it("does NOT read from process.env — the file alone determines the target", function () {
    process.env.SN_INSTANCE = "leaked.service-now.com";
    process.env.SN_USER = "leakeduser";
    process.env.SN_PASSWORD = "leakedpass";
    var p = writeEnv(
      ".env.fromfile",
      "SN_INSTANCE=fromfile\nSN_USER=fileuser\nSN_PASSWORD=filepass\n",
    );
    var cfg = resolveConfigFromEnvFile(p);
    expect(cfg).toEqual({
      instance: "fromfile",
      user: "fileuser",
      password: "filepass",
    });
    // and process.env is untouched
    expect(process.env.SN_INSTANCE).toBe("leaked.service-now.com");
  });

  it("throws an actionable error when the instance is missing", function () {
    var p = writeEnv(".env.noinst", "SN_USER=u\nSN_PASSWORD=p\n");
    expect(function () {
      resolveConfigFromEnvFile(p);
    }).toThrow(/does not define a ServiceNow instance/);
  });

  it("throws an actionable error when credentials are incomplete", function () {
    var p = writeEnv(".env.nopass", "SN_INSTANCE=x\nSN_USER=u\n");
    expect(function () {
      resolveConfigFromEnvFile(p);
    }).toThrow(/missing ServiceNow credentials/);
  });

  it("throws when the file cannot be read", function () {
    var p = path.join(tmpDir, ".env.missing");
    expect(function () {
      resolveConfigFromEnvFile(p);
    }).toThrow(/Cannot read env file/);
  });

  it("createClientFromEnvFile returns a client with a table.query surface", function () {
    var p = writeEnv(
      ".env.client",
      "SN_INSTANCE=c.service-now.com\nSN_USER=u\nSN_PASSWORD=p\n",
    );
    var client = createClientFromEnvFile(p);
    expect(typeof client.table.query).toBe("function");
  });
});
