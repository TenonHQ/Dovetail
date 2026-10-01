/**
 * dove-sn set-table — update the dictionary attributes of an EXISTING ServiceNow
 * TABLE, captured into a named update set, then read back and verified against the
 * instance.
 *
 * WHY THIS IS NOT set-column. Every table carries one sys_dictionary row that
 * describes the TABLE rather than any column: `internal_type=collection`, with
 * `element` empty. Table-wide settings live there. `set-column` targets
 * `name=<table>^element=<column>` and its whole apparatus — inheritance walking,
 * the max_length ALTER, the shrink guard — is column-shaped; none of it applies to
 * a collection row. And `set-field` is a DATA verb that refuses sys_dictionary
 * outright. So the collection row had no owner. This is it.
 *
 * The split that settled in practice, extended one step:
 *   "field"  = a record's value          -> set-field
 *   "column" = a table's column schema   -> set-column
 *   "table"  = the table's own schema    -> set-table  (this verb)
 *
 * AUDIT IS A TABLE-LEVEL FLAG. `sys_dictionary.audit` on the collection row is what
 * turns record auditing on for a table: with it true, ServiceNow writes a sys_audit
 * row per changed field on every insert and update. That is a genuine cost on a
 * high-write table, so this verb reports the before -> after honestly and never
 * writes a value over itself.
 *
 * THE ALLOWLIST IS DELIBERATELY SMALL. An unbounded write to sys_dictionary lets a
 * caller silently corrupt schema, so — exactly as set-column does — only named
 * attributes are settable and everything else is refused by name. Widen WRITABLE
 * only for an attribute whose behaviour on a collection row has been verified live.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";
import { encodeQueryValue } from "../choices";
import type { AttributeChange } from "./setColumn";
import { toStoredValue } from "./setColumn";

/** The table-level dictionary attributes set-table will write, keyed by the friendly
 *  name a caller uses. Everything absent from this map is refused. */
var WRITABLE: Record<string, string> = {
  audit: "audit",
};

/**
 * Attributes that belong to a COLUMN, not the table. Refused by name so that asking
 * for one earns a redirect to set-column instead of a confusing "not settable".
 */
var COLUMN_ATTRIBUTES = [
  "label",
  "mandatory",
  "default",
  "readOnly",
  "maxLength",
  "internalType",
  "element",
];

export interface TableAttributes {
  /**
   * Record auditing for the whole table (sys_dictionary.audit on the collection
   * row). True makes ServiceNow write a sys_audit row per changed field on every
   * insert and update.
   */
  audit?: boolean;
}

export interface SetTableParams {
  client: ServiceNowClient;
  /** The table, by name (e.g. "x_cadso_core_setting"). */
  table: string;
  /** The attributes to set. At least one is required. */
  attributes: TableAttributes;
  /** Update set to capture the change into. REQUIRED on the live path. */
  updateSetSysId?: string;
  /** Plan only — resolves and diffs, writes nothing. */
  dryRun?: boolean;
}

export interface SetTableResult {
  status: "dry-run" | "applied" | "unchanged" | "failed";
  table: string;
  /** sys_id of the table's collection sys_dictionary row. */
  tableSysId: string;
  updateSetSysId: string;
  /** The attributes that differed and were written (empty when nothing changed). */
  changes: Array<AttributeChange>;
  /** True only when every requested value was READ BACK from the instance and matched. */
  verified: boolean;
  /** True when the sys_update_xml row for this table was found in the named update
   *  set. A write that lands but is not captured cannot be promoted — it dies on this
   *  instance, so a 200 alone is not success. */
  capturedInUpdateSet: boolean;
  note: string;
}

/**
 * Translate the caller's friendly attributes into the sys_dictionary columns to
 * write. Throws on anything not on the allowlist, and redirects column attributes
 * to set-column by name rather than reporting them as merely unknown.
 */
