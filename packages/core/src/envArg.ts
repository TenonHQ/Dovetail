import fs from "fs";
import path from "path";

/**
 * Per-invocation .env selection for the `dove` CLI.
 *
 * Every command accepts `--env <name|path>` (alias `-e`, also `--env-file` /
 * `--envFile`) so a single checkout can target multiple instances by pointing
 * at different credential files, e.g.:
 *
 *   npx dove push --env prod                 (bare name → <cwd>/.env.prod)
 *   npx dove push --env .env.prod            (explicit filename)
 *   npx dove status -e ../envs/workshop.env  (relative or absolute path)
 *
 * A bare instance name resolves exactly like `dove-sn --env <name>` and the
 * MCP tools' per-call `env` (see resolveEnvArgPath for the full rules).
 *
 * Unlike `dove-sn`, a missing file is NOT an error here: `dove login --env`
 * creates the file it is pointed at, so the selected path may not exist yet.
 *
 * The flag is parsed from raw argv before config/env load (see bootstrap.ts)
 * and also registered as a global yargs option so it appears in `--help`.
 */

// Flag spellings that select an env file. `-e` is the short alias.
var ENV_FLAGS = ["--env", "--env-file", "--envFile", "-e"];

// Prefix a bare instance name is expanded with (`prod` → `.env.prod`).
var BARE_NAME_PREFIX = ".env.";

/**
 * @description Extracts the env-file selector from a raw argv slice. Supports
 * both `--env <value>` and `--env=<value>` (and the `-e` / `--env-file`
 * spellings). Returns the last occurrence so a later flag overrides an earlier one.
 * @param {string[]} argv - Arguments after the node + script entries (process.argv.slice(2)).
 * @returns {string|undefined} The raw selector (bare name or path), or undefined when absent.
 */
export function parseEnvArg(argv: string[]): string | undefined {
  if (!Array.isArray(argv)) return undefined;
  var found: string | undefined;
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (typeof arg !== "string") continue;
    // `--env=path` / `-e=path`
    var eq = arg.match(/^(--env|--env-file|--envFile|-e)=(.*)$/);
    if (eq) {
      found = eq[2];
      continue;
    }
    // `--env path` / `-e path`
    if (ENV_FLAGS.indexOf(arg) !== -1) {
      var next = argv[i + 1];
      if (typeof next === "string" && next.charAt(0) !== "-") {
        found = next;
        i++;
      }
    }
  }
  if (found === undefined || found.trim() === "") return undefined;
  return found;
}

/**
 * @description Resolves a raw `--env` selector to an absolute env-file path.
 * Mirrors `dove-sn`'s resolveEnvSelection (packages/servicenow/src/loadEnv.ts):
 *   1. An absolute path, or any value containing a path separator, is a path;
 *      relative paths resolve against cwd (unchanged legacy behavior).
 *   2. A value that exists as a file in cwd (e.g. `my.env`) is that file.
 *   3. A value starting with `.` or containing a `.` (e.g. `.env.prod`,
 *      `workshop.env`) is an explicit filename in cwd, used as-is even when
 *      it does not exist yet — `dove login --env` may be about to create it.
 *   4. Anything else is a bare instance name: `prod` → `<cwd>/.env.prod`.
 * Does not check existence; a missing file keeps dove's historical behavior
 * (nothing is loaded from it).
 * @param {string} rawPath - The value returned by parseEnvArg.
 * @param {string} [cwd] - Base directory for relative paths and bare names (defaults to process.cwd()).
 * @returns {string} An absolute path to the requested .env file.
 * @throws {Error} When rawPath is not a non-empty string.
 */
export function resolveEnvArgPath(rawPath: string, cwd?: string): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error("--env must be a non-empty env-file name or path.");
  }
  var value = rawPath.trim();
  var base = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();

  if (path.isAbsolute(value) || /[\\/]/.test(value)) {
    return path.resolve(base, value);
  }

  var literal = path.resolve(base, value);
  if (isExistingFile(literal)) {
    return literal;
  }
  if (value.indexOf(".") !== -1) {
    return literal;
  }
  return path.resolve(base, BARE_NAME_PREFIX + value);
}

/**
 * @description True when the path exists and is a regular file. Never throws.
 * @param {string} candidate - Absolute path to test.
 * @returns {boolean}
 */
function isExistingFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch (e) {
    return false;
  }
}
