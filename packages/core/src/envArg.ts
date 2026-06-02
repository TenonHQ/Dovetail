import path from "path";

/**
 * Per-invocation .env selection for the `dove` CLI.
 *
 * Every command accepts `--env <path>` (alias `-e`, also `--env-file` /
 * `--envFile`) so a single checkout can target multiple instances by pointing
 * at different credential files, e.g.:
 *
 *   npx dove push --env .env.prod
 *   npx dove status -e ../envs/workshop.env
 *
 * The flag is parsed from raw argv before config/env load (see bootstrap.ts)
 * and also registered as a global yargs option so it appears in `--help`.
 */

// Flag spellings that select an env file. `-e` is the short alias.
var ENV_FLAGS = ["--env", "--env-file", "--envFile", "-e"];

/**
 * @description Extracts the env-file path from a raw argv slice. Supports both
 * `--env <path>` and `--env=<path>` (and the `-e` / `--env-file` spellings).
 * Returns the last occurrence so a later flag overrides an earlier one.
 * @param {string[]} argv - Arguments after the node + script entries (process.argv.slice(2)).
 * @returns {string|undefined} The raw path string, or undefined when absent.
 */
export function parseEnvArg(argv: string[]): string | undefined {
  var found: string | undefined;
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
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
  if (found === undefined || found === "") return undefined;
  return found;
}

/**
 * @description Resolves a raw env-file argument to an absolute path. Relative
 * paths resolve against the directory the command was run from (cwd), matching
 * where the user typed the path.
 * @param {string} rawPath - The value returned by parseEnvArg.
 * @param {string} [cwd] - Base directory for relative paths (defaults to process.cwd()).
 * @returns {string} An absolute path to the requested .env file.
 */
export function resolveEnvArgPath(rawPath: string, cwd?: string): string {
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(cwd || process.cwd(), rawPath);
}