export function resolveTableAttributes(
  attributes: TableAttributes,
): Record<string, string> {
  if (!attributes || typeof attributes !== "object") {
    throw new Error("set-table: attributes object is required.");
  }
  var out: Record<string, string> = {};
  var keys = Object.keys(attributes);
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    var value = (attributes as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (COLUMN_ATTRIBUTES.indexOf(key) !== -1) {
      throw new Error(
        "set-table: '" +
          key +
          "' is a COLUMN attribute, not a table one — it lives on a column's " +
          "dictionary row, not the table's collection row. Use set-column.",
      );
    }
    var target = WRITABLE[key];
    if (!target) {
      throw new Error(
        "set-table: '" +
          key +
          "' is not a settable table attribute. Settable: " +
          Object.keys(WRITABLE).join(", ") +
          ".",
      );
    }
    out[target] = toStoredValue(value as string | number | boolean);
  }
  if (Object.keys(out).length === 0) {
    throw new Error("set-table: at least one attribute is required.");
  }
  return out;
}

/**
 * Fetch the table's collection dictionary row — `element` empty, which is what
 * distinguishes the table's own row from every column row sharing its `name`.
 */
async function fetchCollectionRow(
  client: ServiceNowClient,
  table: string,
  fields: Array<string>,
): Promise<Record<string, unknown>> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_dictionary",
    "name=" + encodeQueryValue(table) + "^elementISEMPTY",
    { limit: 1, fields: fields },
  );
  if (rows.length > 0) return rows[0];
  throw new Error(
    "set-table: no collection dictionary row found for '" +
      table +
      "'. Check the table name — every real table has exactly one row with " +
      "internal_type=collection and an empty element.",
  );
}

/**
 * Require the update set to be open. A write into a Complete/Ignored set is accepted
 * and then silently lost — the change lands on the instance and is captured nowhere,
 * so it can never be promoted.
 */
async function assertUpdateSetOpen(
  client: ServiceNowClient,
  updateSetSysId: string,
): Promise<void> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_set",
    "sys_id=" + encodeQueryValue(updateSetSysId),
    { limit: 1, fields: ["sys_id", "name", "state"] },
  );
  if (rows.length === 0) {
    throw new Error(
      "set-table: update set " + updateSetSysId + " not found on this instance.",
    );
  }
  var state = fieldToString(rows[0].state);
  if (state !== "in progress" && state !== "in_progress") {
    throw new Error(
      "set-table: update set '" +
        fieldToString(rows[0].name) +
        "' is '" +
        state +
        "', not 'in progress'. A change written into a closed set is captured " +
        "nowhere and can never be promoted.",
    );
  }
}

/**
 * Assert the change was captured. The collection row's update name is deterministic
 * and ends in `_null` — the element is empty, so ServiceNow names the row for "no
 * column" rather than for a column.
 */
async function assertCaptured(
  client: ServiceNowClient,
  table: string,
  updateSetSysId: string,
): Promise<boolean> {
  var name = "sys_dictionary_" + table + "_null";
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_xml",
    "update_set=" +
      encodeQueryValue(updateSetSysId) +
      "^name=" +
      encodeQueryValue(name),
    { limit: 1, fields: ["sys_id", "name"] },
  );
  return rows.length > 0;
}

function describeChanges(changes: Array<AttributeChange>): string {
  return changes
    .map(function (c) {
      return c.attribute + " " + (c.from === "" ? "(empty)" : c.from) + " -> " + c.to;
    })
    .join(", ");
}

