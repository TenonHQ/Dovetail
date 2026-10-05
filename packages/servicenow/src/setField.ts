/**
 * dove-sn set-field — set scalar field value(s) on an EXISTING ServiceNow
 * record, captured into a specified update set, then read back and verify.
 *
 * Wraps the Dovetail core Scripted REST `pushWithUpdateSet` op (update-set +
 * scope switching handled atomically server-side), so the change lands in the
 * right update set without touching sys_user_preference. This is the
 * change-and-KEEP counterpart to sn-capture-fields' change-and-revert capture.
 *
 * NOT for schema tables (sys_db_object / sys_dictionary) — that's add-column /
 * create-table. To INSERT a new record, use `dove create`.
 */

import { createClient } from "./client";
import type { ServiceNowClient } from "./client";

export interface SetFieldParams {
  client?: ServiceNowClient;
  table: string;
  /** Target record by sys_id, OR by a query that resolves to EXACTLY one row. */
  sysId?: string;
  query?: string;
  /** Field name -> value to set. Values are sent as strings; ServiceNow coerces. */
  fields: Record<string, string>;
  /** Update set to capture the change into. Required for a tracked write. */
  updateSetSysId?: string;
  dryRun?: boolean;
}

/**
 * Fields common to every record-write verb's result: the target, the update set
 * the change was captured into, the requested field map, the read-back values,
 * whether the read-back matched, and a human note. `set-field` and
 * `create-record` each extend this with their own `status` union (and
 * set-field's `before` snapshot / create-record's owning `scope`).
 */
export interface RecordWriteResult {
  table: string;
  sysId: string;
  updateSetSysId: string;
  fields: Record<string, string>;
  after: Record<string, string>;
  verified: boolean;
  note: string;
}

export interface SetFieldResult extends RecordWriteResult {
  status: "dry-run" | "applied" | "failed";
  before: Record<string, string>;
}

// Platform/schema tables that must not be written as data — routed to the
// dedicated schema verbs instead so we never orphan or corrupt metadata.
var REFUSED_TABLES = ["sys_db_object", "sys_dictionary"];

/** Coerce a Table-API field value to a comparable string. Reference/display
 *  fields (sysparm_display_value=false) come back as { link, value } objects. */
export function fieldToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    if ("value" in value && value.value !== undefined && value.value !== null) {
      return String(value.value);
    }
    return "";
  }
  return String(value);
}

export function pickFields(row: Record<string, unknown>, names: Array<string>): Record<string, string> {
  var out: Record<string, string> = {};
  for (var i = 0; i < names.length; i += 1) {
    out[names[i]] = fieldToString(row ? row[names[i]] : undefined);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read-back comparison.
//
// ServiceNow's HTML sanitizer rewrites characters in html / translated_html /
// wiki fields on save (e.g. "@" → "&#64;"), so a byte-strict compare of the
// submitted value against the stored one reports a false mismatch on a record
// that is correct. Neither verb fetches the dictionary, so the field type is
// unknown here; the equivalence is therefore detected CONSERVATIVELY — it is
// accepted only when the STORED value carries at least one entity reference
// (the sanitizer's fingerprint) and both sides are identical once entities
// are decoded. Everything else keeps the strict byte compare, and a genuinely
// different html value still decodes to something different → mismatch.
// ---------------------------------------------------------------------------

var NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0"
};
var ENTITY_PATTERN = "&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});";
var ENTITY_TEST_RE = new RegExp(ENTITY_PATTERN);

/** True when the string contains at least one numeric or named HTML entity reference. */
export function hasHtmlEntity(value: string): boolean {
  if (typeof value !== "string" || value.indexOf("&") === -1) return false;
  return ENTITY_TEST_RE.test(value);
}

/**
 * Decode numeric (decimal / hex) and the basic named HTML entities. Unknown names
 * and out-of-range code points are left untouched so the decode can never invent
 * characters that were not there.
 */
export function decodeHtmlEntities(value: string): string {
  if (typeof value !== "string" || value.indexOf("&") === -1) return value;
  return value.replace(new RegExp(ENTITY_PATTERN, "g"), function (whole: string, body: string): string {
    if (body.charAt(0) === "#") {
      var hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      var code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return whole;
      }
      return String.fromCodePoint(code);
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
      return NAMED_ENTITIES[body];
    }
    return whole;
  });
}

export type ReadBackMatch = "exact" | "entity-equivalent" | "mismatch";

/** Compare one submitted value to its stored read-back. See the block comment above. */
export function readBackMatches(sent: unknown, stored: unknown): ReadBackMatch {
  var a = fieldToString(sent);
  var b = fieldToString(stored);
  if (a === b) return "exact";
  if (hasHtmlEntity(b) && decodeHtmlEntities(a) === decodeHtmlEntities(b)) {
    return "entity-equivalent";
  }
  return "mismatch";
}

