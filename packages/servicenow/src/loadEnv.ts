import fs from "fs";
import dotenv from "dotenv";
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
 *
 * Returns the resolved path; does not check existence (loadEnvFile does).
 */
export function resolveEnvSelection(raw: string, cwd?: string): string {
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
  return path.resolve(base, ".env." + value);
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
  var resolved = resolveEnvSelection(raw);
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
