import dotenv from "dotenv";
import path from "path";

/**
 * Loads integration credentials for the dovetail-mcp stdio server.
 *
 * MCP hosts normally inject env vars through the server's launch config, but a
 * `--env <path>` argument (or the `DOVETAIL_ENV_FILE` env var) lets a host point
 * the server at a specific credential file instead — so one machine can run the
 * server against multiple instances by varying the file.
 *
 * Resolution order: `--env`/`--env-file` argv flag → DOVETAIL_ENV_FILE → cwd .env.
 * dotenv never overrides variables already present in process.env, so a host's
 * injected env always wins over the file.
 */
function parseEnvFlag(argv: string[]): string | undefined {
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    var eq = arg.match(/^(--env|--env-file|--envFile)=(.*)$/);
    if (eq && eq[2]) return eq[2];
    if (arg === "--env" || arg === "--env-file" || arg === "--envFile") {
      var next = argv[i + 1];
      if (typeof next === "string" && next.charAt(0) !== "-") return next;
    }
  }
  return undefined;
}

export function loadEnvFile(argv?: string[]): void {
  var raw = parseEnvFlag(argv || process.argv.slice(2)) || process.env.DOVETAIL_ENV_FILE;
  if (raw) {
    var resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    dotenv.config({ path: resolved });
    return;
  }
  dotenv.config();
}
