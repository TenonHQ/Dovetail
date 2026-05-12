/**
 * Discover existing Flow Designer artifacts (Custom Action Types, Subflows) on
 * a ServiceNow instance so they can be cloned as templates by /sn-build-flow.
 *
 * Phase 1.B: instance-source only. A future enhancement may add a "local"
 * source that walks the Craftsman/ServiceNow scope subdirectories, but the
 * instance is the authoritative ground truth and avoids stale-fixture risk.
 */

import type { ServiceNowClient } from "../client";

export type FlowKind = "actionType" | "subflow";

export interface TemplateRef {
  sysId: string;
  name: string;
  /** SN's machine-stable name (action_type_definition.internal_name / sys_hub_flow.name). */
  internalName: string;
  kind: FlowKind;
  /** sys_scope sys_id reference. Resolve to a scope name via a sys_scope query if needed. */
  scopeSysId: string;
  category?: string | null;
  source: "instance";
}

export interface ListTemplatesParams {
  client: ServiceNowClient;
  /** "both" returns subflows AND custom action types in a single call. */
  kind: FlowKind | "both";
  /**
   * Filter by sys_scope sys_id (32-char). For convenience, callers may also
   * pass a scope name (e.g. "x_cadso_core") — listTemplates resolves it to a
   * sys_id via one extra sys_scope query.
   */
  scope?: string;
  /** Free-text contains-match on name (LIKE). */
  query?: string;
  /** Per-kind row cap. Defaults to 100. */
  limit?: number;
}

const RX_SYS_ID = /^[0-9a-f]{32}$/;

async function resolveScopeSysId(client: ServiceNowClient, raw: string): Promise<string> {
  if (RX_SYS_ID.test(raw)) return raw;
  // Treat as scope name and look it up. sys_scope.scope is the bare prefix
  // (e.g. "x_cadso_core"); sys_scope.name is the human label.
  var rows = await client.buildAgent.runQuery<{ sys_id: string; scope: string }>({
    table: "sys_scope",
    query: "scope=" + raw,
    limit: 1,
  });
  if (!rows.length) {
    throw new Error("listTemplates: scope name '" + raw + "' did not resolve to a sys_scope record.");
  }
  return rows[0].sys_id;
}

function buildLikeClause(field: string, query?: string): string {
  if (!query) return "";
  return "^" + field + "LIKE" + query;
}

async function fetchActionTypes(
  client: ServiceNowClient,
  scopeSysId: string | undefined,
  query: string | undefined,
  limit: number,
): Promise<Array<TemplateRef>> {
  var clauses: Array<string> = [];
  if (scopeSysId) clauses.push("sys_scope=" + scopeSysId);
  // Filter out the OOB ServiceNow action types if no scope filter was given —
  // they're rarely useful as templates and pollute results.
  if (!scopeSysId) clauses.push("sys_scope.scopeSTARTSWITHx_");
  var q = clauses.join("^") + buildLikeClause("name", query) + "^ORDERBYname";
  var rows = await client.buildAgent.runQuery<any>({
    table: "sys_hub_action_type_definition",
    query: q,
    limit: limit,
  });
  return rows.map(function (r: any): TemplateRef {
    return {
      sysId: r.sys_id,
      name: r.name || r.internal_name,
      internalName: r.internal_name || r.name,
      kind: "actionType",
      scopeSysId: typeof r.sys_scope === "string" ? r.sys_scope : (r.sys_scope && r.sys_scope.value) || "",
      category: r.category || null,
      source: "instance",
    };
  });
}

async function fetchSubflows(
  client: ServiceNowClient,
  scopeSysId: string | undefined,
  query: string | undefined,
  limit: number,
): Promise<Array<TemplateRef>> {
  // sys_hub_flow.type values: "flow", "subflow", "action". We want subflows only.
  var clauses: Array<string> = ["type=subflow"];
  if (scopeSysId) clauses.push("sys_scope=" + scopeSysId);
  if (!scopeSysId) clauses.push("sys_scope.scopeSTARTSWITHx_");
  var q = clauses.join("^") + buildLikeClause("name", query) + "^ORDERBYname";
  var rows = await client.buildAgent.runQuery<any>({
    table: "sys_hub_flow",
    query: q,
    limit: limit,
  });
  return rows.map(function (r: any): TemplateRef {
    return {
      sysId: r.sys_id,
      name: r.name,
      internalName: r.internal_name || r.name,
      kind: "subflow",
      scopeSysId: typeof r.sys_scope === "string" ? r.sys_scope : (r.sys_scope && r.sys_scope.value) || "",
      category: r.category || null,
      source: "instance",
    };
  });
}

export async function listTemplates(params: ListTemplatesParams): Promise<Array<TemplateRef>> {
  var lim = params.limit != null ? params.limit : 100;
  var scopeSysId: string | undefined;
  if (params.scope) scopeSysId = await resolveScopeSysId(params.client, params.scope);

  var out: Array<TemplateRef> = [];
  if (params.kind === "actionType" || params.kind === "both") {
    var ats = await fetchActionTypes(params.client, scopeSysId, params.query, lim);
    out = out.concat(ats);
  }
  if (params.kind === "subflow" || params.kind === "both") {
    var sfs = await fetchSubflows(params.client, scopeSysId, params.query, lim);
    out = out.concat(sfs);
  }
  return out;
}
