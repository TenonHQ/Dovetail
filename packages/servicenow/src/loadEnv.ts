import fs from "fs";
import dotenv from "dotenv";
import os from "os";
import path from "path";
import { resolveConfigFromEnvFile } from "./createClientFromEnvFile";

/**
 * ServiceNow connection variables. When an env file is selected explicitly,
 * these are taken from the file ONLY — any value already in process.env is
 * cleared first — so the selected file fully determines the target instance
 * and auth mode. (Without this, a shell/session-exported SN_INSTANCE or
 * SN_API_KEY silently won over the file and the command hit the wrong
 * instance.)
 */
export var SN_CONNECTION_KEYS = [
  "SN_INSTANCE",
  "SN_DEV_INSTANCE",
  "SN_PROD_INSTANCE",
  "SN_API_KEY",
  "SN_DEV_API_KEY",
  "SN_PROD_API_KEY",
  "SN_USER",
  "SN_PASSWORD",
  "SN_DEV_USERNAME",
  "SN_DEV_PASSWORD",
  "SN_PROD_USERNAME",
  "SN_PROD_PASSWORD",
  // Dedicated Flow Designer (processflow) identity — see ServiceNowClientConfig.flowUser.
  "SN_FLOW_USER",
  "SN_FLOW_PASSWORD",
  "SN_DEV_FLOW_USER",
  "SN_DEV_FLOW_PASSWORD",
  "SN_PROD_FLOW_USER",
  "SN_PROD_FLOW_PASSWORD",
];

/**
 * Resolve an `--env` selector to an absolute env-file path.
 *
 * Accepts, in order:
 *   - an absolute path, or any value containing a path separator → used as a path
 *     (relative paths resolve against cwd) — unchanged legacy behavior;
 *   - a bare name that exists as a file in cwd (e.g. `--env my.env`) → that file;
 *   - a bare name like `loft` → `<cwd>/.env.loft`, matching the MCP tool's
 *     per-call `env` resolution; a `.env`-prefixed basename is used as-is.
 *     When `<cwd>/.env.loft` does not exist, the parent directories are
 *     searched (findEnvFileUpward) and the nearest existing `.env.loft` wins,
 *     so a nested git worktree can use the per-instance file of the checkout
 *     it lives in. Nothing found → `<cwd>/.env.loft`, as before. Same rule as
 *     `dove`'s resolveEnvArgPath (packages/core/src/envArg.ts).
 *
 * Only the bare-name case walks up. Existence is checked with stat only — no
 * file is read here. Returns the resolved path; loadEnvFile checks existence.
 */
export function resolveEnvSelection(raw: string, cwd?: string, options?: EnvWalkUpOptions): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("--env must be a non-empty env-file name or path.");
  }
  var value = raw.trim();
  var base = cwd || process.cwd();
  if (path.isAbsolute(value) || /[\\/]/.test(value)) {
    return path.resolve(base, value);
  }
  var literal = path.resolve(base, value);
  if (fs.existsSync(literal)) {
    return literal;
  }
  if (value.indexOf(".env") === 0) {
    return literal;
  }
  var fileName = BARE_NAME_PREFIX + value;
  var inCwd = path.resolve(base, fileName);
  if (isExistingFile(inCwd)) {
    return inCwd;
  }
  // A dotted value (`loft.env`) is not a bare instance name: keep the
  // legacy `<cwd>/.env.<value>` result and never walk up for it.
  if (value.indexOf(".") !== -1) {
    return inCwd;
  }
  var opts = options || {};
  var found = findEnvFileUpward({ fileName: fileName, startDir: base, homeDir: opts.homeDir });
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

// Prefix a bare instance name is expanded with (`loft` → `.env.loft`).
var BARE_NAME_PREFIX = ".env.";

/**
 * How many parent directories a bare instance name's file is looked for in,
 * above the cwd. Mirrored in packages/core/src/envArg.ts.
 */
export var ENV_WALK_UP_MAX_LEVELS = 8;

/** Options for the parent-directory lookup of a bare instance name. */
export interface EnvWalkUpOptions {
  /** Home directory to stop below (defaults to os.homedir()). Injectable for tests. */
  homeDir?: string;
  /** Called with the chosen path when the file was found in a parent directory. */
  onParentMatch?: (foundPath: string) => void;
}

