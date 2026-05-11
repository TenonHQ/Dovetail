// Tests for the dove.config.js / sinc.config.js loader fallback in config.ts.
// Covers: dove.config.js wins when both are present (no warning); sinc.config.js
// is accepted when alone (with a deprecation warning); neither present walks
// up the tree (returns false at the filesystem root).

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  getLogLevel: function () { return "debug"; },
  setLogLevel: jest.fn(),
};

jest.mock("../Logger", function () {
  return { logger: mockLogger };
});

jest.mock("../defaultOptions", function () {
  return { includes: {}, excludes: {}, tableOptions: {}, scopes: {} };
});

import fs from "fs";
import os from "os";
import path from "path";
import { loadConfigPath } from "../config";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dove-config-test-"));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("loadConfigPath fallback", function () {
  var tmp = "";

  beforeEach(function () {
    jest.clearAllMocks();
    tmp = makeTempDir();
  });

  afterEach(function () {
    rmrf(tmp);
  });

  it("prefers dove.config.js when both files exist (no warning)", async function () {
    fs.writeFileSync(path.join(tmp, "dove.config.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(tmp, "sinc.config.js"), "module.exports = {};\n");

    var result = await loadConfigPath(tmp);

    expect(result).toBe(path.join(tmp, "dove.config.js"));
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("falls back to sinc.config.js with a deprecation warning when only legacy exists", async function () {
    fs.writeFileSync(path.join(tmp, "sinc.config.js"), "module.exports = {};\n");

    var result = await loadConfigPath(tmp);

    expect(result).toBe(path.join(tmp, "sinc.config.js"));
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toContain("legacy 'sinc.config.js'");
    expect(mockLogger.warn.mock.calls[0][0]).toContain("dove migrate");
  });

  it("returns false when neither file exists anywhere up the tree (from a temp dir)", async function () {
    // Nested empty subdir to exercise the recursive walk-up at least one step.
    var nested = path.join(tmp, "subdir");
    fs.mkdirSync(nested);

    var result = await loadConfigPath(nested);

    // The walk eventually reaches filesystem root and returns false. We don't
    // assert on intermediate behavior — just the terminal result.
    expect(result).toBe(false);
  });
});
