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

export interface SetFieldResult {
  status: "dry-run" | "applied" | "failed";
  table: string;
  sysId: string;
  updateSetSysId: string;
  fields: Record<string, string>;
  before: Record<string, string>;
  after: Record<string, string>;
  verified: boolean;
  note: string;
}

// Platform/schema tables that must not be written as data — routed to the
// dedicated schema verbs instead so we never orphan or corrupt metadata.
var REFUSED_TABLES = ["sys_db_object", "sys_dictionary"];

/** Coerce a Table-API field value to a comparable string. Reference/display
 *  fields (sysparm_display_value=false) come back as { link, value } objects. */
function fieldToString(value: any): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    return value.value !== undefined && value.value !== null ? String(value.value) : "";
  }
  return String(value);
}

function pickFields(row: Record<string, any>, names: Array<string>): Record<string, string> {
  var out: Record<string, string> = {};
  for (var i = 0; i < names.length; i += 1) {
    out[names[i]] = fieldToString(row ? row[names[i]] : undefined);
  }
  return out;
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
  var verified = true;
  for (var j = 0; j < fieldNames.length; j += 1) {
    if (after[fieldNames[j]] !== fieldToString(params.fields[fieldNames[j]])) {
      verified = false;
    }
  }

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
      : "Write landed but read-back does not match the requested values — check field types / ACLs."
  };
}
