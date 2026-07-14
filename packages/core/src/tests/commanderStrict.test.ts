// --- Mock setup (must be before imports) ---
//
// Every command module is mocked: these tests exercise the parser (routing +
// strictness), not the commands themselves, and the real handlers would hit
// ServiceNow.
jest.mock("../commands", () => ({
  refreshCommand: jest.fn(),
  pushCommand: jest.fn(),
  downloadCommand: jest.fn(),
  initCommand: jest.fn(),
  buildCommand: jest.fn(),
  deployCommand: jest.fn(),
  statusCommand: jest.fn(),
  taskClearCommand: jest.fn(),
}));
jest.mock("../allScopesCommands", () => ({
  initScopesCommand: jest.fn(),
  watchAllScopesCommand: jest.fn(),
}));
jest.mock("../updateSetCommands", () => ({
  createUpdateSetCommand: jest.fn(),
  switchUpdateSetCommand: jest.fn(),
  listUpdateSetsCommand: jest.fn(),
  showCurrentUpdateSetCommand: jest.fn(),
  changeScopeCommand: jest.fn(),
  showCurrentScopeCommand: jest.fn(),
}));
jest.mock("../dashboardCommand", () => ({ dashboardCommand: jest.fn() }));
jest.mock("../schemaCommand", () => ({
  schemaPullCommand: jest.fn(),
  schemaDiffCommand: jest.fn(),
  schemaSnapshotsCommand: jest.fn(),
}));
jest.mock("../claudeCommand", () => ({ initClaudeCommand: jest.fn() }));
jest.mock("../createRecordCommand", () => ({ createRecordCommand: jest.fn() }));
jest.mock("../deleteRecordCommand", () => ({ deleteRecordCommand: jest.fn() }));
jest.mock("../reconcileCommand", () => ({ reconcileCommand: jest.fn() }));
jest.mock("../migrateCommand", () => ({ migrateCommand: jest.fn() }));
jest.mock("../loginCommand", () => ({ loginCommand: jest.fn() }));
jest.mock("../knowledgeDiffCommand", () => ({ knowledgeDiffCommand: jest.fn() }));
jest.mock("../clickupCommands", () => ({
  clickupTasksCommand: jest.fn(),
  clickupTaskCommand: jest.fn(),
  clickupCreateCommand: jest.fn(),
  clickupUpdateCommand: jest.fn(),
  clickupCommentCommand: jest.fn(),
  clickupSetupCommand: jest.fn(),
  clickupTeamsCommand: jest.fn(),
  clickupSpacesCommand: jest.fn(),
  clickupListsCommand: jest.fn(),
}));

// --- Imports (after mocks) ---

import yargsFactory from "yargs/yargs";
import type { Argv } from "yargs";
import { configureCli } from "../commander";
import { refreshCommand, statusCommand, pushCommand } from "../commands";

interface ParseResult {
  error: Error | undefined;
  output: string;
  argv: Record<string, unknown>;
}

/**
 * @description Runs a fake `dove` invocation through a fresh, non-exiting parser.
 * @param {string[]} args - Argv as the user would type it, minus the binary name.
 * @returns {Promise<ParseResult>} The parse error (if any), yargs' captured output, and the parsed argv.
 */
async function run(args: string[]): Promise<ParseResult> {
  const cli: Argv = configureCli(yargsFactory([])).exitProcess(false);
  const result = await new Promise<ParseResult>(function (resolve) {
    cli.parse(args, {}, function (error, argv, output) {
      resolve({
        error: error === null ? undefined : (error as Error | undefined),
        output: output || "",
        argv: (argv || {}) as Record<string, unknown>,
      });
    });
  });
  // Command handlers are async; let their microtasks flush before asserting.
  await new Promise(function (resolve) {
    setImmediate(resolve);
  });
  return result;
}

beforeEach(function () {
  jest.clearAllMocks();
});

describe("dove pull", function () {
  it("routes `pull` to the refresh command", async function () {
    const { error } = await run(["pull"]);
    expect(error).toBeUndefined();
    expect(refreshCommand).toHaveBeenCalledTimes(1);
  });

  it("still routes the canonical `refresh` and its `r` alias", async function () {
    await run(["refresh"]);
    expect(refreshCommand).toHaveBeenCalledTimes(1);
    await run(["r"]);
    expect(refreshCommand).toHaveBeenCalledTimes(2);
  });

  it("passes refresh flags through the pull alias", async function () {
    const { error, argv } = await run(["pull", "--scope", "x_cadso_core", "--force"]);
    expect(error).toBeUndefined();
    expect(argv.scope).toBe("x_cadso_core");
    expect(argv.force).toBe(true);
    expect(refreshCommand).toHaveBeenCalledTimes(1);
  });
});

describe("unknown commands", function () {
  it("errors instead of silently succeeding", async function () {
    const { error } = await run(["psuh"]);
    expect(error).toBeDefined();
    expect(String(error)).toContain("Unknown command");
    expect(pushCommand).not.toHaveBeenCalled();
  });

  it("suggests the closest real command on a typo", async function () {
    const { error, output } = await run(["refesh"]);
    expect(error).toBeDefined();
    expect(output + String(error)).toContain("Did you mean refresh?");
    expect(refreshCommand).not.toHaveBeenCalled();
  });

  it("errors when no command is given at all", async function () {
    const { error } = await run([]);
    expect(error).toBeDefined();
    expect(String(error)).toContain("Please specify a command");
  });
});

describe("existing invocations keep working", function () {
  it("accepts a known command", async function () {
    const { error } = await run(["status"]);
    expect(error).toBeUndefined();
    expect(statusCommand).toHaveBeenCalledTimes(1);
  });

  it("accepts push with its --diff flag and optional target positional", async function () {
    const { error, argv } = await run(["push", "--diff", "main"]);
    expect(error).toBeUndefined();
    expect(argv.diff).toBe("main");
    expect(pushCommand).toHaveBeenCalledTimes(1);
  });

  it("accepts the documented --env-file spelling (not just --env)", async function () {
    // strictCommands, not strict: undeclared flags stay tolerated and the
    // documented env aliases all resolve to `env`. See envArg.ts.
    const { error, argv } = await run(["status", "--env-file", ".env.prod"]);
    expect(error).toBeUndefined();
    expect(argv.env).toBe(".env.prod");
  });

  it("still routes nested subcommands", async function () {
    const { error } = await run(["schema", "pull"]);
    expect(error).toBeUndefined();
  });

  it("rejects an unknown nested subcommand", async function () {
    const { error } = await run(["clickup", "taks"]);
    expect(error).toBeDefined();
  });
});
