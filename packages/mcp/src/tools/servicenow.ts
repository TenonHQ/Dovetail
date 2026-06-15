/**
 * ServiceNow read-only MCP tool.
 *
 * Imports only createClient from @tenonhq/dovetail-servicenow and uses
 * exclusively client.table.query() — never client.claude.*, which is the
 * write surface. addChoicesToField is forbidden by ESLint.
 *
 * Tables on the deny list (sys_user_password, sys_credential, sys_audit, …)
 * are rejected unless the operator opts in via SINC_MCP_SN_TABLE_OVERRIDE.
 */

import path from "path";
import { createClient, createClientFromEnvFile } from "@tenonhq/dovetail-servicenow";
import type { ServiceNowClient } from "@tenonhq/dovetail-servicenow";
import type { ServiceNowSafetyConfig } from "../config";
import { ServicenowQueryTableInput } from "../schemas/servicenow";

export interface ServiceNowDeps {
  safety: ServiceNowSafetyConfig;
  clientFactory?: () => ServiceNowClient;
  /** Injectable for tests — defaults to the real createClientFromEnvFile. */
  clientFromEnvFile?: (envPath: string) => ServiceNowClient;
}

/**
 * Resolve the caller-supplied `env` token to an absolute env-file path inside
 * the server's working directory. The token is untrusted tool input, so this
 * is defense-in-depth on top of the schema regex: reject anything with a path
 * separator or traversal, accept only a `.env` basename (or a bare token that
 * maps to `.env.<token>`), and confirm the resolved path stays within cwd.
 */
export function resolveEnvFilePath(env: string): string {
  if (typeof env !== "string" || env.length === 0) {
    throw new Error("env must be a non-empty string.");
  }
  if (/[\\/]/.test(env) || env.indexOf("..") !== -1) {
    throw new Error(
      "env '" + env + "' is invalid — no path separators or '..'; " +
      "pass a name like 'prod' or '.env.prod'."
    );
  }
  var basename = env.indexOf(".env") === 0 ? env : ".env." + env;
  var cwd = process.cwd();
  var resolved = path.resolve(cwd, basename);
  // path.resolve collapses any residual traversal; verify containment.
  if (resolved !== path.join(cwd, basename) || path.dirname(resolved) !== cwd) {
    throw new Error("env '" + env + "' resolves outside the working directory.");
  }
  return resolved;
}

function resolveClient(deps: ServiceNowDeps, env?: string): ServiceNowClient {
  if (env) {
    var fromEnvFile = deps.clientFromEnvFile || createClientFromEnvFile;
    return fromEnvFile(resolveEnvFilePath(env));
  }
  if (deps.clientFactory) {
    return deps.clientFactory();
  }
  return createClient();
}

function isDenied(table: string, safety: ServiceNowSafetyConfig): boolean {
  if (safety.denyTables.indexOf(table) === -1) {
    return false;
  }
  return safety.overrideTables.indexOf(table) === -1;
}

export async function servicenowQueryTable(
  args: ServicenowQueryTableInput,
  deps: ServiceNowDeps
): Promise<{ table: string; count: number; records: any[] }> {
  if (isDenied(args.table, deps.safety)) {
    throw new Error(
      "Table '" + args.table + "' is in the default deny list. " +
      "Set SINC_MCP_SN_TABLE_OVERRIDE=" + args.table + " (comma-separated for multiple) to enable."
    );
  }
  var client = resolveClient(deps, args.env);
  var limit = args.limit !== undefined ? args.limit : 100;
  var records: any[];
  if (args.fields && args.fields.length > 0) {
    records = await client.table.query(args.table, args.sysparm_query, {
      limit: limit,
      fields: args.fields
    });
  } else {
    records = await client.table.query(args.table, args.sysparm_query, limit);
  }
  return { table: args.table, count: records.length, records: records };
}
