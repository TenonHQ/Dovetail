/**
 * Claude Code session detection for human-only CLI surfaces.
 *
 * `dove watch` auto-syncs the working tree to the instance, and a git branch
 * switch mid-watch pushes the post-switch file state over live records. An
 * agent can't guarantee it stops the watcher before every branch operation, so
 * the command is hidden from `--help` and warns when it detects it is running
 * inside a Claude Code session. See TenonHQ/Dovetail#155.
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
 * @description Human-only warning printed when `dove watch` starts inside a
 * Claude Code session. Non-blocking by design (TenonHQ/Dovetail#155).
 */
export var WATCH_HUMAN_ONLY_WARNING =
  "⚠ `dove watch` is a human-only local-dev tool — it auto-syncs to the " +
  "instance and a branch switch mid-watch overwrites records. Don't run this " +
  "inside Claude Code. Use `npx dove push --diff <branch>` / `npx dove refresh` / " +
  "`npx dove status` instead. See TenonHQ/Dovetail#155.";

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
