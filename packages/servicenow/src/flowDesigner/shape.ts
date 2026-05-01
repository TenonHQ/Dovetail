/**
 * Field-shape utilities for flowDesigner clone/create operations.
 *
 * The Flow Designer tables (sys_hub_flow, sys_hub_action_type_definition,
 * sys_hub_action_input, etc.) carry SN-managed metadata fields that must NOT
 * be carried over when cloning — they are auto-populated server-side and
 * passing stale values causes update-set merge conflicts and audit-trail
 * lies. This module is the single source of truth for what to strip.
 */

import { randomBytes } from "crypto";

/**
 * SN-managed metadata fields stripped from any record before it is sent
 * through claude.createRecord. The exclusions cover audit (sys_created_*,
 * sys_updated_*, sys_mod_count), routing (sys_class_name, sys_domain*),
 * and miscellaneous server-side bookkeeping (sys_tags) that SN re-derives.
 *
 * sys_id is intentionally NOT in this list — clone callers pre-generate a
 * fresh sys_id and pass it explicitly so children can reference the new
 * parent's sys_id in their FK fields before the parent is even written.
 */
export const SYSTEM_FIELDS_TO_STRIP: ReadonlyArray<string> = [
  "sys_created_on",
  "sys_created_by",
  "sys_updated_on",
  "sys_updated_by",
  "sys_mod_count",
  "sys_tags",
  "sys_class_name",
  "sys_domain",
  "sys_domain_path",
];

/**
 * Return a shallow copy of `record` with SN-managed metadata fields removed.
 * Does not mutate the input.
 */
export function stripSystemFields<T extends Record<string, unknown>>(record: T): Partial<T> {
  var out: Record<string, unknown> = {};
  var keys = Object.keys(record);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (SYSTEM_FIELDS_TO_STRIP.indexOf(k) >= 0) continue;
    out[k] = record[k];
  }
  return out as Partial<T>;
}

/**
 * Generate a fresh ServiceNow-compatible sys_id (32 lowercase hex chars).
 * Uses Node's CSPRNG; collision risk against SN's 128-bit space is
 * negligible (<10^-30 within a single update set).
 */
export function generateSysId(): string {
  return randomBytes(16).toString("hex");
}

const RX_SYS_ID = /^[0-9a-f]{32}$/;

export function assertSysId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !RX_SYS_ID.test(value)) {
    throw new Error(name + " must be a 32-char ServiceNow sys_id (lowercase hex), got: " + JSON.stringify(value));
  }
}

/**
 * Apply a destination scope sys_id to a record before it is written.
 *
 * Both `sys_scope` (the structural scope FK on every custom-app record) and
 * `application` (the Flow Designer-specific scope FK on sys_hub_flow and
 * sys_hub_action_type_definition) are updated. Records that don't have an
 * `application` field are unchanged.
 */
export function applyScope<T extends Record<string, unknown>>(record: T, scopeSysId: string): T {
  assertSysId(scopeSysId, "scopeSysId");
  var out = Object.assign({}, record) as Record<string, unknown>;
  if ("sys_scope" in out) out.sys_scope = scopeSysId;
  if ("application" in out) out.application = scopeSysId;
  return out as T;
}
