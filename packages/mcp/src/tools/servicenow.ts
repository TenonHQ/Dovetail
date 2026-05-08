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

import { createClient } from "@tenonhq/dovetail-servicenow";
import type { ServiceNowClient } from "@tenonhq/dovetail-servicenow";
import type { ServiceNowSafetyConfig } from "../config";
import { ServicenowQueryTableInput } from "../schemas/servicenow";

export interface ServiceNowDeps {
  safety: ServiceNowSafetyConfig;
  clientFactory?: () => ServiceNowClient;
}

function resolveClient(deps: ServiceNowDeps): ServiceNowClient {
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
  var client = resolveClient(deps);
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
