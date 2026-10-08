/**
 * dove-sn delete-record — delete ONE existing data record, with a read-back
 * BEFORE (so the dry-run shows exactly what would go, and a missing record is
 * an error rather than a no-op delete) and a read-back AFTER (success is never
 * reported until the record is confirmed gone). The DELETE counterpart to
 * `set-field` / `create-record`.
 *
 * Wraps the Dovetail core Scripted REST `deleteRecord` op. DRY-RUN BY DEFAULT:
 * without confirm:true nothing is deleted; dryRun:true forces a dry-run even
 * with confirm. updateSetSysId is REQUIRED and resolved up front (it must exist
 * and be in progress — checked on the dry-run too). Until TenonHQ/Dovetail#297
 * ships the server op ignores update_set_sys_id and captures into the session's
 * current update set, so the verb does what every other deleteRecord caller does:
 * it pins the set as current (changeUpdateSet) and reads the pin back, refusing
 * to delete when it did not take. After the delete it reads the DELETE row back
 * from sys_update_xml and reports where it actually landed (captured /
 * capturedInto) — the pin alone is not proof (#297 saw it not stick cross-scope).
 * The client keeps sending the field so it takes effect once the server honours it.
 *
 * NOT for schema tables (sys_db_object / sys_dictionary) — dropping a table or
 * column is a privileged lifecycle op, not a data delete.
 */

import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import { fieldToString } from "./setField";
import { encodeQueryValue } from "./choices";
import { readCurrentSet } from "./table/createIndex";

export interface DeleteRecordParams {
  client?: ServiceNowClient;
  table: string;
  /** sys_id of the record to delete — 32 lowercase hex characters. */
  sysId: string;
  /**
   * Update set the delete should be captured into. Required; must exist and be in progress.
   * Pinned as the session's current set before the delete (the server op ignores the field
   * until TenonHQ/Dovetail#297 ships) and verified via the sys_update_xml capture row.
   */
  updateSetSysId?: string;
  /** The delete gate: the record is only deleted when confirm is exactly true. */
  confirm?: boolean;
  /** Force a dry-run even when confirm is set. */
  dryRun?: boolean;
}

export interface DeleteRecordResult {
  status: "dry-run" | "deleted" | "failed";
  table: string;
  sysId: string;
  updateSetSysId: string;
  /** Snapshot of the record as read BEFORE the delete (long values truncated). */
  before: Record<string, string>;
  /** True only when the post-delete read-back confirmed the record is gone. */
  verified: boolean;
  /** Name of the requested update set, resolved before anything else is done. */
  updateSetName: string;
  /**
   * True only when the DELETE's sys_update_xml capture row was read back IN the requested
   * update set. A deleted record with captured:false will NOT travel with that set.
   */
  captured: boolean;
  /** The update set the DELETE capture row actually landed in; null when none was found. */
  capturedInto: { sysId: string; name: string } | null;
  note: string;
}

// Schema tables are never deleted as data — a dictionary/table drop is a
// privileged lifecycle op behind its own gate, never a generic record delete.
var REFUSED_TABLES = ["sys_db_object", "sys_dictionary"];

export var TABLE_NAME_PATTERN = /^[a-z0-9_]+$/;
export var SYS_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Longest field value echoed in the before-snapshot; scripts/XML are truncated. */
var SNAPSHOT_VALUE_MAX = 200;

/**
 * Appended to the dry-run and deleted notes while TenonHQ/Dovetail#297 is open: the server op
 * does not yet honour update_set_sys_id, so the delete is captured into the session's current
 * update set — which is why the verb pins it first and reads the capture row back. Revisit
 * (and its test) when #297 ships.
 */
export var UPDATE_SET_CAVEAT =
  " NOTE: the delete op itself ignores the update set until TenonHQ/Dovetail#297 ships and "
  + "captures into the session's current update set, so the requested set is pinned as current "
  + "first and the DELETE capture row is read back from sys_update_xml — captured:true only when "
  + "that row is in the requested set.";

/** States an update set can still capture changes in (raw and display forms). */
var CAPTURING_STATES = ["in progress", "in_progress"];

interface UpdateSetInfo {
  sysId: string;
  name: string;
}

function errText(err: unknown): string {
  var msg = err instanceof Error ? err.message : String(err);
  return msg || "unknown error";
}

