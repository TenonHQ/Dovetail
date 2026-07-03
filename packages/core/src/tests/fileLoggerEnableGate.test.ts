/**
 * Regression: `dove` used to drop a `dovetail-debug-*.log` file into the cwd on
 * EVERY invocation, because the file logger lazily created its file on the first
 * write and `index.ts` logs "Starting Dovetail..." (plus scattered debug traces)
 * on every command. The file logger is now opt-in — it only touches disk when
 * the user asks for it via `--debug` or `DOVETAIL_DEBUG`.
 *
 * These tests cover:
 *  - the pure decision helper (`shouldEnableFileLogging`), and
 *  - the singleton's disk behavior: writes no file by default, writes once
 *    enabled, while console output is unaffected in both states.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { fileLogger, shouldEnableFileLogging } from "../FileLogger";

function countDebugLogs(dir: string): number {
  return fs.readdirSync(dir).filter((f) => /^dovetail-debug-.*\.log$/.test(f))
    .length;
}

// The file logger opens its stream asynchronously; poll until a predicate holds.
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("shouldEnableFileLogging (pure)", () => {
  it("is OFF by default — no flag, no env", () => {
    expect(shouldEnableFileLogging([], {})).toBe(false);
    expect(shouldEnableFileLogging(["push", "--diff", "main"], {})).toBe(false);
  });

  it("turns ON with the --debug flag", () => {
    expect(shouldEnableFileLogging(["push", "--debug"], {})).toBe(true);
    expect(shouldEnableFileLogging(["--debug", "status"], {})).toBe(true);
  });

  it("honors --debug=<value>", () => {
    expect(shouldEnableFileLogging(["--debug=true"], {})).toBe(true);
    expect(shouldEnableFileLogging(["--debug=1"], {})).toBe(true);
    expect(shouldEnableFileLogging(["--debug=false"], {})).toBe(false);
    expect(shouldEnableFileLogging(["--debug=0"], {})).toBe(false);
  });

  it("turns ON with a truthy DOVETAIL_DEBUG env var", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(shouldEnableFileLogging([], { DOVETAIL_DEBUG: v })).toBe(true);
    }
  });

  it("stays OFF for a falsy/empty DOVETAIL_DEBUG env var", () => {
    for (const v of ["", "0", "false", "no", "off"]) {
      expect(shouldEnableFileLogging([], { DOVETAIL_DEBUG: v })).toBe(false);
    }
  });

  it("tolerates non-array argv defensively", () => {
    expect(shouldEnableFileLogging(undefined as unknown as string[], {})).toBe(
      false,
    );
  });
});

describe("fileLogger disk gate", () => {
  let tmpDir: string;
  let cwdSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dovetail-log-gate-"));
    cwdSpy = jest.spyOn(process, "cwd").mockReturnValue(tmpDir);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    fileLogger.close();
    // Let any in-flight stream close settle before removing the directory.
    await new Promise((resolve) => setTimeout(resolve, 20));
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes NO log file when disabled (jest runs with no --debug / env)", () => {
    expect(fileLogger.isEnabled()).toBe(false);

    fileLogger.debug("should not create a file");
    fileLogger.info("informational");
    fileLogger.warn("warning");
    fileLogger.error("boom");

    expect(countDebugLogs(tmpDir)).toBe(0);
    expect(fileLogger.getLogFilePath()).toBe("");
  });

  it("still prints info to the console when disabled", () => {
    fileLogger.info("visible to the user");
    expect(logSpy).toHaveBeenCalled();
  });

  it("creates and writes a log file once enabled", async () => {
    fileLogger.enable();
    expect(fileLogger.isEnabled()).toBe(true);

    fileLogger.debug("now this lands on disk");

    // Path is assigned synchronously in initialize(); the stream opens async.
    const logPath = fileLogger.getLogFilePath();
    expect(logPath.startsWith(tmpDir)).toBe(true);
    expect(/dovetail-debug-.*\.log$/.test(path.basename(logPath))).toBe(true);

    await waitFor(
      () =>
        fs.existsSync(logPath) &&
        fs.readFileSync(logPath, "utf8").includes("now this lands on disk"),
    );

    expect(countDebugLogs(tmpDir)).toBe(1);
  });
});
