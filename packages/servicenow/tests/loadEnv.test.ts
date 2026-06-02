// Tests for loadEnvFile — the per-command .env selector for dove-sn.
// Verifies an explicit path is loaded, DOVETAIL_ENV_FILE is honored as a
// fallback, and an already-set process.env var is never overridden.

import fs from "fs";
import os from "os";
import path from "path";
import { loadEnvFile } from "../src/loadEnv";

describe("loadEnvFile (dove-sn)", function () {
  var tmpDir: string;
  var savedKeys = ["DOVE_TEST_INSTANCE", "DOVETAIL_ENV_FILE"];
  var savedEnv: Record<string, string | undefined> = {};

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dove-sn-env-"));
    savedKeys.forEach(function (k) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(function () {
    savedKeys.forEach(function (k) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch (e) {
      // best-effort cleanup
    }
  });

  it("loads vars from an explicit --env path", function () {
    var envPath = path.join(tmpDir, "explicit.env");
    fs.writeFileSync(envPath, "DOVE_TEST_INSTANCE=fromExplicit\n", "utf8");
    loadEnvFile(envPath);
    expect(process.env.DOVE_TEST_INSTANCE).toBe("fromExplicit");
  });

  it("falls back to DOVETAIL_ENV_FILE when no explicit path is given", function () {
    var envPath = path.join(tmpDir, "viaEnvVar.env");
    fs.writeFileSync(envPath, "DOVE_TEST_INSTANCE=fromEnvVar\n", "utf8");
    process.env.DOVETAIL_ENV_FILE = envPath;
    loadEnvFile();
    expect(process.env.DOVE_TEST_INSTANCE).toBe("fromEnvVar");
  });

  it("does not override a variable already set in process.env", function () {
    var envPath = path.join(tmpDir, "explicit.env");
    fs.writeFileSync(envPath, "DOVE_TEST_INSTANCE=fromFile\n", "utf8");
    process.env.DOVE_TEST_INSTANCE = "fromProcess";
    loadEnvFile(envPath);
    expect(process.env.DOVE_TEST_INSTANCE).toBe("fromProcess");
  });
});
