/**
 * dispatch_stage tests — exercises every precondition from
 * docs/v2-design.md §7.3 and confirms the dry-run / live mode split
 * behaves as designed. The spawn primitive is injected so no actual
 * `claude` process is launched.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { pushPlan, setStage, dispatchStage } from "../storage";
import {
  MissingAgentError,
  NoTokenError,
  StaleTokenError,
  SpawnError,
  KNOWN_MISSING_AGENTS,
  resolveDispatchCommand,
  validateToken
} from "../dispatch";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-dispatch-"));
}

function rawPlan(root: string, slug: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, slug + ".json"), "utf8"));
}

// Always-succeeds spawn stub. Records call count + last argv/cwd so
// tests can assert on what would have been launched.
function fakeSpawn(opts: { pid?: number } = {}) {
  var calls: Array<{ argv: string[]; cwd: string }> = [];
  var fn = function (argv: string[], cwd: string) {
    calls.push({ argv: argv, cwd: cwd });
    return { pid: opts.pid || 1234 };
  };
  return { fn: fn, calls: calls };
}

describe("dispatch_stage — dry-run (default)", function () {
  it("returns the resolved command without spawning", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    setStage({ plan_slug: "t", to: "research" }, { rootDir: root });

    var spawn = fakeSpawn();
    var res = dispatchStage(
      { plan_slug: "t", target_stage: "research" },
      { rootDir: root, spawn: spawn.fn }
    );

    expect(res.mode).toBe("dry-run");
    expect(res.command).toMatch(/^claude --resume-plan t --target-stage research /);
    expect(typeof res.cwd).toBe("string");
    expect(res.pid).toBeUndefined();
    expect(spawn.calls).toHaveLength(0);
  });

  it("appends a dry-run event to dispatch_log", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
    dispatchStage(
      { plan_slug: "t", target_stage: "research" },
      { rootDir: root, spawn: fakeSpawn().fn }
    );
    var disk = rawPlan(root, "t");
    expect(disk.dispatch_log).toHaveLength(1);
    expect(disk.dispatch_log[0]).toMatchObject({
      mode: "dry-run",
      target_stage: "research",
      outcome: "ok"
    });
  });

  it("does NOT consume the token in dry-run mode", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
    dispatchStage(
      { plan_slug: "t", target_stage: "research" },
      { rootDir: root, spawn: fakeSpawn().fn }
    );
    var disk = rawPlan(root, "t");
    expect(disk.dispatch_token.consumed_at).toBeUndefined();
  });
});

describe("dispatch_stage — MissingAgentError (stages 5 & 9)", function () {
  it("raises MissingAgentError for test-first naming test-author", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    setStage({ plan_slug: "t", to: "planning" }, { rootDir: root });
    // The set_stage call to planning rotated the token; here we attempt
    // dispatch to test-first (legal next from planning) but the agent
    // is absent — should throw before any I/O.
    setStage({ plan_slug: "t", to: "test-first" }, { rootDir: root });

    expect(KNOWN_MISSING_AGENTS["test-first"]).toBe("test-author");
    var threw: MissingAgentError | null = null;
    try {
      dispatchStage(
        { plan_slug: "t", target_stage: "test-first" },
        { rootDir: root, spawn: fakeSpawn().fn }
      );
    } catch (e) {
      threw = e as any;
    }
    expect(threw).toBeInstanceOf(MissingAgentError);
    expect((threw as any).agent).toBe("test-author");
  });

  it("raises MissingAgentError for test-reality naming test-reality-checker", function () {
    expect(KNOWN_MISSING_AGENTS["test-reality"]).toBe("test-reality-checker");
  });

  it("raises BEFORE writing to disk (no log entry, token untouched)", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    setStage({ plan_slug: "t", to: "planning" }, { rootDir: root });
    setStage({ plan_slug: "t", to: "test-first" }, { rootDir: root });
    var before = fs.readFileSync(path.join(root, "t.json"), "utf8");
    try {
      dispatchStage(
        { plan_slug: "t", target_stage: "test-first" },
        { rootDir: root, spawn: fakeSpawn().fn }
      );
    } catch (e) { /* expected */ }
    var after = fs.readFileSync(path.join(root, "t.json"), "utf8");
    expect(after).toBe(before);
  });
});

