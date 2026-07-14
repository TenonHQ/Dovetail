/**
 * Tests for `dove refresh --table` — narrow the file refresh to specific tables.
 *
 * Validates:
 * - normalizeTableFilter accepts repeated flags AND comma-separated values, trimming + de-duping
 * - unknownTablesForScopes resolves against the target scope, or the union of all scopes
 * - refreshCommand HARD-FAILS on a table that no scope syncs (a typo must not look like a no-op)
 * - refreshCommand forwards the table list to syncManifest, and forwards undefined when unfiltered
 */

import {
  normalizeTableFilter,
  unknownTablesForScopes,
  refreshCommand,
} from "../commands";
import * as AppUtils from "../appUtils";
import * as ConfigManager from "../config";

// --- Mock setup (mirrors taskClear.test.ts) ---

var logMessages: { level: string; msg: string }[] = [];
jest.mock("../Logger", function () {
  return {
    logger: {
      setLogLevel: jest.fn(),
      success: jest.fn(function (msg: string) {
        logMessages.push({ level: "success", msg: msg });
      }),
      info: jest.fn(function (msg: string) {
        logMessages.push({ level: "info", msg: msg });
      }),
      error: jest.fn(function (msg: string) {
        logMessages.push({ level: "error", msg: msg });
      }),
      warn: jest.fn(function (msg: string) {
        logMessages.push({ level: "warn", msg: msg });
      }),
      debug: jest.fn(),
      getInternalLogger: jest.fn(function () {
        return { error: jest.fn() };
      }),
    },
  };
});

jest.mock("../config", function () {
  return {
    getConfig: jest.fn(),
    resolveConfigForScope: jest.fn(),
    loadConfigs: jest.fn(),
  };
});
jest.mock("../appUtils", function () {
  return { syncManifest: jest.fn() };
});
jest.mock("../snClient", function () {
  return { defaultClient: jest.fn(), unwrapSNResponse: jest.fn() };
});
jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn() } };
});
jest.mock("../logMessages", function () {
  return { logPushResults: jest.fn(), logBuildResults: jest.fn() };
});
jest.mock("../gitUtils", function () {
  return { gitDiffToEncodedPaths: jest.fn() };
});
jest.mock("../FileUtils", function () {
  return { encodedPathsToFilePaths: jest.fn() };
});
jest.mock("inquirer", function () {
  return { prompt: jest.fn() };
});

var mockConfig = ConfigManager as jest.Mocked<typeof ConfigManager>;
var mockAppUtils = AppUtils as jest.Mocked<typeof AppUtils>;

// Two scopes, each syncing a different extra table — enough to prove the
// union-vs-single-scope resolution.
function stubTwoScopes() {
  (mockConfig.getConfig as jest.Mock).mockReturnValue({
    scopes: { x_cadso_journey: {}, x_cadso_automate: {} },
  });
  (mockConfig.resolveConfigForScope as jest.Mock).mockImplementation(function (
    scopeName: string,
  ) {
    var extra =
      scopeName === "x_cadso_journey"
        ? "x_cadso_journey_action"
        : "x_cadso_core_setting";
    return { tables: ["sys_script", extra] };
  });
}

var defaultArgs = { logLevel: "info" } as any;

describe("normalizeTableFilter", function () {
  it("returns an empty list when the flag is absent", function () {
    expect(normalizeTableFilter(undefined)).toEqual([]);
    expect(normalizeTableFilter("")).toEqual([]);
  });

  it("accepts a single string", function () {
    expect(normalizeTableFilter("sys_script")).toEqual(["sys_script"]);
  });

  it("accepts a repeated flag (yargs array)", function () {
    expect(normalizeTableFilter(["sys_script", "sys_ui_action"])).toEqual([
      "sys_script",
      "sys_ui_action",
    ]);
  });

  it("splits comma-separated values", function () {
    expect(normalizeTableFilter("sys_script,sys_ui_action")).toEqual([
      "sys_script",
      "sys_ui_action",
    ]);
  });

  it("trims whitespace and de-dupes", function () {
    expect(normalizeTableFilter([" sys_script , sys_ui_action ", "sys_script"])).toEqual([
      "sys_script",
      "sys_ui_action",
    ]);
  });
});

describe("unknownTablesForScopes", function () {
  beforeEach(function () {
    logMessages = [];
    jest.clearAllMocks();
    stubTwoScopes();
  });

  it("accepts a table synced by the named scope", function () {
    expect(
      unknownTablesForScopes(["x_cadso_journey_action"], "x_cadso_journey"),
    ).toEqual([]);
  });

  it("rejects a table that belongs to a DIFFERENT scope when one is named", function () {
    expect(
      unknownTablesForScopes(["x_cadso_core_setting"], "x_cadso_journey"),
    ).toEqual(["x_cadso_core_setting"]);
  });

  it("accepts a table from any scope when no scope is named", function () {
    expect(unknownTablesForScopes(["x_cadso_core_setting"])).toEqual([]);
  });

  it("reports tables no scope syncs", function () {
    expect(unknownTablesForScopes(["sys_script", "nope_not_a_table"])).toEqual([
      "nope_not_a_table",
    ]);
  });
});

describe("refreshCommand --table", function () {
  beforeEach(function () {
    logMessages = [];
    jest.clearAllMocks();
    stubTwoScopes();
    (mockAppUtils.syncManifest as jest.Mock).mockResolvedValue(undefined);
  });

  it("hard-fails on an unsynced table and does NOT refresh", async function () {
    await expect(
      refreshCommand({
        ...defaultArgs,
        scope: "x_cadso_journey",
        table: ["nope_not_a_table"],
      }),
    ).rejects.toThrow(/nope_not_a_table is not synced by scope 'x_cadso_journey'/);

    expect(mockAppUtils.syncManifest).not.toHaveBeenCalled();
  });

  it("forwards the normalized table list to syncManifest", async function () {
    await refreshCommand({
      ...defaultArgs,
      scope: "x_cadso_journey",
      table: "x_cadso_journey_action",
    });

    expect(mockAppUtils.syncManifest).toHaveBeenCalledWith(
      "x_cadso_journey",
      expect.objectContaining({ tables: ["x_cadso_journey_action"] }),
    );
  });

  it("forwards undefined when no --table is given (unfiltered default)", async function () {
    await refreshCommand({ ...defaultArgs, scope: "x_cadso_journey" });

    expect(mockAppUtils.syncManifest).toHaveBeenCalledWith(
      "x_cadso_journey",
      expect.objectContaining({ tables: undefined }),
    );
  });
});
