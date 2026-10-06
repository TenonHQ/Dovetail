/**
 * dove-sn help — the usage table vs the dispatcher (#302).
 *
 * Two drift guards and one safety proof:
 *   1. Every `parsed.command === "<verb>"` dispatch site in cli.ts has a VERB_USAGE entry,
 *      and every entry has a dispatch site (derived from the source, not a hand list).
 *   2. The bareStringFlagError guard and the help read the same `stringFlags`, and each
 *      documented string flag is a flag the help actually lists.
 *   3. `<verb> --help` never loads an env file, never builds a client, never touches axios —
 *      the client factory and the env loader are mocked to THROW, so a regression that
 *      reorders main() fails loudly here instead of on a live instance.
 */
import * as fs from "fs";
import * as path from "path";

jest.mock("../src/client", () => ({
  createClient: jest.fn(() => {
    throw new Error("createClient must not be called on a help path");
  }),
  resolveFlowAuth: jest.fn(),
  isProcessflowPath: jest.fn(),
  PROCESSFLOW_PATH_PREFIX: "/api/now/processflow/",
}));
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => {
      throw new Error("axios.create must not be called on a help path");
    }),
  },
}));
jest.mock("../src/loadEnv", () => ({
  loadEnvFile: jest.fn(),
  SN_CONNECTION_KEYS: [],
}));
jest.mock("../src/mcp/server", () => ({
  runStdio: jest.fn(() => {
    throw new Error("runStdio must not be called on a help path");
  }),
  runSmoke: jest.fn(() => {
    throw new Error("runSmoke must not be called on a help path");
  }),
}));

import { createClient } from "../src/client";
import { loadEnvFile } from "../src/loadEnv";
import { runStdio } from "../src/mcp/server";
import { main, parseArgs } from "../src/cli";
import {
  GATE_TEXT,
  VERB_NAMES,
  VERB_USAGE,
  findClosestVerbs,
  formatUnknownVerb,
  formatVerbIndex,
  formatVerbUsage,
  normalizeVerbInput,
} from "../src/cliUsage";

var CLI_SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "cli.ts"), "utf8");

/** The verbs cli.ts dispatches on, read from the source so a new site can't be missed. */
function dispatchVerbsFromSource(): Array<string> {
  var re = /parsed\.command === "([a-z-]+)"/g;
  var seen: Record<string, boolean> = {};
  var out: Array<string> = [];
  var m = re.exec(CLI_SOURCE);
  while (m) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      out.push(m[1]);
    }
    m = re.exec(CLI_SOURCE);
  }
  return out;
}

