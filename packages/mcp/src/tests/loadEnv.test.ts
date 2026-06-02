// Tests for loadEnvFile — the per-server .env selector for dovetail-mcp.
// Verifies the --env argv flag (space and = forms), the DOVETAIL_ENV_FILE
// fallback, and that a host-injected process.env var always wins.

import fs from "fs";
import os from "os";
import path from "path";
import { loadEnvFile } from "../loadEnv";

describe("loadEnvFile (dovetail-mcp)", function () {
  var tmpDir: string;
  var savedKeys = ["DOVE_MCP_TEST_TOKEN", "DOVETAIL_ENV_FILE"];
  var savedEnv: Record<string, string | undefined> = {};

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dove-mcp-env-"));
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

  it("loads vars from a --env <path> argv flag", function () {
    var envPath = path.join(tmpDir, "a.env");
    fs.writeFileSync(envPath, "DOVE_MCP_TEST_TOKEN=spaceForm\n", "utf8");
    loadEnvFile(["--env", envPath]);
    expect(process.env.DOVE_MCP_TEST_TOKEN).toBe("spaceForm");
  });

  it("loads vars from a --env=<path> argv flag", function () {
    var envPath = path.join(tmpDir, "b.env");
    fs.writeFileSync(envPath, "DOVE_MCP_TEST_TOKEN=eqForm\n", "utf8");
    loadEnvFile(["--env=" + envPath]);
    expect(process.env.DOVE_MCP_TEST_TOKEN).toBe("eqForm");
  });

  it("falls back to DOVETAIL_ENV_FILE when argv has no flag", function () {
    var envPath = path.join(tmpDir, "c.env");
    fs.writeFileSync(envPath, "DOVE_MCP_TEST_TOKEN=fromEnvVar\n", "utf8");
    process.env.DOVETAIL_ENV_FILE = envPath;
    loadEnvFile([]);
    expect(process.env.DOVE_MCP_TEST_TOKEN).toBe("fromEnvVar");
  });

  it("does not override a host-injected process.env var", function () {
    var envPath = path.join(tmpDir, "d.env");
    fs.writeFileSync(envPath, "DOVE_MCP_TEST_TOKEN=fromFile\n", "utf8");
    process.env.DOVE_MCP_TEST_TOKEN = "fromHost";
    loadEnvFile(["--env", envPath]);
    expect(process.env.DOVE_MCP_TEST_TOKEN).toBe("fromHost");
  });
});
