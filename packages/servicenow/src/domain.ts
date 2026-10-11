/**
 * Session-domain selection for the record-write verbs (set-field, create-record,
 * add-choices, remove-choices).
 *
 * On a domain-separated instance the API user's SESSION domain decides two things
 * for every write the Dovetail core ops perform:
 *   - INSERT — the new row's sys_domain (the platform stamps the session domain;
 *     a `sys_domain` in the payload does not override it);
 *   - UPDATE of a process record (sys_script, sys_choice, ...) that lives in a
 *     domain ABOVE the session's — the platform does not edit it in place. It
 *     creates a domain OVERRIDE: a new row in the session domain whose
 *     sys_overrides points at the original, which stays unchanged.
 *
 * Both failures are silent at the HTTP layer. The verbs therefore send the
 * requested domain to the server op (which switches the session domain around
 * the write and restores it) and verify the outcome on read-back: the record's
 * sys_domain, and that no new sys_overrides row appeared.
 *
 * Every read here passes `noDomain` (sysparm_query_no_domain=true) so a record
 * in another domain — or an override that hides the original — is still seen.
 */

import type { ServiceNowClient } from "./client";

/** The domain every write verb uses when the caller names none. */
export var DEFAULT_WRITE_DOMAIN = "global";

var SYS_ID_RE = /^[0-9a-f]{32}$/;

/** Fields read alongside a record to evaluate its domain state. */
export var DOMAIN_READ_FIELDS = ["sys_domain", "sys_overrides"];

/**
 * Normalise a caller-supplied domain: undefined / "" → "global"; "global" in any
 * case → "global"; a 32-hex sys_id (any case) → lower-case. Anything else throws —
 * a typo must never silently fall back to the default domain.
 */
export function normalizeDomain(input: unknown): string {
  if (input === undefined || input === null) return DEFAULT_WRITE_DOMAIN;
  if (typeof input !== "string") {
    throw new Error("domain must be a string (\"global\" or a 32-character domain sys_id).");
  }
  var value = input.trim();
  if (value === "") return DEFAULT_WRITE_DOMAIN;
  var lower = value.toLowerCase();
  if (lower === "global") return "global";
  if (SYS_ID_RE.test(lower)) return lower;
  throw new Error(
    "domain must be \"global\" or a 32-character domain sys_id (got \"" + value + "\")."
  );
}

/** A Table-API sys_domain value ({link,value} or plain string) as a comparable id. */
export function domainValue(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "object") {
    var inner = (raw as Record<string, unknown>).value;
    return inner === undefined || inner === null ? "" : String(inner).toLowerCase();
  }
  return String(raw).toLowerCase();
}

export interface DomainSnapshot {
  /** The row carries a sys_domain column (the Table API omits columns a table lacks). */
  domainAware: boolean;
  /** The row carries a sys_overrides column (a process table that supports overrides). */
  overridesSupported: boolean;
  /** Normalised sys_domain ("" when not domain-aware). */
  domain: string;
}

/** Read the domain columns off a Table-API row fetched with DOMAIN_READ_FIELDS. */
export function domainSnapshot(row: Record<string, unknown> | undefined | null): DomainSnapshot {
  var has = function (name: string): boolean {
    return Boolean(row) && Object.prototype.hasOwnProperty.call(row, name);
  };
  return {
    domainAware: has("sys_domain"),
    overridesSupported: has("sys_overrides"),
    domain: has("sys_domain") ? domainValue((row as Record<string, unknown>).sys_domain) : ""
  };
}

export interface OverrideRow {
  sysId: string;
  domain: string;
  overrides: string;
}

/**
 * Every row on `table` whose sys_overrides points at one of `sysIds`, across all
 * domains. Call only when the table supports sys_overrides (see domainSnapshot):
 * an encoded query on a column the table lacks is not safe on every instance.
 * Rows are re-filtered client-side, so an instance that ignored the filter can
 * never produce a false positive.
 */
export async function findOverrides(
  client: ServiceNowClient,
  table: string,
  sysIds: Array<string>
): Promise<Array<OverrideRow>> {
  var ids = (sysIds || []).filter(function (id) {
    return typeof id === "string" && SYS_ID_RE.test(id);
  });
  if (ids.length === 0) return [];
  var rows = await client.table.query(table, "sys_overridesIN" + ids.join(","), {
    limit: 200,
    fields: ["sys_id", "sys_domain", "sys_overrides"],
    noDomain: true
  });
  var out: Array<OverrideRow> = [];
  for (var i = 0; i < rows.length; i += 1) {
    var target = domainValue(rows[i].sys_overrides);
    if (ids.indexOf(target) === -1) continue;
    out.push({
      sysId: domainValue(rows[i].sys_id),
      domain: domainValue(rows[i].sys_domain),
      overrides: target
    });
  }
  return out;
}

/** Override rows in `after` that were not in `before` (by sys_id). */
export function newOverrides(before: Array<OverrideRow>, after: Array<OverrideRow>): Array<OverrideRow> {
  var seen: Record<string, boolean> = {};
  (before || []).forEach(function (r) {
    seen[r.sysId] = true;
  });
  return (after || []).filter(function (r) {
    return !seen[r.sysId];
  });
}

/** What the server op reported about the session-domain switch (absent on an op that predates it). */
export interface ServerDomainEcho {
  requested: string;
  applied: string | null;
  previous: string | null;
  skipped?: string;
}

