// `dove watch` is hidden from the `--help` command index but stays wired for
// humans (TenonHQ/Dovetail#155). These tests pin both halves: the help text
// never lists `watch` / `w` / `watchAllScopes`, and all three spellings still
// route to the watch handler. Mocks mirror commanderStrict.test.ts — the parser
// is under test, not the commands, which would hit ServiceNow.

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
import { watchAllScopesCommand } from "../allScopesCommands";

interface ParseResult {
  error: Error | undefined;
  output: string;
}

/**
 * @description Runs a fake `dove` invocation through a fresh, non-exiting parser.
 * @param {string[]} args - Argv as the user would type it, minus the binary name.
 * @returns {Promise<ParseResult>} The parse error (if any) and yargs' captured output.
 */
async function run(args: string[]): Promise<ParseResult> {
  const cli: Argv = configureCli(yargsFactory([])).exitProcess(false);
  const result = await new Promise<ParseResult>(function (resolve) {
    cli.parse(args, {}, function (error, _argv, output) {
      resolve({
        error: error === null ? undefined : (error as Error | undefined),
        output: output || "",
      });
    });
  });
  await new Promise(function (resolve) {
    setImmediate(resolve);
  });
  return result;
}

/**
 * @description Extracts the `dove <cmd>` command names listed in a yargs help
 * body (the "Commands:" index), so assertions target the index rather than
 * incidental prose in option descriptions.
 * @param {string} help - Captured `--help` output.
 * @returns {string[]} Command tokens exactly as the index prints them.
 */
function listedCommands(help: string): string[] {
  const names: string[] = [];
  const lines = help.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*dove\s+(\S+)/.exec(lines[i]);
    if (match) names.push(match[1]);
  }
  return names;
}

beforeEach(function () {
  jest.clearAllMocks();
});

describe("dove --help hides watch", function () {
  it("does not list watch, w, or watchAllScopes in the command index", async function () {
    const { output } = await run(["--help"]);
    const commands = listedCommands(output);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands).not.toContain("watch");
    expect(commands).not.toContain("w");
    expect(commands).not.toContain("watchAllScopes");
    expect(output).not.toMatch(/\bwatchAllScopes\b/);
    expect(output).not.toMatch(/\bdove\s+w(atch)?\b/);
  });

  it("still lists the safe headless verbs", async function () {
    const { output } = await run(["--help"]);
    const commands = listedCommands(output);
    expect(commands).toContain("refresh");
    expect(commands).toContain("push");
    expect(commands).toContain("status");
  });

  it("does not surface watch in the bare-invocation help either", async function () {
    const { output, error } = await run([]);
    expect(error).toBeDefined();
    expect(output + String(error)).not.toMatch(/\bwatchAllScopes\b/);
    expect(listedCommands(output)).not.toContain("watch");
  });
});

describe("dove watch stays wired for humans", function () {
  it("routes `watch` to the watch handler", async function () {
    const { error } = await run(["watch"]);
    expect(error).toBeUndefined();
    expect(watchAllScopesCommand).toHaveBeenCalledTimes(1);
  });

  it("routes the `w` and `watchAllScopes` aliases too", async function () {
    await run(["w"]);
    expect(watchAllScopesCommand).toHaveBeenCalledTimes(1);
    await run(["watchAllScopes"]);
    expect(watchAllScopesCommand).toHaveBeenCalledTimes(2);
  });

  it("passes watch flags through", async function () {
    await run(["watch", "--noDashboard", "--port", "4000"]);
    expect(watchAllScopesCommand).toHaveBeenCalledTimes(1);
    const mock = watchAllScopesCommand as jest.Mock;
    const args = mock.mock.calls[0][0] as { noDashboard?: boolean; port?: number };
    expect(args.noDashboard).toBe(true);
    expect(args.port).toBe(4000);
  });
});
