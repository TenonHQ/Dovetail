/**
 * dove-sn delete-record — delete ONE existing data record, pinned to a
 * specified update set, with a read-back BEFORE (so the dry-run shows exactly
 * what would go, and a missing record is an error rather than a no-op delete)
 * and a read-back AFTER (success is never reported until the record is
 * confirmed gone). The DELETE counterpart to `set-field` / `create-record`.
 *
 * Wraps the Dovetail core Scripted REST `deleteRecord` op. DRY-RUN BY DEFAULT:
 * without confirm:true nothing is deleted; dryRun:true forces a dry-run even
 * with confirm. updateSetSysId is REQUIRED so a delete is never routed to the
 * session's default update set silently (TenonHQ/Dovetail#297). NOTE: until
 * #297 ships server-side the op ignores update_set_sys_id and captures into
 * the session current-app set — the client still sends it so callers are
 * ready the moment the server honours it.
 *
 * NOT for schema tables (sys_db_object / sys_dictionary) — dropping a table or
 * column is a privileged lifecycle op, not a data delete.
 */

import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import { fieldToString } from "./setField";

export interface DeleteRecordParams {
  client?: ServiceNowClient;
  table: string;
  /** sys_id of the record to delete — 32 lowercase hex characters. */
  sysId: string;
  /** Update set to capture the delete into. Required — never routed to the session default. */
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
  note: string;
}

// Schema tables are never deleted as data — a dictionary/table drop is a
// privileged lifecycle op behind its own gate, never a generic record delete.
var REFUSED_TABLES = ["sys_db_object", "sys_dictionary"];

export var TABLE_NAME_PATTERN = /^[a-z0-9_]+$/;
export var SYS_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Longest field value echoed in the before-snapshot; scripts/XML are truncated. */
var SNAPSHOT_VALUE_MAX = 200;

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
      "delete-record: --update-set <sys_id> is required so the delete is captured into a known "
        + "update set, never the session default."
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

  var isDryRun = params.dryRun === true || params.confirm !== true;
  if (isDryRun) {
    return {
      status: "dry-run",
      table: table,
      sysId: sysId,
      updateSetSysId: updateSetSysId,
      before: before,
      verified: false,
      note: "dry-run: no delete. Would delete " + table + "/" + sysId
        + " and capture it into update set " + updateSetSysId
        + ". Re-run with confirm:true (CLI: --apply) to delete."
    };
  }

  await client.claude.deleteRecord({
    table: table,
    sys_id: sysId,
    update_set_sys_id: updateSetSysId
  });

  // Read AFTER: success only when the record is confirmed gone.
  var afterRow = await readRecord(client, table, sysId, ["sys_id"]);
  var verified = afterRow === null;

  return {
    status: verified ? "deleted" : "failed",
    table: table,
    sysId: sysId,
    updateSetSysId: updateSetSysId,
    before: before,
    verified: verified,
    note: verified
      ? "Deleted " + table + "/" + sysId + " and verified via read-back (record is gone)."
      : "deleteRecord returned but " + table + "/" + sysId
        + " is STILL PRESENT on read-back — the delete did not land (ACL / business rule abort?). "
        + "Check the instance before retrying."
  };
}
