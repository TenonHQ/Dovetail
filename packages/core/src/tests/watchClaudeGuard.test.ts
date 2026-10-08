// Handler-level tests for the Claude Code guard on the human-only watcher
// (watchAllScopesCommand, TenonHQ/Dovetail#155):
//   - CLAUDECODE set          -> exit 1 before the watcher starts;
//   - CLAUDECODE + override   -> warns, starts;
//   - only a CLAUDE_CODE_* config variable (a human shell) -> warns, starts.
// The watcher module is mocked, so nothing is watched or pushed.

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  getLogLevel: function () { return "info"; },
};

jest.mock("../Logger", function () { return { logger: mockLogger }; });
jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
});
jest.mock("../config", function () { return {}; });
jest.mock("../snClient", function () {
  return {
    defaultClient: function () { return {}; },
    unwrapSNResponse: function (p: Promise<unknown>) { return Promise.resolve(p); },
  };
});
jest.mock("../wizard", function () {
  return { setupDotEnv: jest.fn(), getLoginInfo: jest.fn() };
});
jest.mock("../commands", function () { return { setLogLevel: jest.fn() }; });

var mockStartWatching = jest.fn().mockResolvedValue(undefined);
jest.mock("../MultiScopeWatcher", function () {
  return { startMultiScopeWatching: mockStartWatching, stopMultiScopeWatching: jest.fn() };
});

import { watchAllScopesCommand } from "../allScopesCommands";
import {
  WATCH_ALLOW_IN_CLAUDE_ENV,
  WATCH_BLOCKED_IN_CLAUDE_ERROR,
  WATCH_HUMAN_ONLY_WARNING,
} from "../claudeSession";

class ExitSignal extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super("process.exit(" + code + ")");
    this.code = code;
  }
}

var ARGS = { logLevel: "info", noDashboard: true, noMonitoring: true };

// Every env key this suite touches. The suite may itself run inside a Claude
// Code shell, so the Claude markers are cleared before each test.
function isManagedKey(key: string): boolean {
  return (
    key === "CLAUDECODE" ||
    key.indexOf("CLAUDE_CODE_") === 0 ||
    key === WATCH_ALLOW_IN_CLAUDE_ENV ||
    key === "SN_USER" ||
    key === "SN_INSTANCE" ||
    key === "SN_PASSWORD"
  );
}

describe("watchAllScopesCommand Claude Code guard", function () {
  var savedEnv: Record<string, string | undefined> = {};
  var exitSpy: jest.SpyInstance;
  var sigintBefore: Function[] = [];

  beforeEach(function () {
    jest.clearAllMocks();
    savedEnv = {};
    Object.keys(process.env).forEach(function (key) {
      if (isManagedKey(key)) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });
    process.env.SN_USER = "test-user";
    process.env.SN_INSTANCE = "example.service-now.com";
    process.env.SN_PASSWORD = "not-a-real-value";
    sigintBefore = process.listeners("SIGINT").slice();
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(function (code?: string | number | null) {
        throw new ExitSignal(typeof code === "number" ? code : undefined);
      });
  });

  afterEach(function () {
    exitSpy.mockRestore();
    process.listeners("SIGINT").forEach(function (listener) {
      if (sigintBefore.indexOf(listener) === -1) {
        process.removeListener("SIGINT", listener as NodeJS.SignalsListener);
      }
    });
    Object.keys(process.env).forEach(function (key) {
      if (isManagedKey(key)) {
        delete process.env[key];
      }
    });
    Object.keys(savedEnv).forEach(function (key) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      }
    });
  });

  it("exits 1 before starting the watcher when CLAUDECODE is set", async function () {
    process.env.CLAUDECODE = "1";

    await expect(watchAllScopesCommand(ARGS)).rejects.toBeInstanceOf(ExitSignal);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockStartWatching).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(WATCH_BLOCKED_IN_CLAUDE_ERROR);
    expect(WATCH_BLOCKED_IN_CLAUDE_ERROR).toContain(WATCH_ALLOW_IN_CLAUDE_ENV + "=1");
  });

  it("starts (with the warning) when CLAUDECODE is set and the human override is 1", async function () {
    process.env.CLAUDECODE = "1";
    process.env[WATCH_ALLOW_IN_CLAUDE_ENV] = "1";

    await watchAllScopesCommand(ARGS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockStartWatching).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(WATCH_HUMAN_ONLY_WARNING);
  });

  it("does not treat an override other than 1 as consent", async function () {
    process.env.CLAUDECODE = "1";
    process.env[WATCH_ALLOW_IN_CLAUDE_ENV] = "true";

    await expect(watchAllScopesCommand(ARGS)).rejects.toBeInstanceOf(ExitSignal);

    expect(mockStartWatching).not.toHaveBeenCalled();
  });

  it("only warns (and starts) for a human shell with a CLAUDE_CODE_* config variable", async function () {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";

    await watchAllScopesCommand(ARGS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockStartWatching).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(WATCH_HUMAN_ONLY_WARNING);
  });

  it("starts silently with no Claude markers at all", async function () {
    await watchAllScopesCommand(ARGS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockStartWatching).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(WATCH_HUMAN_ONLY_WARNING);
  });
});