/** Verbs that call bareStringFlagError("<verb>", ...) in cli.ts. */
function guardedVerbsFromSource(): Array<string> {
  var re = /bareStringFlagError\("([a-z-]+)"/g;
  var out: Array<string> = [];
  var m = re.exec(CLI_SOURCE);
  while (m) {
    out.push(m[1]);
    m = re.exec(CLI_SOURCE);
  }
  return out;
}

/** Every flag name a verb's help lists (required + optional, alternatives split out). */
function documentedFlags(verb: string): Array<string> {
  var docs = VERB_USAGE[verb].required.concat(VERB_USAGE[verb].optional);
  var out: Array<string> = [];
  for (var i = 0; i < docs.length; i += 1) {
    var alts = docs[i].flag.split(" | ");
    for (var a = 0; a < alts.length; a += 1) out.push(alts[a]);
  }
  return out;
}

interface Captured {
  stdout: string;
  stderr: string;
}

async function run(argv: Array<string>): Promise<{ code: number } & Captured> {
  var captured: Captured = { stdout: "", stderr: "" };
  var outSpy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation(function (chunk: string | Uint8Array): boolean {
      captured.stdout += String(chunk);
      return true;
    });
  var errSpy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation(function (chunk: string | Uint8Array): boolean {
      captured.stderr += String(chunk);
      return true;
    });
  try {
    var code = await main(argv);
    return { code: code, stdout: captured.stdout, stderr: captured.stderr };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(function () {
  jest.clearAllMocks();
});

describe("VERB_USAGE covers the dispatcher", function () {
  var dispatched = dispatchVerbsFromSource();

  it("finds the dispatch sites in cli.ts (sanity: the regex still matches the source)", function () {
    expect(dispatched.length).toBeGreaterThanOrEqual(30);
    expect(dispatched).toContain("add-choices");
    expect(dispatched).toContain("mcp");
    expect(dispatched).toContain("help");
  });

  it("has an entry for every dispatched verb", function () {
    var missing = dispatched.filter(function (v) {
      return !VERB_USAGE[v];
    });
    expect(missing).toEqual([]);
  });

  it("has a dispatch site for every entry (no orphan help)", function () {
    var orphan = VERB_NAMES.filter(function (v) {
      return dispatched.indexOf(v) === -1;
    });
    expect(orphan).toEqual([]);
  });

  it.each(VERB_NAMES)("%s has a non-empty, well-formed entry", function (verb) {
    var u = VERB_USAGE[verb];
    expect(u.summary.length).toBeGreaterThan(10);
    expect(u.summary.charAt(u.summary.length - 1)).not.toBe(".");
    expect(Object.keys(GATE_TEXT)).toContain(u.gate);
    expect(u.example.indexOf("dove-sn " + verb)).toBe(0);
    var block = formatVerbUsage(verb);
    expect(block.indexOf("dove-sn " + verb + " — ")).toBe(0);
    expect(block).toContain("Write gate:");
    expect(block).toContain("Example:");
    for (var i = 0; i < u.required.length; i += 1) {
      var first = u.required[i].flag.split(" | ")[0];
      expect(block).toContain("--" + first);
    }
    // No flag is documented twice within one verb.
    var flags = documentedFlags(verb);
    expect(new Set(flags).size).toBe(flags.length);
  });
});

describe("stringFlags stay in step with bareStringFlagError", function () {
  var guarded = guardedVerbsFromSource();

  it("finds the guarded verbs in cli.ts (sanity)", function () {
    expect(guarded.length).toBeGreaterThanOrEqual(6);
    expect(guarded).toContain("set-table");
  });

  it.each(guarded)("%s declares a non-empty stringFlags list", function (verb) {
    var list = VERB_USAGE[verb] ? VERB_USAGE[verb].stringFlags : undefined;
    expect(Array.isArray(list)).toBe(true);
    expect((list || []).length).toBeGreaterThan(0);
  });

  it.each(
    VERB_NAMES.filter(function (v) {
      return Boolean(VERB_USAGE[v].stringFlags);
    }),
  )("%s: every guarded string flag is one the help documents", function (verb) {
    var documented = documentedFlags(verb);
    var undocumented = (VERB_USAGE[verb].stringFlags || []).filter(function (f) {
      // camelCase aliases (updateSetSysId) are parser aliases, not documented spellings.
      return !/[A-Z]/.test(f) && documented.indexOf(f) === -1;
    });
    expect(undocumented).toEqual([]);
  });
});

describe("index and lookup helpers", function () {
  it("the index lists every verb once and points at help <verb>", function () {
    var index = formatVerbIndex();
    for (var i = 0; i < VERB_NAMES.length; i += 1) {
      expect(index).toContain("\n  " + VERB_NAMES[i] + " ");
    }
    expect(index).toContain("dove-sn help <verb>");
    expect(index).toContain("--env");
  });

  it("normalizeVerbInput strips everything but [a-z0-9-] and maps _ to -", function () {
    expect(normalizeVerbInput("  Add_Choices ")).toBe("add-choices");
    expect(normalizeVerbInput("set-column; rm -rf /")).toBe("set-columnrm-rf");
    expect(normalizeVerbInput("\u001b[31mx\u001b[0m")).toBe("31mx0m");
    expect(normalizeVerbInput(42)).toBe("");
    expect(normalizeVerbInput("a".repeat(200)).length).toBe(64);
  });

  it("findClosestVerbs: substring, prefix, token, tail-typo, none", function () {
    expect(findClosestVerbs("choices")).toEqual(["add-choices", "remove-choices"]);
    expect(findClosestVerbs("set-colum")).toEqual(["set-column"]);
    expect(findClosestVerbs("action_clone")).toContain("clone-action");
    expect(findClosestVerbs("action_clone")).not.toContain("set-column");
    expect(findClosestVerbs("choises")).toEqual(["add-choices", "remove-choices"]);
    expect(findClosestVerbs("set")).toContain("set-column");
    expect(findClosestVerbs("zzzz")).toEqual([]);
    expect(findClosestVerbs("")).toEqual([]);
  });

  it("formatUnknownVerb names the sanitized input and the matches", function () {
    var msg = formatUnknownVerb("add-choice$");
    expect(msg).toContain("unknown verb 'add-choice'");
    expect(msg).toContain("add-choices");
    expect(formatUnknownVerb("")).toContain("'(empty)'");
  });
});

describe("parseArgs", function () {
  it("treats a leading flag as no command and records positionals", function () {
    var p = parseArgs(["--help"]);
    expect(p.command).toBe("");
    expect(p.flags.help).toBe("true");
    var q = parseArgs(["help", "add-choices"]);
    expect(q.command).toBe("help");
    expect(q.positional).toEqual(["add-choices"]);
    var r = parseArgs(["add-choices", "--table", "t", "--help"]);
    expect(r.command).toBe("add-choices");
    expect(r.flags.table).toBe("t");
    expect(r.flags.help).toBe("true");
  });
});

describe("main(): help paths are offline", function () {
  afterEach(function () {
    expect(createClient).not.toHaveBeenCalled();
    expect(loadEnvFile).not.toHaveBeenCalled();
    expect(runStdio).not.toHaveBeenCalled();
  });

  it("bare dove-sn, help, and --help print the index", async function () {
    var forms: Array<Array<string>> = [[], ["help"], ["--help"]];
    for (var i = 0; i < forms.length; i += 1) {
      var r = await run(forms[i]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Verbs:");
      expect(r.stdout).toContain("dove-sn help <verb>");
    }
  });

  it("help <verb> prints that verb's required flags", async function () {
    var r = await run(["help", "add-choices"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dove-sn add-choices — ");
    expect(r.stdout).toContain("--choices");
    expect(r.stdout).toContain("value=Label");
    expect(r.stdout).toContain("--choice-type");
    expect(r.stdout).toContain("--from-json");
  });

  it("--help <verb> (verb read as the flag's value) also works", async function () {
    var r = await run(["--help", "set-field"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dove-sn set-field — ");
  });

  it.each(["add-choices", "invoke-rest", "publish-app", "export-app", "mcp"])(
    "%s --help short-circuits before env, client or server",
    async function (verb) {
      var r = await run([verb, "--help", "--env", ".env.nope"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("dove-sn " + verb + " — ");
      expect(r.stderr).toBe("");
    },
  );

  it("help <unknown> exits 1 with the closest matches", async function () {
    var r = await run(["help", "choices"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown verb 'choices'");
    expect(r.stderr).toContain("add-choices, remove-choices");
  });

  it("an unknown verb exits 1 before any env file is read", async function () {
    var r = await run(["bogus-verb", "--table", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown verb 'bogus-verb'");
    expect(r.stderr).toContain("dove-sn help");
  });
});

describe("main(): missing-flag errors carry the usage block", function () {
  it("add-choices with flags missing prints the error line, then the usage", async function () {
    var r = await run(["add-choices", "--table", "x_cadso_core_event"]);
    expect(r.code).toBe(1);
    expect(loadEnvFile).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(r.stderr).toContain("dove-sn error: Missing required flags: --table, --column, --update-set, --choices");
    expect(r.stderr).toContain("dove-sn add-choices — ");
    expect(r.stderr).toContain("--choices");
    expect(r.stderr.indexOf("Missing required flags")).toBeLessThan(r.stderr.indexOf("Required:"));
  });

  it("a verb that reports bad args itself gets the help pointer", async function () {
    var r = await run(["view-flow"]);
    expect(r.code).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(r.stderr).toContain("view-flow: --sys-id <sys_id> is required");
    expect(r.stderr).toContain("Run `dove-sn help view-flow`");
  });

  it("a bare string flag is refused via the shared stringFlags list", async function () {
    var r = await run(["set-table", "--table", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(r.stderr).toContain("set-table: --table needs a value");
  });
});

// #309 was authored before #307 / #308 / #310 landed; these pin the flags those PRs
// added so the usage table cannot silently fall behind the verbs again.
describe("usage entries reflect the sibling verb changes", function () {
  it("add-choices / remove-choices document --dry-run and are not 'writes immediately'", function () {
    ["add-choices", "remove-choices"].forEach(function (verb) {
      expect(documentedFlags(verb)).toContain("dry-run");
      expect(VERB_USAGE[verb].gate).toBe("dry-run-flag");
      expect(formatVerbUsage(verb)).not.toContain("there is no --dry-run");
    });
  });

  it("set-field / create-record document --from-stdin", function () {
    ["set-field", "create-record"].forEach(function (verb) {
      expect(documentedFlags(verb)).toContain("from-stdin");
    });
  });

  it("delete-record is dry-run by default and states where the capture lands until #297", function () {
    var block = formatVerbUsage("delete-record");
    expect(VERB_USAGE["delete-record"].gate).toBe("apply");
    expect(documentedFlags("delete-record")).toEqual(
      expect.arrayContaining(["table", "sys-id", "update-set", "apply", "dry-run"]),
    );
    expect(block).toContain("#297");
    expect(block).not.toContain("never routed to the session default");
  });

  it("dove-sn help delete-record resolves offline", async function () {
    var r = await run(["help", "delete-record"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dove-sn delete-record — ");
    expect(createClient).not.toHaveBeenCalled();
  });
});
