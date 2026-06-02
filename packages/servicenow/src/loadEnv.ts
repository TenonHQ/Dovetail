import dotenv from "dotenv";
import path from "path";

/**
 * Loads ServiceNow credentials for the `dove-sn` CLI and its MCP server.
 *
 * Resolution order for the env file:
 *   1. An explicit `--env <path>` / `--env-file <path>` flag (passed in here).
 *   2. The `DOVETAIL_ENV_FILE` environment variable — lets an MCP host point
 *      `dove-sn mcp` at a specific credential file without a CLI flag.
 *   3. The default `.env` in the current working directory.
 *
 * dotenv does not override variables already present in process.env, so an
 * explicit file augments (never clobbers) credentials the parent shell exported.
 *
 * @param {string} [explicitPath] - Path from the `--env` / `--env-file` flag.
 */
export function loadEnvFile(explicitPath?: string): void {
  var raw = explicitPath || process.env.DOVETAIL_ENV_FILE;
  if (raw) {
    var resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    dotenv.config({ path: resolved });
    return;
  }
  // No explicit selection — load .env from cwd if it exists (no-op otherwise).
  dotenv.config();
}