/**
 * Resolve the requested update set: it must exist and be in progress, otherwise nothing a
 * delete captures could ever travel with it. Run on the dry-run too, so a typo'd or closed
 * set is caught before anyone confirms.
 */
async function resolveUpdateSet(client: ServiceNowClient, sysId: string): Promise<UpdateSetInfo> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_set",
    "sys_id=" + encodeQueryValue(sysId),
    { limit: 1, fields: ["sys_id", "name", "state"] }
  );
  var row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  // Re-check the sys_id: never trust a row that came back for a different set.
  if (!row || typeof row !== "object" || fieldToString(row.sys_id).toLowerCase() !== sysId.toLowerCase()) {
    throw new Error(
      "delete-record: update set " + sysId + " not found — verify the --update-set sys_id and your access."
    );
  }
  var name = fieldToString(row.name) || sysId;
  var state = fieldToString(row.state);
  if (state && CAPTURING_STATES.indexOf(state.toLowerCase()) === -1) {
    throw new Error(
      "delete-record: update set '" + name + "' (" + sysId + ") is in state '" + state
        + "' — only an 'in progress' update set can capture the delete."
    );
  }
  return { sysId: fieldToString(row.sys_id).toLowerCase(), name: name };
}

/**
 * Pin the requested set as the session's current update set and read it back. Returns ""
 * when the pin took, otherwise the reason it did not — a pin that did not take is a
 * wrong-set capture waiting to happen, so the caller refuses to delete.
 */
async function pinUpdateSet(client: ServiceNowClient, setInfo: UpdateSetInfo): Promise<string> {
  var current: unknown;
  try {
    await client.claude.changeUpdateSet({ sysId: setInfo.sysId });
    current = await client.claude.currentUpdateSet();
  } catch (err) {
    return "the update set could not be pinned as current: " + errText(err);
  }
  var readBack = readCurrentSet(current);
  var pinned = readBack.sysId
    ? readBack.sysId.toLowerCase() === setInfo.sysId
    : // The op may answer with the name only — then the name is the evidence.
      !!readBack.name && readBack.name === setInfo.name;
  if (pinned) return "";
  return "changeUpdateSet was called for '" + setInfo.name + "' (" + setInfo.sysId
    + ") but the current update set read back as '" + (readBack.name || readBack.sysId || "(none)")
    + "' — the delete would have been captured into the wrong set";
}

/**
 * Find where the DELETE was captured: the newest sys_update_xml row named
 * <table>_<sys_id> with action DELETE. Returns the set it sits in, or null when there is
 * none (the table may not be recorded in update sets at all). Errors propagate.
 */
async function readDeleteCapture(
  client: ServiceNowClient,
  table: string,
  sysId: string
): Promise<{ sysId: string } | null> {
  var expected = table + "_" + sysId;
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_xml",
    "name=" + encodeQueryValue(expected) + "^action=DELETE^ORDERBYDESCsys_updated_on",
    { limit: 5, fields: ["sys_id", "name", "action", "update_set", "sys_updated_on"] }
  );
  var safe = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < safe.length; i += 1) {
    var row = safe[i];
    if (!row || typeof row !== "object") continue;
    // Re-check both keys: an encoded-query term the instance does not understand is
    // silently dropped and would return an unfiltered set.
    if (fieldToString(row.name) !== expected) continue;
    if (fieldToString(row.action) !== "DELETE") continue;
    return { sysId: fieldToString(row.update_set).toLowerCase() };
  }
  return null;
}

/** Best-effort name for an update set the capture landed in; "" when it cannot be read. */
async function updateSetNameOf(client: ServiceNowClient, sysId: string): Promise<string> {
  if (!sysId) return "";
  try {
    var rows = await client.table.query<Record<string, unknown>>(
      "sys_update_set",
      "sys_id=" + encodeQueryValue(sysId),
      { limit: 1, fields: ["sys_id", "name"] }
    );
    var row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (!row || typeof row !== "object") return "";
    if (fieldToString(row.sys_id).toLowerCase() !== sysId) return "";
    return fieldToString(row.name);
  } catch (err) {
    return "";
  }
}

export function validateDeleteTable(table: unknown): string {
  if (typeof table !== "string" || table.length === 0) {
    throw new Error("delete-record: --table is required.");
  }
  if (!TABLE_NAME_PATTERN.test(table)) {
    throw new Error(
      "delete-record: --table must be a ServiceNow table name (lowercase letters, digits, "
        + "underscores) — got '" + table + "'."
    );
  }
  if (REFUSED_TABLES.indexOf(table) !== -1) {
    throw new Error(
      "delete-record: refusing to delete from " + table + " as data — it is a schema table. "
        + "Dropping a table or column is a privileged lifecycle op, not a record delete."
    );
  }
  return table;
}