/** Pull the `domain` acknowledgement out of a core-op response, or null when the op sent none. */
export function readServerDomainEcho(response: unknown): ServerDomainEcho | null {
  if (!response || typeof response !== "object") return null;
  var echo = (response as Record<string, unknown>).domain;
  if (!echo || typeof echo !== "object") return null;
  var e = echo as Record<string, unknown>;
  if (typeof e.requested !== "string") return null;
  return {
    requested: e.requested,
    applied: typeof e.applied === "string" ? e.applied : null,
    previous: typeof e.previous === "string" ? e.previous : null,
    skipped: typeof e.skipped === "string" ? e.skipped : undefined
  };
}

/** The domain half of a write verb's result. */
export interface DomainCheck {
  /** Session domain the write was asked to run in. */
  requested: string;
  /** The table has a sys_domain column (otherwise every domain check is skipped). */
  domainAware: boolean;
  /** sys_domain the record was expected to carry after the write ("" when not checked). */
  expected: string;
  /** sys_domain read back after the write ("" when not domain-aware / not written). */
  actual: string;
  /** Override rows the write created (the in-place update was diverted). */
  overridesCreated: Array<OverrideRow>;
  /** The server op acknowledged the domain request. False → the op predates domain selection. */
  serverAcknowledged: boolean;
  /** One line per domain failure; empty when the domain outcome verified. */
  problems: Array<string>;
}

/** Hint appended when the server op did not acknowledge `domain`. */
export function staleOpHint(op: string): string {
  return " The instance's Dovetail Core `" + op + "` op did not acknowledge the domain request — "
    + "it predates domain selection. Deploy servicenow/dovetail/sys_ws_operation/" + op
    + ".js from @tenonhq/dovetail (Dovetail Core def, global scope) and re-run.";
}

/** Human summary of the domain problems, with the stale-op hint when relevant. */
export function domainProblemNote(check: DomainCheck, op: string): string {
  if (!check || check.problems.length === 0) return "";
  return "DOMAIN CHECK FAILED: " + check.problems.join(" ")
    + (check.serverAcknowledged ? "" : staleOpHint(op));
}

/** Format an override list for a message. */
export function describeOverrides(rows: Array<OverrideRow>): string {
  return rows.map(function (r) {
    return r.sysId + " (sys_domain=" + (r.domain || "?") + ", overrides " + r.overrides + ")";
  }).join(", ");
}

/** Domain outcome of a multi-row write verb (add-choices / remove-choices). */
export interface MultiRowDomainCheck {
  /** Session domain the writes were asked to run in. */
  requested: string;
  /**
   * Every write's response acknowledged the domain request. False → at least one op
   * predates domain selection. True when nothing was written.
   */
  serverAcknowledged: boolean;
  /** Override rows the updates created (each one an update diverted away from its row). */
  overridesCreated: Array<OverrideRow>;
  /** One line per domain failure; empty when the domain outcome verified. */
  problems: Array<string>;
}

/** True when a Table-API row (fetched with all fields) shows the table supports overrides. */
export function rowSupportsOverrides(row: Record<string, unknown> | undefined | null): boolean {
  return domainSnapshot(row).overridesSupported;
}

/**
 * Verify the domain outcome of a batch of writes on one table:
 *   - every CREATED row is in the requested domain (when the table is domain-aware);
 *   - no UPDATED row gained a new override (compared with `overridesBefore`).
 * `overridesSupported` comes from a pre-write read of the same table.
 */
export async function auditWrittenRows(params: {
  client: ServiceNowClient;
  table: string;
  domain: string;
  createdIds: Array<string>;
  updatedIds: Array<string>;
  overridesSupported: boolean;
  overridesBefore: Array<OverrideRow>;
  serverAcknowledged: boolean;
}): Promise<MultiRowDomainCheck> {
  var check: MultiRowDomainCheck = {
    requested: params.domain,
    serverAcknowledged: params.serverAcknowledged,
    overridesCreated: [],
    problems: []
  };
  var created = (params.createdIds || []).filter(function (id) {
    return SYS_ID_RE.test(String(id));
  });
  if (created.length > 0) {
    var rows = await params.client.table.query(params.table, "sys_idIN" + created.join(","), {
      limit: created.length + 1,
      fields: ["sys_id", "sys_domain"],
      noDomain: true
    });
    var wrong: Array<string> = [];
    for (var i = 0; i < rows.length; i += 1) {
      var snap = domainSnapshot(rows[i]);
      if (snap.domainAware && snap.domain !== params.domain) {
        wrong.push(domainValue(rows[i].sys_id) + " (sys_domain=" + (snap.domain || "(empty)") + ")");
      }
    }
    if (wrong.length > 0) {
      check.problems.push(
        "Created " + params.table + " row(s) landed outside domain " + params.domain + ": "
          + wrong.join(", ") + ". Fix each with set-field --fields \"sys_domain=" + params.domain + "\"."
      );
    }
  }
  if (params.overridesSupported && params.updatedIds.length > 0) {
    var after = await findOverrides(params.client, params.table, params.updatedIds);
    check.overridesCreated = newOverrides(params.overridesBefore, after);
    if (check.overridesCreated.length > 0) {
      check.problems.push(
        "The platform created domain override row(s) " + describeOverrides(check.overridesCreated)
          + " instead of updating the existing " + params.table + " row(s) in place — the writes ran "
          + "in a session domain below the rows' domain. Delete the override(s) and their capture, "
          + "then re-run with --domain set to the rows' domain."
      );
    }
  }
  return check;
}

/** Human summary of a multi-row domain check's problems (with the stale-op hint). */
export function multiRowDomainNote(check: MultiRowDomainCheck, ops: string): string {
  if (!check || check.problems.length === 0) return "";
  return "DOMAIN CHECK FAILED: " + check.problems.join(" ")
    + (check.serverAcknowledged ? "" : staleOpHint(ops));
}
