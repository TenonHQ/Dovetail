// Tests for loadEnvFile / resolveEnvSelection — the per-command env selector
// for dove-sn. Covers: explicit path and DOVETAIL_ENV_FILE loading, bare-name
// resolution (`loft` → .env.loft, matching the MCP tool), fail-closed on a
// missing or incomplete file, and that an explicitly selected file fully
// determines the ServiceNow connection (instance + auth) even when process.env
// already carries different SN_* values.

import fs from "fs";
import os from "os";
import path from "path";
import { loadEnvFile, resolveEnvSelection, SN_CONNECTION_KEYS } from "../src/loadEnv";

var BASIC_FILE = "SN_INSTANCE=fileinstance\nSN_USER=fileuser\nSN_PASSWORD=filepass\n";

describe("loadEnvFile (dove-sn)", function () {
  var tmpDir: string;
  var savedCwd: string;
  var savedKeys = ["DOVE_TEST_INSTANCE", "DOVETAIL_ENV_FILE"].concat(SN_CONNECTION_KEYS);
  var savedEnv: Record<string, string | undefined> = {};

  beforeEach(function () {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dove-sn-env-")));
    savedCwd = process.cwd();
    savedKeys.forEach(function (k) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(function () {
    process.chdir(savedCwd);
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
    fs.writeFileSync(envPath, BASIC_FILE + "DOVE_TEST_INSTANCE=fromExplicit\n", "utf8");
    expect(loadEnvFile(envPath)).toBe(envPath);
    expect(process.env.DOVE_TEST_INSTANCE).toBe("fromExplicit");
    expect(process.env.SN_INSTANCE).toBe("fileinstance");
  });

  it("falls back to DOVETAIL_ENV_FILE when no explicit path is given", function () {
    var envPath = path.join(tmpDir, "viaEnvVar.env");
    fs.writeFileSync(envPath, BASIC_FILE + "DOVE_TEST_INSTANCE=fromEnvVar\n", "utf8");
    process.env.DOVETAIL_ENV_FILE = envPath;
    loadEnvFile();
    expect(process.env.DOVE_TEST_INSTANCE).toBe("fromEnvVar");
  });

  it("does not override a non-ServiceNow variable already set in process.env", function () {
    var envPath = path.join(tmpDir, "explicit.env");
    fs.writeFileSync(envPath, BASIC_FILE + "DOVE_TEST_INSTANCE=fromFile\n", "utf8");
    process.env.DOVE_TEST_INSTANCE = "fromProcess";
    loadEnvFile(envPath);
    expect(process.env.DOVE_TEST_INSTANCE).toBe("fromProcess");
  });

  it("resolves a bare name to .env.<name> in cwd (same as the MCP tool)", function () {
    fs.writeFileSync(path.join(tmpDir, ".env.loft"), BASIC_FILE, "utf8");
    process.chdir(tmpDir);
    expect(loadEnvFile("loft")).toBe(path.join(tmpDir, ".env.loft"));
    expect(process.env.SN_INSTANCE).toBe("fileinstance");
  });

  it("throws instead of silently falling back when the selected file is missing", function () {
    process.chdir(tmpDir);
    process.env.SN_INSTANCE = "processinstance";
    expect(function () {
      loadEnvFile("loft");
    }).toThrow(/env file not found/);
    // Nothing was loaded or changed.
    expect(process.env.SN_INSTANCE).toBe("processinstance");
  });

  it("throws when the selected file defines no instance", function () {
    var envPath = path.join(tmpDir, "noinstance.env");
    fs.writeFileSync(envPath, "SN_USER=u\nSN_PASSWORD=p\n", "utf8");
    expect(function () {
      loadEnvFile(envPath);
    }).toThrow(/does not define a ServiceNow instance/);
  });

  it("the file's SN_INSTANCE and credentials replace ones already in process.env", function () {
    var envPath = path.join(tmpDir, "loft.env");
    fs.writeFileSync(envPath, BASIC_FILE, "utf8");
    process.env.SN_INSTANCE = "processinstance";
    process.env.SN_USER = "processuser";
    process.env.SN_PASSWORD = "processpass";
    loadEnvFile(envPath);
    expect(process.env.SN_INSTANCE).toBe("fileinstance");
    expect(process.env.SN_USER).toBe("fileuser");
    expect(process.env.SN_PASSWORD).toBe("filepass");
  });

  it("clears a process SN_API_KEY when the selected file pins basic auth", function () {
    var envPath = path.join(tmpDir, "basic.env");
    fs.writeFileSync(envPath, BASIC_FILE, "utf8");
    process.env.SN_API_KEY = "process-key";
    process.env.SN_DEV_INSTANCE = "processdev";
    loadEnvFile(envPath);
    expect(process.env.SN_API_KEY).toBeUndefined();
    expect(process.env.SN_DEV_INSTANCE).toBeUndefined();
  });
});

describe("resolveEnvSelection", function () {
  var tmpDir: string;

  beforeEach(function () {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dove-sn-sel-")));
  });

  afterEach(function () {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch (e) {
      // best-effort cleanup
    }
  });

  it("maps a bare name to .env.<name>", function () {
    expect(resolveEnvSelection("loft", tmpDir)).toBe(path.join(tmpDir, ".env.loft"));
  });

  it("keeps a .env-prefixed basename as-is", function () {
    expect(resolveEnvSelection(".env.prod", tmpDir)).toBe(path.join(tmpDir, ".env.prod"));
  });

  it("prefers an existing file with the literal bare name (legacy behavior)", function () {
    fs.writeFileSync(path.join(tmpDir, "loft"), BASIC_FILE, "utf8");
    expect(resolveEnvSelection("loft", tmpDir)).toBe(path.join(tmpDir, "loft"));
  });

  it("treats values with a separator as paths", function () {
    expect(resolveEnvSelection("envs/work.env", tmpDir)).toBe(path.join(tmpDir, "envs", "work.env"));
    expect(resolveEnvSelection("/abs/x.env", tmpDir)).toBe("/abs/x.env");
  });

  it("rejects an empty selection", function () {
    expect(function () {
      resolveEnvSelection("  ", tmpDir);
    }).toThrow(/non-empty/);
  });
});