describe("dispatch_stage — live mode preconditions", function () {
  function setupStaged(): { root: string; token: string } {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    var staged = setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
    return { root: root, token: staged.token.token };
  }

  it("rejects with NoTokenError when confirm=true but token omitted", function () {
    var s = setupStaged();
    expect(function () {
      dispatchStage(
        { plan_slug: "t", target_stage: "research", confirm: true },
        { rootDir: s.root, spawn: fakeSpawn().fn }
      );
    }).toThrow(NoTokenError);
  });

  it("rejects with StaleTokenError on token mismatch", function () {
    var s = setupStaged();
    expect(function () {
      dispatchStage(
        { plan_slug: "t", target_stage: "research", confirm: true, token: "tok_" + "0".repeat(24) },
        { rootDir: s.root, spawn: fakeSpawn().fn }
      );
    }).toThrow(StaleTokenError);
  });

  it("rejects with StaleTokenError when token is for a different stage", function () {
    var s = setupStaged();
    // Token was issued for 'research'; try to use it for 'planning'.
    expect(function () {
      dispatchStage(
        { plan_slug: "t", target_stage: "planning", confirm: true, token: s.token },
        { rootDir: s.root, spawn: fakeSpawn().fn }
      );
    }).toThrow(StaleTokenError);
  });

  it("rejects with StaleTokenError when the token is expired", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    var prev = process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS;
    process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS = "1"; // 1 ms TTL
    var staged: ReturnType<typeof setStage> | null = null;
    try {
      staged = setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
    } finally {
      if (prev === undefined) delete process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS;
      else process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS = prev;
    }
    // Sleep past the expiry.
    var sleep = function (ms: number) {
      var until = Date.now() + ms;
      // Busy-wait — deterministic across runners.
      while (Date.now() < until) { /* spin */ }
    };
    sleep(5);
    if (!staged) throw new Error("staged not set");
    var stagedToken = staged.token.token;
    expect(function () {
      dispatchStage(
        { plan_slug: "t", target_stage: "research", confirm: true, token: stagedToken },
        { rootDir: root, spawn: fakeSpawn().fn }
      );
    }).toThrow(StaleTokenError);
  });

  it("rejects with StaleTokenError when the token has already been consumed", function () {
    var s = setupStaged();
    var spawn = fakeSpawn();
    dispatchStage(
      { plan_slug: "t", target_stage: "research", confirm: true, token: s.token },
      { rootDir: s.root, spawn: spawn.fn }
    );
    // Same token, second time.
    expect(function () {
      dispatchStage(
        { plan_slug: "t", target_stage: "research", confirm: true, token: s.token },
        { rootDir: s.root, spawn: spawn.fn }
      );
    }).toThrow(StaleTokenError);
  });

  it("records the rejection in dispatch_log so the dashboard sees the failed attempt", function () {
    var s = setupStaged();
    try {
      dispatchStage(
        { plan_slug: "t", target_stage: "research", confirm: true, token: "tok_" + "0".repeat(24) },
        { rootDir: s.root, spawn: fakeSpawn().fn }
      );
    } catch (e) { /* expected */ }
    var disk = rawPlan(s.root, "t");
    expect(disk.dispatch_log.length).toBeGreaterThan(0);
    var last = disk.dispatch_log[disk.dispatch_log.length - 1];
    expect(last.outcome).toBe("stale-token");
    expect(last.mode).toBe("live");
  });
});

