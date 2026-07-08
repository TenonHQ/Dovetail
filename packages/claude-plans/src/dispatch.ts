/**
 * dispatch_stage implementation — Phase D.
 *
 * The riskiest surface in v2: spawns a Claude Code subprocess against a
 * stored plan. Safety model is documented in docs/v2-design.md §7 and
 * MUST be implemented exactly:
 *
 *   1. Default mode is dry-run. Resolve command + cwd, append a
 *      dispatch_log entry, return — do NOT spawn.
 *   2. Live mode requires `confirm: true` AND a valid token. The 8
 *      preconditions in §7.3 are checked atomically before any spawn.
 *   3. Stages "test-first" and "test-reality" target net-new agents
 *      from PR #160. Until they ship, dispatch raises MissingAgentError
 *      naming the absent agent — never silent no-op.
 *   4. Token consumption is atomic and happens BEFORE the spawn call,
 *      so a crashed/leaked subprocess never invalidates the token's
 *      single-use guarantee.
 *
 * The spawn primitive is injected for testability (dispatch tests stub
 * it; production wires child_process.spawn).
 */

import * as path from "path";
import { spawn as realSpawn } from "child_process";

import { ClaudePlan, DispatchEvent, PipelineStage } from "./types";

// ---- Error taxonomy --------------------------------------------------------

export class MissingAgentError extends Error {
  public code: string;
  public stage: PipelineStage;
  public agent: string;
  constructor(stage: PipelineStage, agent: string) {
    super(
      "dispatch_stage cannot target " +
        stage +
        ": the '" +
        agent +
        "' agent has not been authored yet (see PR #160)",
    );
    this.name = "MissingAgentError";
    this.code = "MISSING_AGENT";
    this.stage = stage;
    this.agent = agent;
  }
}

export class NoTokenError extends Error {
  public code: string;
  constructor(reason: string) {
    super("dispatch_stage live mode requires a token: " + reason);
    this.name = "NoTokenError";
    this.code = "NO_TOKEN";
  }
}

export class StaleTokenError extends Error {
  public code: string;
  public reason: string;
  constructor(reason: string) {
    super("dispatch_stage rejected: token is stale (" + reason + ")");
    this.name = "StaleTokenError";
    this.code = "STALE_TOKEN";
    this.reason = reason;
  }
}

export class SpawnError extends Error {
  public code: string;
  public cause: unknown;
  constructor(message: string, cause?: unknown) {
    super("dispatch_stage spawn failed: " + message);
    this.name = "SpawnError";
    this.code = "SPAWN_ERROR";
    this.cause = cause;
  }
}

// ---- Missing-agent gate ----------------------------------------------------

/**
 * Stages whose driving agent has not been authored yet. Clear an entry
 * here when the corresponding agent ships (PR #160 for both).
 */
export var KNOWN_MISSING_AGENTS: Partial<Record<PipelineStage, string>> = {
  "test-first": "test-author",
  "test-reality": "test-reality-checker",
};

export function assertAgentAvailable(stage: PipelineStage): void {
  var agent = KNOWN_MISSING_AGENTS[stage];
  if (agent) throw new MissingAgentError(stage, agent);
}

// ---- Command resolution ----------------------------------------------------

export interface ResolvedCommand {
  argv: string[];
  command: string;
  cwd: string;
}

/**
 * Build the argv + cwd the spawn will use. Pure — useful for the
 * dashboard's pre-dispatch preview tooltip and for the dry-run response.
 * Never shell-interpolated; argv is passed straight to spawn().
 */
export function resolveDispatchCommand(
  plan: ClaudePlan,
  stage: PipelineStage,
): ResolvedCommand {
  var cwd = process.env.DOVE_CLAUDE_PLANS_DISPATCH_CWD || process.cwd();
  // session_id is reserved for future use (e.g. mapping back to the repo
  // the originating session was running in). Today we don't bind to it
  // beyond logging.
  var argv = [
    "claude",
    "--resume-plan",
    plan.slug,
    "--target-stage",
    stage,
    "--session-source",
    "dispatch",
  ];
  return {
    argv: argv,
    command: argv.join(" "),
    cwd: path.resolve(cwd),
  };
}

// ---- Spawn injection -------------------------------------------------------

export interface SpawnResult {
  pid: number;
}
export type SpawnFn = (argv: string[], cwd: string) => SpawnResult;

/**
 * Default production spawn: detached child_process.spawn, stdio inherited
 * so the new session attaches to the operator's terminal. Returns the
 * pid; throws SpawnError on failure to launch.
 */
export var productionSpawn: SpawnFn = function (
  argv: string[],
  cwd: string,
): SpawnResult {
  try {
    var child = realSpawn(argv[0], argv.slice(1), {
      cwd: cwd,
      stdio: "inherit",
      detached: true,
    });
    child.unref();
    if (typeof child.pid !== "number") {
      throw new SpawnError("spawn returned undefined pid");
    }
    return { pid: child.pid };
  } catch (e) {
    if (e instanceof SpawnError) throw e;
    var msg = e instanceof Error ? e.message : String(e);
    throw new SpawnError(msg, e);
  }
};

// ---- Token validation ------------------------------------------------------

export interface TokenCheck {
  reason?: string;
  ok: boolean;
}

export function validateToken(
  plan: ClaudePlan,
  providedToken: string | undefined,
  targetStage: PipelineStage,
  nowMs: number,
): TokenCheck {
  if (!providedToken)
    return { ok: false, reason: "token argument is required" };
  var stored = plan.dispatch_token || null;
  if (!stored)
    return {
      ok: false,
      reason: "plan has no outstanding token (call set_stage first)",
    };
  if (stored.token !== providedToken)
    return { ok: false, reason: "token mismatch" };
  if (stored.consumed_at)
    return { ok: false, reason: "token already consumed" };
  if (stored.issued_for_stage !== targetStage) {
    return {
      ok: false,
      reason:
        "token issued for " + stored.issued_for_stage + ", not " + targetStage,
    };
  }
  if (nowMs > Date.parse(stored.expires_at)) {
    return { ok: false, reason: "token expired at " + stored.expires_at };
  }
  return { ok: true };
}

// ---- DispatchEvent helpers -------------------------------------------------

export function makeEvent(opts: {
  targetStage: PipelineStage;
  mode: "dry-run" | "live";
  by: string;
  command?: string;
  cwd?: string;
  outcome: DispatchEvent["outcome"];
  pid?: number;
  error?: string;
  nowIso: string;
}): DispatchEvent {
  var ev: DispatchEvent = {
    at: opts.nowIso,
    target_stage: opts.targetStage,
    mode: opts.mode,
    by: opts.by,
    outcome: opts.outcome,
  };
  if (opts.command !== undefined) ev.command = opts.command;
  if (opts.cwd !== undefined) ev.cwd = opts.cwd;
  if (opts.pid !== undefined) ev.pid = opts.pid;
  if (opts.error !== undefined) ev.error = opts.error;
  return ev;
}
