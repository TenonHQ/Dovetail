/**
 * CLI-level guard for #299: `dove-sn` must never wait on stdin unless told to.
 *
 * Spawns the BUILT cli (dist/cli.js) with an open, idle, NON-TTY stdin pipe that is
 * never written to and never closed — the shape an agent harness hands a background
 * child — and asserts the verb exits promptly. CI runs prepack (tsc) before jest, so
 * dist is present there; locally the suite is skipped with a visible reason when the
 * package has not been built.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

var CLI = path.resolve(__dirname, "..", "dist", "cli.js");
var US = "20756100334a03107b18bc534d5c7b2b";
var HAS_DIST = fs.existsSync(CLI);
var PROMPT_MS = 5000;

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

interface RunOptions {
  cwd: string;
  /** Leave the child's stdin open and idle for its whole lifetime (the #299 shape). */
  keepStdinOpen: boolean;
  /** Written to stdin before it is closed (ignored when keepStdinOpen). */
  stdinInput?: string;
  timeoutMs: number;
}

// Strip every ServiceNow connection var and the env-file selector so the child cannot
// reach a real instance, then give it a non-routable placeholder so createClient()
// constructs. A dry-run never sends a request.
function childEnv(): NodeJS.ProcessEnv {
  var env: NodeJS.ProcessEnv = {};
  var parent = process.env;
  Object.keys(parent).forEach(function (key) {
    if (key.indexOf("SN_") === 0 || key === "DOVETAIL_ENV_FILE") return;
    env[key] = parent[key];
  });
  env["SN_INSTANCE"] = "dove-sn-test.invalid";
  env["SN_USER"] = "test";
  env["SN_PASSWORD"] = "test";
  env["SN_REQUEST_INTERVAL_MS"] = "0";
  return env;
}

function runCli(args: Array<string>, opts: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>(function (resolve) {
    var start = Date.now();
    var child = spawn(process.execPath, [CLI].concat(args), {
      cwd: opts.cwd,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    var stdout = "";
    var stderr = "";
    var timedOut = false;
    child.stdout.on("data", function (d: Buffer) { stdout += d.toString("utf8"); });
    child.stderr.on("data", function (d: Buffer) { stderr += d.toString("utf8"); });
    child.stdin.on("error", function () { /* child exited before we closed our end */ });
    var timer = setTimeout(function () {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("close", function (code, signal) {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({
        code: code,
        signal: signal,
        stdout: stdout,
        stderr: stderr,
        ms: Date.now() - start,
        timedOut: timedOut
      });
    });
    if (!opts.keepStdinOpen) {
      if (opts.stdinInput !== undefined) child.stdin.write(opts.stdinInput);
      child.stdin.end();
    }
    // keepStdinOpen: the write end stays open and silent until the child is gone.
  });
}

var describeIfBuilt = HAS_DIST ? describe : describe.skip;

describeIfBuilt("dove-sn record verbs never wait on an idle stdin (#299) [spawns dist/cli.js]", function () {
  var dir: string;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dove-cli-stdin-"));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("create-record --dry-run with every input as a flag exits promptly while stdin stays open", async function () {
    var r = await runCli(
      ["create-record", "--dry-run", "--table", "x_cadso_core_test", "--fields", "name=a,order=35",
        "--scope", "x_cadso_core", "--update-set", US],
      { cwd: dir, keepStdinOpen: true, timeoutMs: 15000 }
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(PROMPT_MS);
    expect(r.stdout).toMatch(/^\[dry-run\] x_cadso_core_test\/\(new\)/);
  }, 20000);

  it("create-record --dry-run --json emits the structured result while stdin stays open", async function () {
    var r = await runCli(
      ["create-record", "--dry-run", "--json", "--table", "x_cadso_core_test", "--fields", "name=a",
        "--scope", "x_cadso_core", "--update-set", US],
      { cwd: dir, keepStdinOpen: true, timeoutMs: 15000 }
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    var parsed: unknown = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ status: "dry-run", table: "x_cadso_core_test", fields: { name: "a" } });
  }, 20000);

  it("create-record with no field source fails immediately with the usage line (no stdin read)", async function () {
    var r = await runCli(
      ["create-record", "--dry-run", "--table", "x_cadso_core_test", "--scope", "x_cadso_core", "--update-set", US],
      { cwd: dir, keepStdinOpen: true, timeoutMs: 15000 }
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(PROMPT_MS);
    expect(r.stderr).toMatch(/create-record: --table, --scope, --update-set, and at least one field/);
    expect(r.stderr).toMatch(/--from-stdin/);
  }, 20000);

  it("set-field with a missing required flag fails immediately while stdin stays open", async function () {
    var r = await runCli(
      ["set-field", "--dry-run", "--table", "x_cadso_core_test", "--sys-id", "abc", "--fields", "order=1"],
      { cwd: dir, keepStdinOpen: true, timeoutMs: 15000 }
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(PROMPT_MS);
    expect(r.stderr).toMatch(/set-field: --table, one of --sys-id\/--query, --update-set/);
  }, 20000);

  it("create-record --from-stdin reads the piped JSON object", async function () {
    var r = await runCli(
      ["create-record", "--dry-run", "--json", "--from-stdin", "--table", "x_cadso_core_test",
        "--scope", "x_cadso_core", "--update-set", US],
      {
        cwd: dir,
        keepStdinOpen: false,
        stdinInput: JSON.stringify({ description: "contact @tenon, line 2\nline 3" }),
        timeoutMs: 15000
      }
    );
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    var parsed: unknown = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({
      status: "dry-run",
      fields: { description: "contact @tenon, line 2\nline 3" }
    });
  }, 20000);

  it("create-record --from-json - is the stdin sentinel", async function () {
    var r = await runCli(
      ["create-record", "--dry-run", "--json", "--from-json", "-", "--table", "x_cadso_core_test",
        "--scope", "x_cadso_core", "--update-set", US],
      { cwd: dir, keepStdinOpen: false, stdinInput: '{"name":"from-stdin"}', timeoutMs: 15000 }
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    var parsed: unknown = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ status: "dry-run", fields: { name: "from-stdin" } });
  }, 20000);

  it("create-record --from-stdin with an empty, closed stdin fails with an actionable error", async function () {
    var r = await runCli(
      ["create-record", "--dry-run", "--from-stdin", "--table", "x_cadso_core_test",
        "--scope", "x_cadso_core", "--update-set", US],
      { cwd: dir, keepStdinOpen: false, stdinInput: "", timeoutMs: 15000 }
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/create-record: --from-stdin: stdin was empty/);
  }, 20000);
});

if (!HAS_DIST) {
  // Keep the file from being an empty suite, and say why the spawn tests did not run.
  describe("dove-sn stdin CLI tests", function () {
    it("are skipped until packages/servicenow is built (dist/cli.js missing — run npx tsc)", function () {
      expect(HAS_DIST).toBe(false);
    });
  });
}
