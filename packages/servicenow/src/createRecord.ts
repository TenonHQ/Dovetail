/**
 * dove-sn create-record — create ONE new record in a data table, captured
 * into a specified update set, then read back and verify.
 *
 * Wraps the Dovetail core Scripted REST `createRecord` op, which switches the
 * executing user's app scope and update set server-side, inserts, and
 * restores both — so the record is owned by the right app and the insert is
 * captured in the right update set without touching sys_user_preference.
 * The INSERT counterpart to `set-field`.
 *
 * NOT for schema tables (sys_db_object / sys_dictionary) — that's
 * create-table / add-column. To UPDATE an existing record, use `set-field`.
 */

import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import { fieldToString, pickFields } from "./setField";
import type { RecordWriteResult } from "./setField";

export interface CreateRecordParams {
  client?: ServiceNowClient;
  table: string;
  /** Field name -> value for the new record. Values are sent as strings; ServiceNow coerces. */
  fields: Record<string, string>;
  /** App scope that will own the record. Required — session-scope stamping is the #1 wrong-scope cause. */
  scope?: string;
  /** Update set to capture the insert into. Required for a tracked write. */
  updateSetSysId?: string;
  /** Encoded query; when it already matches a row the insert is skipped (idempotent re-runs). */
  ifAbsentQuery?: string;
  dryRun?: boolean;
}

export interface CreateRecordResult extends RecordWriteResult {
  status: "dry-run" | "created" | "skipped" | "failed";
  scope: string;
}

// Same guard as set-field: schema tables are never written as data — routed to
// the dedicated schema verbs instead so we never orphan or corrupt metadata.
var REFUSED_TABLES = ["sys_db_object", "sys_dictionary"];

export async function createRecord(params: CreateRecordParams): Promise<CreateRecordResult> {
  var client = params.client || createClient({});
  var table = params.table;
  if (!table) {
    throw new Error("create-record: --table is required.");
  }
  if (REFUSED_TABLES.indexOf(table) !== -1) {
    throw new Error(
      "create-record: refusing to write " + table + " as data — it is a schema table. "
        + "Use add-column / create-table for schema changes."
    );
  }
  var fieldNames = params.fields ? Object.keys(params.fields) : [];
  if (fieldNames.length === 0) {
    throw new Error("create-record: at least one field (--fields key=value) is required.");
  }
  if (!params.scope) {
    throw new Error("create-record: --scope is required so the record is owned by the right app.");
  }
  if (!params.updateSetSysId) {
    throw new Error("create-record: --update-set <sys_id> is required so the insert is captured.");
  }

  var readFields = ["sys_id"].concat(fieldNames);

  // Idempotent re-runs: skip the insert when the guard query already matches.
  if (params.ifAbsentQuery) {
    var existing = await client.table.query(table, params.ifAbsentQuery, {
      limit: 1,
      fields: readFields
    });
    if (existing.length > 0) {
      var existingSysId = fieldToString(existing[0].sys_id);
      var existingValues = pickFields(existing[0], fieldNames);
      var matches = true;
      for (var i = 0; i < fieldNames.length; i += 1) {
        if (existingValues[fieldNames[i]] !== fieldToString(params.fields[fieldNames[i]])) {
          matches = false;
        }
      }
      return {
        status: "skipped",
        table: table,
        sysId: existingSysId,
        scope: params.scope,
        updateSetSysId: params.updateSetSysId,
        fields: params.fields,
        after: existingValues,
        verified: matches,
        note: matches
          ? "skipped: --if-absent matched " + table + "/" + existingSysId
            + " and its values already match."
          : "skipped: --if-absent matched " + table + "/" + existingSysId
            + " but its values differ from the requested fields — use set-field to update it."
      };
    }
  }

  if (params.dryRun) {
    return {
      status: "dry-run",
      table: table,
      sysId: "",
      scope: params.scope,
      updateSetSysId: params.updateSetSysId,
      fields: params.fields,
      after: {},
      verified: false,
      note: "dry-run: no write. Would create a " + table + " record with "
        + JSON.stringify(params.fields) + " in scope " + params.scope
        + ", captured into update set " + params.updateSetSysId + "."
    };
  }

  // Insert via the scope- and update-set-aware core REST op.
  var created = await client.claude.createRecord({
    table: table,
    fields: params.fields,
    scope: params.scope,
    update_set_sys_id: params.updateSetSysId
  });
  var sysId = fieldToString(created && created.sys_id);
  if (!sysId) {
    return {
      status: "failed",
      table: table,
      sysId: "",
      scope: params.scope,
      updateSetSysId: params.updateSetSysId,
      fields: params.fields,
      after: {},
      verified: false,
      note: "createRecord returned no sys_id — the insert may not have landed; check the instance."
    };
  }

  // Read back and verify each field equals what we sent.
  var afterRows = await client.table.query(table, "sys_id=" + sysId, {
    limit: 1,
    fields: readFields
  });
  var after = pickFields(afterRows[0] || {}, fieldNames);
  var verified = afterRows.length > 0;
  for (var j = 0; j < fieldNames.length; j += 1) {
    if (after[fieldNames[j]] !== fieldToString(params.fields[fieldNames[j]])) {
      verified = false;
    }
  }

  return {
    status: verified ? "created" : "failed",
    table: table,
    sysId: sysId,
    scope: params.scope,
    updateSetSysId: params.updateSetSysId,
    fields: params.fields,
    after: after,
    verified: verified,
    note: verified
      ? "Created " + table + "/" + sysId + " and verified via read-back."
      : "Insert landed as " + sysId
        + " but read-back does not match the requested values — check field types / ACLs."
  };
}