export async function setTable(params: SetTableParams): Promise<SetTableResult> {
  if (!params || !params.client) {
    throw new Error("set-table: client is required.");
  }
  if (!params.table || !String(params.table).trim()) {
    throw new Error("set-table: --table is required.");
  }
  // The allowlist is enforced BEFORE anything touches the instance, so an
  // unsettable attribute fails on the dry-run too.
  var writes = resolveTableAttributes(params.attributes);
  var targets = Object.keys(writes);
  var table = String(params.table).trim();

  var readFields = ["sys_id", "name", "element", "internal_type"].concat(targets);
  var row = await fetchCollectionRow(params.client, table, readFields);
  var tableSysId = fieldToString(row.sys_id);

  // Diff against what the instance actually stores, so a same-value request is
  // reported as unchanged rather than written over itself and called applied.
  var changes: Array<AttributeChange> = [];
  for (var i = 0; i < targets.length; i += 1) {
    var field = targets[i];
    var from = fieldToString(row[field]);
    var to = writes[field];
    if (from !== to) {
      changes.push({ attribute: field, from: from, to: to });
    }
  }

  if (params.dryRun) {
    return {
      status: "dry-run",
      table: table,
      tableSysId: tableSysId,
      updateSetSysId: params.updateSetSysId ? String(params.updateSetSysId).trim() : "",
      changes: changes,
      verified: false,
      capturedInUpdateSet: false,
      note:
        changes.length === 0
          ? "dry-run: no write. " +
            table +
            " already holds every requested value — nothing would change."
          : "dry-run: no write. Would set " +
            describeChanges(changes) +
            " on " +
            table +
            ", captured into update set " +
            (params.updateSetSysId ? params.updateSetSysId : "(none provided)") +
            ".",
    };
  }

  if (!params.updateSetSysId || !String(params.updateSetSysId).trim()) {
    throw new Error(
      "set-table: --update-set <sys_id> is required so the schema change is " +
        "captured and can be promoted. An uncaptured change exists only on this " +
        "instance.",
    );
  }
  var updateSetSysId = String(params.updateSetSysId).trim();
  await assertUpdateSetOpen(params.client, updateSetSysId);

  if (changes.length === 0) {
    return {
      status: "unchanged",
      table: table,
      tableSysId: tableSysId,
      updateSetSysId: updateSetSysId,
      changes: [],
      verified: true,
      capturedInUpdateSet: false,
      note:
        table +
        " already holds every requested value — nothing written, and nothing " +
        "captured: an identical-value write produces no sys_update_xml row.",
    };
  }

  var fieldsToWrite: Record<string, string> = {};
  for (var k = 0; k < changes.length; k += 1) {
    fieldsToWrite[changes[k].attribute] = changes[k].to;
  }

  try {
    await params.client.claude.pushWithUpdateSet({
      update_set_sys_id: updateSetSysId,
      table: "sys_dictionary",
      record_sys_id: tableSysId,
      fields: fieldsToWrite,
    });
  } catch (e) {
    // The write may or may not have landed — the transport failed, not necessarily
    // the change. Say exactly that rather than leaving the caller to guess.
    return {
      status: "failed",
      table: table,
      tableSysId: tableSysId,
      updateSetSysId: updateSetSysId,
      changes: changes,
      verified: false,
      capturedInUpdateSet: false,
      note:
        "the write to " +
        table +
        " failed in transport: " +
        (e instanceof Error ? e.message : String(e)) +
        ". Re-read the dictionary row before retrying — the change may or may not " +
        "have landed.",
    };
  }

  // Read back from the instance. A 200 is not proof the value stuck.
  var afterRow = await fetchCollectionRow(params.client, table, readFields);
  var verified = true;
  for (var m = 0; m < targets.length; m += 1) {
    if (fieldToString(afterRow[targets[m]]) !== writes[targets[m]]) {
      verified = false;
    }
  }
  var captured = await assertCaptured(params.client, table, updateSetSysId);

  if (!verified) {
    return {
      status: "failed",
      table: table,
      tableSysId: tableSysId,
      updateSetSysId: updateSetSysId,
      changes: changes,
      verified: false,
      capturedInUpdateSet: captured,
      note:
        "the write to " +
        table +
        " landed but the read-back does not match what was requested — check " +
        "dictionary ACLs on this instance.",
    };
  }

  return {
    status: "applied",
    table: table,
    tableSysId: tableSysId,
    updateSetSysId: updateSetSysId,
    changes: changes,
    verified: true,
    capturedInUpdateSet: captured,
    note: captured
      ? "Set " +
        describeChanges(changes) +
        " on " +
        table +
        ", verified by read-back and captured in update set " +
        updateSetSysId +
        "."
      : "Set " +
        describeChanges(changes) +
        " on " +
        table +
        " and verified by read-back, but NO sys_update_xml row was found in " +
        "update set " +
        updateSetSysId +
        " — the change cannot be promoted off this instance until it is captured.",
  };
}