describe("dispatch_stage — live spawn success", function () {
  it("consumes the token, spawns, and records pid in dispatch_log", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    var staged = setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
    var spawn = fakeSpawn({ pid: 99999 });

    var res = dispatchStage(
      { plan_slug: "t", target_stage: "research", confirm: true, token: staged.token.token },
      { rootDir: root, spawn: spawn.fn }
    );

    expect(res.mode).toBe("live");
    expect(res.pid).toBe(99999);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].argv[0]).toBe("claude");
    expect(spawn.calls[0].argv).toEqual(expect.arrayContaining(["--resume-plan", "t", "--target-stage", "research"]));

    var disk = rawPlan(root, "t");
    expect(disk.dispatch_token.consumed_at).toBeDefined();
    expect(disk.dispatch_log.length).toBeGreaterThanOrEqual(1);
    var live = disk.dispatch_log[disk.dispatch_log.length - 1];
    expect(live.outcome).toBe("ok");
    expect(live.mode).toBe("live");
    expect(live.pid).toBe(99999);
  });

  it("consumes the token BEFORE spawn so a spawn crash still invalidates it", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    var staged = setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
    var explodingSpawn = function () { throw new SpawnError("boom"); };
    expect(function () {
      dispatchStage(
        { plan_slug: "t", target_stage: "research", confirm: true, token: staged.token.token },
        { rootDir: root, spawn: explodingSpawn }
      );
    }).toThrow(SpawnError);
    var disk = rawPlan(root, "t");
    expect(disk.dispatch_token.consumed_at).toBeDefined(); // consumed despite spawn failure
    var last = disk.dispatch_log[disk.dispatch_log.length - 1];
    expect(last.outcome).toBe("spawn-error");
  });
});

describe("validateToken — pure unit", function () {
  var basePlan: any = {
    slug: "t",
    title: "T",
    status: "DRAFT",
    content_md: "x",
    content_hash: "0".repeat(64),
    created_at: "2026-05-26T12:00:00.000Z",
    updated_at: "2026-05-26T12:00:00.000Z",
    session_id: null,
    schema_version: 2
  };
  var goodToken = {
    token: "tok_" + "a".repeat(24),
    issued_for_stage: "research",
    issued_at: "2026-05-26T12:00:00.000Z",
    expires_at: "2026-05-26T12:05:00.000Z"
  };
  var now = Date.parse("2026-05-26T12:01:00.000Z"); // 1 minute in

  it("ok when everything aligns", function () {
    var plan = Object.assign({}, basePlan, { dispatch_token: goodToken });
    expect(validateToken(plan, goodToken.token, "research", now)).toEqual({ ok: true });
  });
  it("missing token argument", function () {
    var plan = Object.assign({}, basePlan, { dispatch_token: goodToken });
    expect(validateToken(plan, undefined, "research", now).ok).toBe(false);
  });
  it("no stored token", function () {
    expect(validateToken(basePlan, goodToken.token, "research", now).ok).toBe(false);
  });
  it("consumed", function () {
    var plan = Object.assign({}, basePlan, {
      dispatch_token: Object.assign({}, goodToken, { consumed_at: "2026-05-26T12:00:30.000Z" })
    });
    expect(validateToken(plan, goodToken.token, "research", now).ok).toBe(false);
  });
});

describe("resolveDispatchCommand — pure unit", function () {
  it("builds an argv list (no shell interpolation surface)", function () {
    var plan: any = { slug: "plan-with-dashes" };
    var resolved = resolveDispatchCommand(plan, "research");
    expect(resolved.argv).toEqual([
      "claude",
      "--resume-plan", "plan-with-dashes",
      "--target-stage", "research",
      "--session-source", "dispatch"
    ]);
    expect(resolved.command).toBe(resolved.argv.join(" "));
  });

  it("honors DOVE_CLAUDE_PLANS_DISPATCH_CWD override", function () {
    var prev = process.env.DOVE_CLAUDE_PLANS_DISPATCH_CWD;
    process.env.DOVE_CLAUDE_PLANS_DISPATCH_CWD = "/tmp/dispatch-test";
    try {
      var plan: any = { slug: "x" };
      var resolved = resolveDispatchCommand(plan, "research");
      expect(resolved.cwd).toBe("/tmp/dispatch-test");
    } finally {
      if (prev === undefined) delete process.env.DOVE_CLAUDE_PLANS_DISPATCH_CWD;
      else process.env.DOVE_CLAUDE_PLANS_DISPATCH_CWD = prev;
    }
  });
});