export interface ReadBackVerification {
  /** True when every requested field matched (exactly or entity-equivalent). */
  verified: boolean;
  /** Fields whose stored value differs from the request. */
  mismatched: Array<string>;
  /** Fields that matched only after HTML-entity decoding (the sanitizer rewrote them). */
  entityNormalized: Array<string>;
}

/** Verify every requested field against the read-back map (as produced by pickFields). */
export function verifyReadBack(
  requested: Record<string, string>,
  after: Record<string, string>
): ReadBackVerification {
  var names = requested ? Object.keys(requested) : [];
  var result: ReadBackVerification = { verified: true, mismatched: [], entityNormalized: [] };
  for (var i = 0; i < names.length; i += 1) {
    var name = names[i];
    var match = readBackMatches(requested[name], after ? after[name] : undefined);
    if (match === "mismatch") {
      result.verified = false;
      result.mismatched.push(name);
    } else if (match === "entity-equivalent") {
      result.entityNormalized.push(name);
    }
  }
  return result;
}

/** Human-readable suffix naming the fields that verified only after entity decoding. */
export function readBackNote(check: ReadBackVerification): string {
  if (!check || check.entityNormalized.length === 0) return "";
  return " (" + check.entityNormalized.join(", ")
    + ": the instance HTML-entity-encoded the value on save; compared after decoding)";
}

export async function setField(params: SetFieldParams): Promise<SetFieldResult> {
  var client = params.client || createClient({});
  var table = params.table;
  if (!table) {
    throw new Error("set-field: --table is required.");
  }
  if (REFUSED_TABLES.indexOf(table) !== -1) {
    throw new Error(
      "set-field: refusing to write " + table + " as data — it is a schema table. "
        + "Use add-column / create-table for schema changes."
    );
  }
  var fieldNames = params.fields ? Object.keys(params.fields) : [];
  if (fieldNames.length === 0) {
    throw new Error("set-field: at least one field (--fields key=value) is required.");
  }
  if (!params.updateSetSysId) {
    throw new Error("set-field: --update-set <sys_id> is required so the change is captured.");
  }

  // Resolve the target sys_id (explicit, or a single-match query).
  var sysId = params.sysId;
  if (!sysId) {
    if (!params.query) {
      throw new Error("set-field: one of --sys-id or --query is required.");
    }
    var matches = await client.table.query(table, params.query, { limit: 2, fields: ["sys_id"] });
    if (matches.length === 0) {
      throw new Error("set-field: --query matched no rows on " + table + ".");
    }
    if (matches.length > 1) {
      throw new Error("set-field: --query matched 2+ rows on " + table + " — refine to exactly one.");
    }
    sysId = fieldToString(matches[0].sys_id);
  }

  // Read current values (also confirms the record exists).
  var readFields = ["sys_id"].concat(fieldNames);
  var beforeRows = await client.table.query(table, "sys_id=" + sysId, { limit: 1, fields: readFields });
  if (beforeRows.length === 0) {
    throw new Error("set-field: no record " + sysId + " found on " + table + ".");
  }
  var before = pickFields(beforeRows[0], fieldNames);

  if (params.dryRun) {
    return {
      status: "dry-run",
      table: table,
      sysId: sysId,
      updateSetSysId: params.updateSetSysId,
      fields: params.fields,
      before: before,
      after: before,
      verified: false,
      note: "dry-run: no write. Would set " + JSON.stringify(params.fields)
        + " on " + table + "/" + sysId + " into update set " + params.updateSetSysId + "."
    };
  }

  // Write via the update-set-aware core REST op.
  await client.claude.pushWithUpdateSet({
    update_set_sys_id: params.updateSetSysId,
    table: table,
    record_sys_id: sysId,
    fields: params.fields
  });

  // Read back and verify each field equals what we set.
  var afterRows = await client.table.query(table, "sys_id=" + sysId, { limit: 1, fields: readFields });
  var after = pickFields(afterRows[0] || {}, fieldNames);
  var check = verifyReadBack(params.fields, after);
  var verified = check.verified;

  return {
    status: verified ? "applied" : "failed",
    table: table,
    sysId: sysId,
    updateSetSysId: params.updateSetSysId,
    fields: params.fields,
    before: before,
    after: after,
    verified: verified,
    note: verified
      ? "Set " + fieldNames.join(", ") + " on " + table + "/" + sysId + " and verified via read-back."
        + readBackNote(check)
      : "Write landed but read-back does not match the requested values ("
        + check.mismatched.join(", ") + ") — check field types / ACLs."
  };
}