export function validateDeleteSysId(sysId: unknown): string {
  if (typeof sysId !== "string" || sysId.length === 0) {
    throw new Error("delete-record: --sys-id is required.");
  }
  if (!SYS_ID_PATTERN.test(sysId)) {
    throw new Error(
      "delete-record: --sys-id must be a 32-character lowercase hex sys_id — got '" + sysId + "'."
    );
  }
  return sysId;
}

/** Flatten a Table-API row to printable strings, truncating long values. */
export function snapshotRecord(row: Record<string, unknown>): Record<string, string> {
  var out: Record<string, string> = {};
  if (!row || typeof row !== "object") return out;
  var names = Object.keys(row);
  for (var i = 0; i < names.length; i += 1) {
    var value = fieldToString(row[names[i]]);
    if (value.length > SNAPSHOT_VALUE_MAX) {
      value = value.substring(0, SNAPSHOT_VALUE_MAX) + "…[" + value.length + " chars]";
    }
    out[names[i]] = value;
  }
  return out;
}

/**
 * Read the record by sys_id. A Table-API query for a missing row returns an
 * empty result; a 404 (table missing / record-level ACL) is normalised to the
 * same "absent" answer so the caller has one shape to reason about. Any other
 * transport/auth error propagates.
 */
async function readRecord(
  client: ServiceNowClient,
  table: string,
  sysId: string,
  fields?: Array<string>
): Promise<Record<string, unknown> | null> {
  var rows: Array<Record<string, unknown>>;
  try {
    rows = await client.table.query<Record<string, unknown>>(table, "sys_id=" + sysId, {
      limit: 1,
      fields: fields
    });
  } catch (err) {
    var msg = err instanceof Error ? err.message : String(err);
    if (msg.indexOf("SN 404 on") === 0) return null;
    throw err;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  var row = rows[0];
  if (!row || typeof row !== "object") return null;
  // Belt and braces: the Table API honours sysparm_query, but never trust a
  // read that came back for a different sys_id.
  if (fieldToString(row.sys_id) !== sysId) return null;
  return row;
}

export async function deleteRecord(params: DeleteRecordParams): Promise<DeleteRecordResult> {
  var table = validateDeleteTable(params.table);
  var sysId = validateDeleteSysId(params.sysId);
  if (typeof params.updateSetSysId !== "string" || params.updateSetSysId.length === 0) {
    throw new Error(
      "delete-record: --update-set <sys_id> is required — it names the update set the delete "
        + "must be captured in (pinned as current, then verified via sys_update_xml)."
    );
  }
  var updateSetSysId = params.updateSetSysId;
  var client = params.client || createClient({});

  // Read BEFORE: the dry-run shows what would be deleted, and a missing record
  // is a clean error instead of a "successful" delete of nothing.
  var beforeRow = await readRecord(client, table, sysId);
  if (beforeRow === null) {
    throw new Error("delete-record: no record " + sysId + " found on " + table + " — nothing to delete.");
  }
  var before = snapshotRecord(beforeRow);

  // Resolve the update set on EVERY run (dry-run included): a typo'd or closed set is an
  // error before anyone confirms, never a delete captured somewhere it cannot travel from.
  var setInfo = await resolveUpdateSet(client, updateSetSysId);
  var base = {
    table: table,
    sysId: sysId,
    updateSetSysId: updateSetSysId,
    updateSetName: setInfo.name,
    before: before
  };

  var isDryRun = params.dryRun === true || params.confirm !== true;
  if (isDryRun) {
    return Object.assign({}, base, {
      status: "dry-run" as const,
      verified: false,
      captured: false,
      capturedInto: null,
      note: "dry-run: no delete. Would pin update set '" + setInfo.name + "' (" + setInfo.sysId
        + ") as current, delete " + table + "/" + sysId + ", then verify the record is gone and "
        + "the DELETE capture row is in that set."
        + " Re-run with confirm:true (CLI: --apply) to delete." + UPDATE_SET_CAVEAT
    });
  }

  // PIN THE UPDATE SET, as every other deleteRecord caller does — and refuse when the pin
  // did not take, before anything is deleted.
  var pinProblem = await pinUpdateSet(client, setInfo);
  if (pinProblem) {
    return Object.assign({}, base, {
      status: "failed" as const,
      verified: false,
      captured: false,
      capturedInto: null,
      note: "Nothing deleted — " + pinProblem + ". " + table + "/" + sysId + " is untouched."
    });
  }

  // The delete call's own outcome is NOT the verdict — the read-back is. A server
  // refusal (business rule abort → HTTP 500, retried then thrown) and a transport
  // error AFTER the delete landed both throw here; either way the record's actual
  // state decides the result, so the error is captured and the read-back always runs.
  var deleteError = "";
  try {
    await client.claude.deleteRecord({
      table: table,
      sys_id: sysId,
      update_set_sys_id: updateSetSysId
    });
  } catch (err) {
    deleteError = err instanceof Error ? err.message : String(err);
    if (!deleteError) deleteError = "unknown error";
  }

  // Read AFTER: success only when the record is confirmed gone. A read-back that
  // itself fails leaves the outcome unknown — that is a failure, never a success.
  var afterRow: Record<string, unknown> | null;
  try {
    afterRow = await readRecord(client, table, sysId, ["sys_id"]);
  } catch (readErr) {
    var readMsg = errText(readErr);
    return Object.assign({}, base, {
      status: "failed" as const,
      verified: false,
      captured: false,
      capturedInto: null,
      note: "The post-delete read-back of " + table + "/" + sysId + " FAILED (" + readMsg + ")"
        + (deleteError ? " and the deleteRecord call reported an error (" + deleteError + ")" : "")
        + " — whether the record is gone is UNKNOWN. Check the instance before retrying."
    });
  }
  var verified = afterRow === null;

  if (verified) {
    // CAPTURE READ-BACK: the pin is not proof — the DELETE row in sys_update_xml is.
    var captureNote: string;
    var capturedInto: { sysId: string; name: string } | null = null;
    var captured = false;
    try {
      var capture = await readDeleteCapture(client, table, sysId);
      if (capture === null) {
        captureNote = " NOT CAPTURED: no sys_update_xml DELETE row named " + table + "_" + sysId
          + " was found — the delete will NOT travel with '" + setInfo.name + "' (is " + table
          + " recorded in update sets at all?). Check before promoting.";
      } else if (capture.sysId === setInfo.sysId) {
        captured = true;
        capturedInto = { sysId: setInfo.sysId, name: setInfo.name };
        captureNote = " DELETE captured into update set '" + setInfo.name + "' (" + setInfo.sysId
          + "), read back from sys_update_xml.";
      } else {
        var otherName = await updateSetNameOf(client, capture.sysId);
        capturedInto = { sysId: capture.sysId, name: otherName };
        captureNote = " WRONG SET: the DELETE was captured into update set '"
          + (otherName || "(unknown name)") + "' (" + (capture.sysId || "none") + "), NOT the "
          + "requested '" + setInfo.name + "' (" + setInfo.sysId + ") — the requested set will "
          + "promote WITHOUT this delete. Move that sys_update_xml row before promoting.";
      }
    } catch (captureErr) {
      captureNote = " CAPTURE UNVERIFIED: the sys_update_xml read-back failed (" + errText(captureErr)
        + ") — check that the DELETE row is in '" + setInfo.name + "' before promoting.";
    }
    return Object.assign({}, base, {
      status: "deleted" as const,
      verified: true,
      captured: captured,
      capturedInto: capturedInto,
      note: "Deleted " + table + "/" + sysId + " and verified via read-back (record is gone)."
        + (deleteError
          ? " The deleteRecord call reported an error (" + deleteError + "), but the record is "
            + "gone — e.g. a transport error after the server had already deleted it."
          : "")
        + captureNote
        + UPDATE_SET_CAVEAT
    });
  }
  return Object.assign({}, base, {
    status: "failed" as const,
    verified: false,
    captured: false,
    capturedInto: null,
    note: deleteError
      ? "deleteRecord FAILED (" + deleteError + ") and " + table + "/" + sysId
        + " is STILL PRESENT on read-back — the server refused the delete (business rule abort / "
        + "server-side refusal?). Check the instance before retrying."
      : "deleteRecord returned but " + table + "/" + sysId
        + " is STILL PRESENT on read-back — the delete did not land (ACL / business rule abort?). "
        + "Check the instance before retrying."
  });
}