/**
 * Look for `fileName` in the parent directories of `startDir` (not in
 * `startDir` itself) and return the nearest one that exists as a regular file.
 * Bounds: at most `maxLevels` parents (default ENV_WALK_UP_MAX_LEVELS); never
 * the home directory or anything above it; never the filesystem root. Uses
 * stat only and never reads a file. Never throws: bad input or no match
 * returns null.
 *
 * Keep behaviorally identical to findEnvFileUpward in
 * packages/core/src/envArg.ts — tests/envWalkUpParity.test.ts runs both.
 */
export function findEnvFileUpward(args: {
  fileName: string;
  startDir: string;
  homeDir?: string;
  maxLevels?: number;
}): string | null {
  if (!args || typeof args.fileName !== "string" || typeof args.startDir !== "string") {
    return null;
  }
  var fileName = args.fileName;
  if (fileName.length === 0 || /[\\/]/.test(fileName) || fileName === "." || fileName === "..") {
    return null;
  }
  if (args.startDir.length === 0) {
    return null;
  }
  var maxLevels =
    typeof args.maxLevels === "number" && isFinite(args.maxLevels) && args.maxLevels >= 0
      ? Math.floor(args.maxLevels)
      : ENV_WALK_UP_MAX_LEVELS;
  var home = typeof args.homeDir === "string" ? args.homeDir : safeHomeDir();
  var homeResolved = home.length > 0 ? path.resolve(home) : "";

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
    if (homeResolved.length > 0 && isSameOrAncestor({ dir: dir, of: homeResolved })) {
      break; // never the home directory or above it
    }
    var candidate = path.join(dir, fileName);
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

// True when `dir` is `of` itself or one of its ancestors. Both absolute.
function isSameOrAncestor(args: { dir: string; of: string }): boolean {
  var rel = path.relative(args.dir, args.of);
  if (rel === "") {
    return true;
  }
  return rel.indexOf("..") !== 0 && !path.isAbsolute(rel);
}

// True when the path exists and is a regular file. Never throws.
function isExistingFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch (e) {
    return false;
  }
}

// os.homedir(), or "" when it cannot be determined. Never throws.
function safeHomeDir(): string {
  try {
    var home = os.homedir();
    return typeof home === "string" ? home : "";
  } catch (e) {
    return "";
  }
}

/**
 * Loads ServiceNow credentials for the `dove-sn` CLI and its MCP server.
 *
 * Resolution order for the env file:
 *   1. An explicit `--env <name|path>` / `--env-file <name|path>` flag.
 *   2. The `DOVETAIL_ENV_FILE` environment variable.
 *   3. The default `.env` in the current working directory.
 *
 * For an explicit selection (1 or 2) this FAILS CLOSED: a missing file, or a
 * file that doesn't define an instance plus credentials, throws instead of
 * silently falling back to whatever instance the surrounding environment
 * points at. The file's ServiceNow connection variables (SN_CONNECTION_KEYS)
 * replace any already in process.env; every other variable keeps dotenv's
 * never-override semantics.
 *
 * The default cwd `.env` (3) keeps its historical behavior: optional, and
 * never overrides already-exported variables.
 *
 * @param {string} [explicitSelection] - Value of the `--env` / `--env-file` flag.
 * @returns {string|undefined} The absolute path of the explicitly selected
 *   file, or undefined when the default `.env` path was used.
 */
export function loadEnvFile(explicitSelection?: string): string | undefined {
  var raw = explicitSelection || process.env.DOVETAIL_ENV_FILE;
  if (!raw) {
    // No explicit selection — load .env from cwd if it exists (no-op otherwise).
    dotenv.config();
    return undefined;
  }
  var resolved = resolveEnvSelection(raw, undefined, {
    onParentMatch: function (foundPath) {
      // stderr, never stdout (stdout carries --json output and the MCP protocol).
      // The path only — never anything from the file.
      process.stderr.write(
        "dove-sn: --env " + raw + ": using " + foundPath + " (found in a parent directory)\n"
      );
    },
  });
  if (!fs.existsSync(resolved)) {
    throw new Error(
      "env file not found: '" + resolved + "' (from --env '" + raw + "'). " +
      "Refusing to fall back to the default environment — pass an existing env-file " +
      "name (e.g. 'prod' → .env.prod in the current directory) or path."
    );
  }
  // Validates instance + credentials and throws loudly if either is missing.
  resolveConfigFromEnvFile(resolved);

  var parsed = dotenv.parse(fs.readFileSync(resolved, "utf8"));
  SN_CONNECTION_KEYS.forEach(function (key) {
    delete process.env[key];
    if (Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key] !== "") {
      process.env[key] = parsed[key];
    }
  });
  // Everything else in the file: dotenv's normal never-override semantics.
  dotenv.config({ path: resolved });
  return resolved;
}
