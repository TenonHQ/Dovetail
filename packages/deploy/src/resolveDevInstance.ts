/**
 * Resolve + validate the developer's dev instance for a `sourceFrom: "devInstance"`
 * rung. The raw value comes from an untrusted ClickUp field, so it is guarded by a
 * host pattern and then checked against the TARGET's registered update sources —
 * the target can only pull from a source it has registered, so that list is the
 * authoritative allow-list. Nothing here trusts the raw value into a query.
 */

import type { SnReader } from "./types";

export interface ResolveDevInstanceParams {
  /** Raw value of the ClickUp `Dev Instance` field (untrusted). */
  raw: string | null | undefined;
  /** Regex the normalized subdomain must match (config.devInstanceHostPattern). */
  hostPattern: string;
  /** Reads `sys_update_set_source` on the TARGET instance (the promote destination). */
  targetReader: SnReader;
}

export type ResolveDevInstanceResult =
  | { ok: true; instance: string }
  | {
      ok: false;
      reason: "missing" | "invalid-format" | "unregistered";
      value?: string;
    };

/**
 * Reduce a URL or host to its bare ServiceNow subdomain: `https://foo.service-now.com/x` → `foo`.
 * Plain string ops (no regex) so an untrusted value can't drive a slow match.
 */
export function toSubdomain(raw: string): string {
  var s = raw.trim().toLowerCase();
  var scheme = s.indexOf("://");
  if (scheme !== -1) {
    s = s.slice(scheme + 3);
  }
  var slash = s.indexOf("/");
  if (slash !== -1) {
    s = s.slice(0, slash);
  }
  var dot = s.indexOf(".");
  if (dot !== -1) {
    s = s.slice(0, dot);
  }
  return s;
}

function readString(row: Record<string, unknown>, key: string): string {
  var value = row[key];
  return typeof value === "string" ? value : "";
}

export async function resolveDevInstance(
  params: ResolveDevInstanceParams,
): Promise<ResolveDevInstanceResult> {
  var raw = typeof params.raw === "string" ? params.raw.trim() : "";
  if (!raw) {
    return { ok: false, reason: "missing" };
  }

  var candidate = toSubdomain(raw);
  var pattern: RegExp;
  try {
    pattern = new RegExp(params.hostPattern);
  } catch (err) {
    // A bad hostPattern is a CONFIG error (validatePromotionLadder validates it
    // upstream), not a bad dev-instance value — fail loud rather than reporting it
    // as an input-format problem.
    throw new Error(
      "Invalid devInstanceHostPattern config: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!candidate || !pattern.test(candidate)) {
    return { ok: false, reason: "invalid-format", value: candidate };
  }

  // Allow-list = the target's ACTIVE registered update sources.
  var rows = await params.targetReader.query({
    table: "sys_update_set_source",
    query: "active=true",
    fields: ["name", "url", "active"],
  });
  var registered = rows.some(function (row) {
    return toSubdomain(readString(row, "url")) === candidate;
  });
  if (!registered) {
    return { ok: false, reason: "unregistered", value: candidate };
  }

  return { ok: true, instance: candidate };
}
