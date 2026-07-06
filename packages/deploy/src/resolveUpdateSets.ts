/**
 * Resolve the update set(s) for a ClickUp task on a source instance.
 *
 * Multi-set-per-task is the NORM (up to one complete sys_update_set per scope),
 * so a successful resolve returns an ORDERED ARRAY. "True" ambiguity is a
 * same-scope name collision only — never guess; surface the candidates.
 */

import type { PromotionLadder, ResolvedUpdateSet, SnReader } from "./types";

export type ResolveOutcome =
  | { kind: "ok"; updateSets: ResolvedUpdateSet[] }
  | { kind: "not-found" }
  | { kind: "ambiguous"; scope: string; candidates: ResolvedUpdateSet[] };

export interface ResolveUpdateSetsParams {
  reader: SnReader;
  taskId: string;
  config: PromotionLadder;
  /** sys_update_set state to match. Defaults to "complete". */
  state?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `name` begins with `taskId` at a word boundary — so "DEV-847"
 * matches "DEV-847 — Foo" and "DEV-847-foo" but NOT "DEV-8470 — Bar".
 */
export function nameMatchesTaskId(params: {
  name: string;
  taskId: string;
}): boolean {
  var re = new RegExp("^" + escapeRegExp(params.taskId) + "\\b");
  return re.test(params.name);
}

/** The encoded query used to fetch candidate update sets on the source. */
export function buildUpdateSetQuery(params: {
  taskId: string;
  state?: string;
}): string {
  var state = params.state || "complete";
  return "nameSTARTSWITH" + params.taskId + "^state=" + state;
}

/** Read a plain string field from a raw Table API row. */
function readString(row: Record<string, unknown>, key: string): string {
  var value = row[key];
  return typeof value === "string" ? value : "";
}

/** Read the scope sys_id from a sys_update_set row (`application` is a reference field). */
function readScope(row: Record<string, unknown>): string {
  var app = row.application;
  if (app !== null && typeof app === "object") {
    var value = (app as Record<string, unknown>).value;
    return typeof value === "string" ? value : "";
  }
  return typeof app === "string" ? app : "";
}

export async function resolveUpdateSets(
  params: ResolveUpdateSetsParams,
): Promise<ResolveOutcome> {
  var rows = await params.reader.query({
    table: "sys_update_set",
    query: buildUpdateSetQuery({ taskId: params.taskId, state: params.state }),
    fields: ["sys_id", "name", "application", "state"],
  });

  var matched: ResolvedUpdateSet[] = [];
  rows.forEach(function (row) {
    var name = readString(row, "name");
    if (!name || !nameMatchesTaskId({ name: name, taskId: params.taskId })) {
      return;
    }
    matched.push({
      sysId: readString(row, "sys_id"),
      name: name,
      scope: readScope(row),
    });
  });

  if (matched.length === 0) {
    return { kind: "not-found" };
  }

  // Group by scope; more than one set in the SAME scope is a real ambiguity.
  var byScope: Record<string, ResolvedUpdateSet[]> = {};
  matched.forEach(function (set) {
    if (!byScope[set.scope]) {
      byScope[set.scope] = [];
    }
    byScope[set.scope].push(set);
  });

  var scopes = Object.keys(byScope);
  var s;
  for (s = 0; s < scopes.length; s = s + 1) {
    var scope = scopes[s];
    if (byScope[scope].length > 1) {
      return { kind: "ambiguous", scope: scope, candidates: byScope[scope] };
    }
  }

  return { kind: "ok", updateSets: matched };
}
