/**
 * Claude Code session detection for human-only CLI surfaces.
 *
 * `dove watch` auto-syncs the working tree to the instance, and a git branch
 * switch mid-watch pushes the post-switch file state over live records. An
 * agent can't guarantee it stops the watcher before every branch operation, so
 * the command is hidden from `--help`, refuses to start in a Claude Code tool
 * shell (`CLAUDECODE`), and only warns on the broader `CLAUDE_CODE_*` signal.
 * See TenonHQ/Dovetail#155.
 *
 * Pure functions — no I/O — so the detection is unit-testable without touching
 * `process.env` directly.
 */

// Claude Code exports `CLAUDECODE=1` into every tool shell, plus a family of
// `CLAUDE_CODE_*` variables (e.g. `CLAUDE_CODE_SESSION_ID`, which claude-plans
// already keys on). Any one of them set to a non-empty value is a session.
var CLAUDE_SESSION_FLAG = "CLAUDECODE";
var CLAUDE_SESSION_PREFIX = "CLAUDE_CODE_";

/**
 * @description Human-only warning printed when `dove watch` starts with a
 * Claude Code signal that does not block it (a `CLAUDE_CODE_*` config
 * variable, or `CLAUDECODE` with the human override). TenonHQ/Dovetail#155.
 */
export var WATCH_HUMAN_ONLY_WARNING =
  "⚠ `dove watch` is a human-only local-dev tool — it auto-syncs to the " +
  "instance and a branch switch mid-watch overwrites records. Don't run this " +
  "inside Claude Code. Use `npx dove push --diff <branch>` / `npx dove refresh` / " +
  "`npx dove status` instead. See TenonHQ/Dovetail#155.";

/**
 * @description Env var a human sets to `1` to run `dove watch` anyway from a
 * shell that carries `CLAUDECODE` (e.g. an IDE terminal that inherited it).
 */
export var WATCH_ALLOW_IN_CLAUDE_ENV = "DOVE_ALLOW_WATCH_IN_CLAUDE";

/**
 * @description Error printed when `dove watch` refuses to start inside a
 * Claude Code tool shell. Names the human override.
 */
export var WATCH_BLOCKED_IN_CLAUDE_ERROR =
  "`dove watch` refused: this is a Claude Code tool shell (CLAUDECODE is set). " +
  "The watcher auto-syncs to the instance and a branch switch mid-watch " +
  "overwrites records. Use `npx dove push --diff <branch>` / `npx dove refresh` / " +
  "`npx dove status` instead. A human who really means to run it from this " +
  "shell can set " +
  WATCH_ALLOW_IN_CLAUDE_ENV +
  "=1. See TenonHQ/Dovetail#155.";

/**
 * @description Reports whether the environment is a Claude Code tool shell:
 * `CLAUDECODE` set to a non-empty value. This is the hard-block signal — the
 * broader `CLAUDE_CODE_*` prefix match also hits humans with config variables
 * (e.g. `CLAUDE_CODE_USE_BEDROCK`) in their shell profile, so it only warns.
 * @param {NodeJS.ProcessEnv} env - Environment to inspect (defaults to `process.env`).
 * @returns {boolean} True when `CLAUDECODE` is set.
 */
export function isClaudeCodeToolShell(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env || typeof env !== "object") return false;
  return hasValue(env[CLAUDE_SESSION_FLAG]);
}

/**
 * @description True when the human override for running `dove watch` inside a
 * Claude Code tool shell is set to exactly `1`.
 * @param {NodeJS.ProcessEnv} env - Environment to inspect (defaults to `process.env`).
 * @returns {boolean} Whether the override is active.
 */
export function isWatchInClaudeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env || typeof env !== "object") return false;
  var value = env[WATCH_ALLOW_IN_CLAUDE_ENV];
  return typeof value === "string" && value.trim() === "1";
}

/**
 * @description Reports whether the given environment looks like a Claude Code
 * session: `CLAUDECODE` is set, or any `CLAUDE_CODE_*` variable is set, to a
 * non-empty value. Empty strings do not count — an unset-but-declared variable
 * is not a session.
 * @param {NodeJS.ProcessEnv} env - Environment to inspect (defaults to `process.env`).
 * @returns {boolean} True when a Claude Code session is detected.
 */
export function isClaudeCodeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env || typeof env !== "object") return false;
  if (hasValue(env[CLAUDE_SESSION_FLAG])) return true;
  var keys = Object.keys(env);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key.indexOf(CLAUDE_SESSION_PREFIX) === 0 && hasValue(env[key])) return true;
  }
  return false;
}

/**
 * @description True when an env value is a non-empty string.
 * @param {string|undefined} value - Raw env value.
 * @returns {boolean} Whether the value counts as "set".
 */
function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
