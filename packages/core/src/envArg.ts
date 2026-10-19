import fs from "fs";
import os from "os";
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
 * How many parent directories a bare instance name's file is looked for in,
 * above the cwd. Mirrored in packages/servicenow/src/loadEnv.ts.
 */
export var ENV_WALK_UP_MAX_LEVELS = 8;

/** Options for the parent-directory lookup of a bare instance name. */
export interface EnvWalkUpOptions {
  /** Home directory to stop below (defaults to os.homedir()). Injectable for tests. */
  homeDir?: string;
  /** Called with the chosen path when the file was found in a parent directory. */
  onParentMatch?: (foundPath: string) => void;
  /**
   * Owner a parent match must have (defaults to process.getuid(); a negative
   * value, or a platform without getuid, skips the check). Injectable for tests.
   */
  ownerUid?: number;
}

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
 *      When that file does not exist, the parent directories are searched
 *      (findEnvFileUpward) and the nearest existing `.env.prod` wins, so a
 *      nested git worktree can use the per-instance file of the checkout it
 *      lives in. Nothing found → `<cwd>/.env.prod`, as before.
 * Only rule 4 walks up; paths and explicit filenames never do. Existence is
 * checked with stat only — no file is read here. A missing file keeps dove's
 * historical behavior (nothing is loaded from it).
 * @param {string} rawPath - The value returned by parseEnvArg.
 * @param {string} [cwd] - Base directory for relative paths and bare names (defaults to process.cwd()).
 * @param {EnvWalkUpOptions} [options] - Home-directory bound and a callback for a parent-directory match.
 * @returns {string} An absolute path to the requested .env file.
 * @throws {Error} When rawPath is not a non-empty string.
 */
export function resolveEnvArgPath(
  rawPath: string,
  cwd?: string,
  options?: EnvWalkUpOptions,
): string {
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
  var fileName = BARE_NAME_PREFIX + value;
  var inCwd = path.resolve(base, fileName);
  if (isExistingFile(inCwd)) {
    return inCwd;
  }
  var opts = options || {};
  var found = findEnvFileUpward({
    fileName: fileName,
    startDir: base,
    homeDir: opts.homeDir,
    ownerUid: opts.ownerUid,
  });
  if (found === null) {
    return inCwd;
  }
  if (typeof opts.onParentMatch === "function") {
    try {
      opts.onParentMatch(found);
    } catch (e) {
      // A logging callback must never change which file is selected.
    }
  }
  return found;
}

/**
 * @description Looks for `fileName` in the parent directories of `startDir`
 * (not in `startDir` itself) and returns the nearest one that exists as a
 * regular file owned by the current user. Bounds: at most `maxLevels` parents
 * (default ENV_WALK_UP_MAX_LEVELS); never the home directory or anything above
 * it; never the filesystem root. A file owned by someone else (e.g. planted in
 * a shared or world-writable ancestor such as /tmp when the cwd is outside the
 * home directory) is skipped, never selected. Uses stat only and never reads a
 * file. Never throws: bad input or no match returns null.
 * Keep behaviorally identical to findEnvFileUpward in
 * packages/servicenow/src/loadEnv.ts — packages/servicenow/tests/envWalkUpParity.test.ts
 * runs both.
 * @param {{fileName: string, startDir: string, homeDir?: string, maxLevels?: number, ownerUid?: number}} args
 * @returns {string|null} The absolute path of the nearest match, or null.
 */
export function findEnvFileUpward(args: {
  fileName: string;
  startDir: string;
  homeDir?: string;
  maxLevels?: number;
  ownerUid?: number;
}): string | null {
  if (
    !args ||
    typeof args.fileName !== "string" ||
    typeof args.startDir !== "string"
  ) {
    return null;
  }
  var fileName = args.fileName;
  if (
    fileName.length === 0 ||
    /[\\/]/.test(fileName) ||
    fileName === "." ||
    fileName === ".."
  ) {
    return null;
  }
  if (args.startDir.length === 0) {
    return null;
  }
  var maxLevels =
    typeof args.maxLevels === "number" &&
    isFinite(args.maxLevels) &&
    args.maxLevels >= 0
      ? Math.floor(args.maxLevels)
      : ENV_WALK_UP_MAX_LEVELS;
  var home = typeof args.homeDir === "string" ? args.homeDir : safeHomeDir();
  var homeResolved = home.length > 0 ? path.resolve(home) : "";
  var ownerUid =
    typeof args.ownerUid === "number" && isFinite(args.ownerUid)
      ? args.ownerUid
      : currentUid();

  var dir = path.resolve(args.startDir);
  for (var level = 0; level < maxLevels; level++) {
    var parent = path.dirname(dir);
    if (parent === dir) {
      break; // already at the root
    }
    dir = parent;
    if (path.dirname(dir) === dir) {
      break; // never the filesystem root
    }
    if (
      homeResolved.length > 0 &&
      isSameOrAncestor({ dir: dir, of: homeResolved })
    ) {
      break; // never the home directory or above it
    }
    var candidate = path.join(dir, fileName);
    if (isOwnedFile({ candidate: candidate, ownerUid: ownerUid })) {
      return candidate;
    }
  }
  return null;
}

/**
 * @description True when the path is a regular file owned by `ownerUid`
 * (any owner when `ownerUid` is negative). Stat only. Never throws.
 * @param {{candidate: string, ownerUid: number}} args
 * @returns {boolean}
 */
function isOwnedFile(args: { candidate: string; ownerUid: number }): boolean {
  try {
    var stat = fs.statSync(args.candidate);
    if (!stat.isFile()) {
      return false;
    }
    return args.ownerUid < 0 || stat.uid === args.ownerUid;
  } catch (e) {
    return false;
  }
}

/**
 * @description process.getuid(), or -1 where it does not exist (Windows),
 * which disables the ownership check. Never throws.
 * @returns {number}
 */
function currentUid(): number {
  try {
    return typeof process.getuid === "function" ? process.getuid() : -1;
  } catch (e) {
    return -1;
  }
}

/**
 * @description True when `dir` is `of` itself or one of its ancestors.
 * @param {{dir: string, of: string}} args - Both absolute.
 * @returns {boolean}
 */
function isSameOrAncestor(args: { dir: string; of: string }): boolean {
  var rel = path.relative(args.dir, args.of);
  if (rel === "") {
    return true;
  }
  return rel.indexOf("..") !== 0 && !path.isAbsolute(rel);
}

/**
 * @description os.homedir(), or "" when it cannot be determined. Never throws.
 * @returns {string}
 */
function safeHomeDir(): string {
  try {
    var home = os.homedir();
    return typeof home === "string" ? home : "";
  } catch (e) {
    return "";
  }
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
