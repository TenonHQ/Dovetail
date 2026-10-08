/**
 * listIndexes — read the database indexes on a ServiceNow table.
 *
 * WHY `v_db_index` AND NOTHING ELSE. There is no readable index TABLE on a
 * ServiceNow instance:
 *
 *   - `sys_index` fails an API-LEVEL ACL — HTTP 403 "Failed API level ACL
 *     Validation" — for every identity we hold, including an admin. Controls
 *     (`sys_db_object`, `sys_user`) return 200 from the same call, so it is the
 *     table, not the credentials. An API-level ACL that refuses GET refuses POST
 *     too, which is also why nothing here ever tries to write it.
 *   - `sys_index_column` DOES NOT EXIST — HTTP 400 "Invalid table". There is no
 *     two-table index model to join.
 *   - `v_db_index` IS readable (HTTP 200). It is the view the platform's own
 *     "Database Indexes" module renders, and it is the only index read surface we
 *     have. Verified live on a Tenon dev instance 2026-09-15 and again 2026-09-30.
 *
 * WHAT THE VIEW CAN AND CANNOT TELL YOU. `column_names` arrives as a BRACKETED
 * string — "[phone]", "[a,b]" — so it is parsed, never used raw and never
 * substring-matched. `access_method` is the index type and reads "btree" for
 * essentially everything. And the view carries NO UNIQUENESS FIELD AT ALL: a
 * unique index and an ordinary one are indistinguishable in it. So this verb
 * reports `unique` as absent rather than guessing, and names "uniqueness-enforced"
 * in `unverified` on every result. Only a duplicate-insert test proves enforcement.
 *
 * TABLE-PER-HIERARCHY CHILDREN HAVE NO ROWS OF THEIR OWN. `v_db_index` lists indexes
 * by PHYSICAL table. A table stored in an ancestor's physical table (everything that
 * extends `task`, for example — `incident`, x_cadso_work_campaign) has NO rows under
 * its own name; its indexes are the storage root's. So when the table's own read is
 * empty but the table exists, its `super_class` chain is walked to the first ancestor
 * that DOES have rows, and that root's indexes are listed — with `storageTable` and the
 * note naming the root, so nobody reads them as the child's own physical table.
 *
 * Read-only: it opens no form session and writes nothing.
 *
 * ES6 only, no optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";
import { encodeQueryValue } from "../choices";
import { parseIndexColumns } from "./addIndex";

/** A table name is a plain identifier. Validated before it reaches an encoded query. */
var TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
var SYS_ID = /^[0-9a-f]{32}$/i;
/** A table can carry a lot of indexes; cap the read so one call cannot run away. */
var INDEX_ROW_LIMIT = 500;
/** How far up `super_class` the storage-root walk goes. Real hierarchies are shallow;
 *  this only stops a corrupt (cyclic or absurdly deep) chain from running away. */
var MAX_HIERARCHY_DEPTH = 16;

/** Never provable from a read — `v_db_index` has no uniqueness column. */
var UNIQUENESS_UNVERIFIABLE = "uniqueness-enforced";

/** One index as the view reports it. */
export interface TableIndex {
  /** `index_name`, e.g. "message_batch" or "PRIMARY". */
  name: string;
  /** `column_names` parsed out of its bracketed form: "[a,b]" -> ["a", "b"]. */
  columns: Array<string>;
  /** `access_method`, e.g. "btree". The index TYPE, not its uniqueness. */
  type: string;
  /**
   * DELIBERATELY NEVER SET. `v_db_index` carries no uniqueness field, so there is
   * nothing to populate this from. It is declared so the shape is honest about what
   * is missing — reading `undefined` here means "unknown", and it will never mean
   * "not unique". Typed `unknown` so no caller can branch on it without narrowing.
   */
  unique?: unknown;
  /** The raw `column_names` cell, verbatim, for anyone who needs to see what was parsed. */
  rawColumns: string;
}

export interface ListIndexesParams {
  /** REST client. Reads only. */
  client: ServiceNowClient;
  /** The table whose indexes to list, by NAME (not a sys_id — the view keys on name). */
  table: string;
}

export interface ListIndexesResult {
  table: string;
  /**
   * The PHYSICAL table the listed indexes belong to. Equal to `table` for a table with
   * its own storage; the storage root (e.g. "task" for "incident") when `table` is a
   * table-per-hierarchy child with no v_db_index rows of its own.
   */
  storageTable: string;
  indexes: Array<TableIndex>;
  /** Always includes "uniqueness-enforced". Never empty. */
  unverified: Array<string>;
  note: string;
}

/**
 * Validate the table name before it is interpolated anywhere. An encoded query does
 * not ERROR on a stray "^" or "="; it silently changes what the query MEANS, so a
 * value like "phone;DROP" or "a^ORsys_id!=x" must never reach one.
 */
export function assertTableName(table: string, verb: string): string {
  if (typeof table !== "string" || !table.trim()) {
    throw new Error(verb + ": table is required.");
  }
  var name = table.trim();
  if (!TABLE_NAME.test(name)) {
    throw new Error(
      verb +
        ": table '" +
        name +
        "' is not a valid table name — letters, digits and underscores only, " +
        "starting with a letter.",
    );
  }
  return name;
}

/**
 * Every index `v_db_index` reports for one PHYSICAL table, parsed. The table name is
 * validated here too, because it is interpolated into an encoded query.
 */
export async function readTableIndexes(
  client: ServiceNowClient,
  table: string,
): Promise<Array<TableIndex>> {
  var name = assertTableName(table, "index-read");
  var rows = await client.table.query<Record<string, unknown>>(
    "v_db_index",
    "table_name=" + encodeQueryValue(name),
    {
      limit: INDEX_ROW_LIMIT,
      fields: ["table_name", "index_name", "column_names", "access_method"],
    },
  );

  var safeRows = Array.isArray(rows) ? rows : [];
  var indexes: Array<TableIndex> = [];
  for (var i = 0; i < safeRows.length; i += 1) {
    var row = safeRows[i] && typeof safeRows[i] === "object" ? safeRows[i] : {};
    // Re-check the table name on every row. An encoded query that the instance did
    // not understand returns the UNFILTERED set rather than erroring, so trusting
    // the filter alone would silently list another table's indexes as this one's.
    if (fieldToString(row.table_name) !== name) continue;
    var raw = fieldToString(row.column_names);
    indexes.push({
      name: fieldToString(row.index_name),
      columns: parseIndexColumns(raw),
      type: fieldToString(row.access_method),
      rawColumns: raw,
    });
  }
  return indexes;
}

/** Where a table's indexes physically live, for a table with NO v_db_index rows of its own. */
export interface IndexStorageRoot {
  /** The table itself was found in sys_db_object. */
  tableFound: boolean;
  /** The first ancestor with v_db_index rows; "" when none was found. */
  root: string;
  /** Ancestors walked, nearest first (ends with `root` when one was found). */
  chain: Array<string>;
  /** The root's indexes (empty when there is no root). */
  indexes: Array<TableIndex>;
}

/** One sys_db_object row by an exact key, re-checked; null when absent. */
async function readTableObject(
  client: ServiceNowClient,
  key: "name" | "sys_id",
  value: string,
): Promise<{ sysId: string; name: string; superClass: string } | null> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_db_object",
    key + "=" + encodeQueryValue(value),
    { limit: 1, fields: ["sys_id", "name", "super_class"] },
  );
  var safe = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < safe.length; i += 1) {
    var row = safe[i] && typeof safe[i] === "object" ? safe[i] : {};
    var actual = key === "name" ? fieldToString(row.name) : fieldToString(row.sys_id);
    if (actual.toLowerCase() !== value.toLowerCase()) continue;
    return {
      sysId: fieldToString(row.sys_id),
      name: fieldToString(row.name),
      superClass: fieldToString(row.super_class),
    };
  }
  return null;
}

/**
 * For a table with NO v_db_index rows of its own: walk its `super_class` chain to the
 * first ancestor that HAS rows — the table-per-hierarchy storage root whose physical
 * table holds this table's rows (and therefore its indexes). Read-only. Bounded by
 * MAX_HIERARCHY_DEPTH and guarded against a cyclic chain. Read errors propagate: an
 * unreadable hierarchy is the caller's to report, never a silent "no root".
 */
export async function findIndexStorageRoot(
  client: ServiceNowClient,
  table: string,
): Promise<IndexStorageRoot> {
  var name = assertTableName(table, "index-read");
  var current = await readTableObject(client, "name", name);
  if (!current) {
    return { tableFound: false, root: "", chain: [], indexes: [] };
  }
  var chain: Array<string> = [];
  var visited: Record<string, boolean> = {};
  if (current.sysId) visited[current.sysId.toLowerCase()] = true;
  for (var depth = 0; depth < MAX_HIERARCHY_DEPTH; depth += 1) {
    var superId = current.superClass.trim();
    if (!SYS_ID.test(superId)) break;
    if (visited[superId.toLowerCase()]) break;
    visited[superId.toLowerCase()] = true;
    var parent = await readTableObject(client, "sys_id", superId);
    if (!parent || !TABLE_NAME.test(parent.name)) break;
    chain.push(parent.name);
    var parentIndexes = await readTableIndexes(client, parent.name);
    if (parentIndexes.length > 0) {
      return {
        tableFound: true,
        root: parent.name,
        chain: chain,
        indexes: parentIndexes,
      };
    }
    current = parent;
  }
  return { tableFound: true, root: "", chain: chain, indexes: [] };
}

/** The sentence every verb uses to name a table-per-hierarchy storage root. */
export function describeStorageRoot(table: string, storage: IndexStorageRoot): string {
  return (
    "'" +
    table +
    "' has no physical table of its own: it is stored in '" +
    storage.root +
    "''s physical table (table-per-hierarchy, via " +
    [table].concat(storage.chain).join(" -> ") +
    "), and v_db_index lists indexes by PHYSICAL table, so " +
    table +
    "'s indexes are " +
    storage.root +
    "'s."
  );
}

export async function listIndexes(
  params: ListIndexesParams,
): Promise<ListIndexesResult> {
  if (!params || typeof params !== "object") {
    throw new Error("index-list: params object required.");
  }
  if (!params.client) throw new Error("index-list: client is required.");
  var table = assertTableName(params.table, "index-list");

  var indexes = await readTableIndexes(params.client, table);

  if (indexes.length === 0) {
    // No rows under its own name. Either the table does not exist, or it is a
    // table-per-hierarchy child whose indexes live on an ancestor's physical table.
    var storage = await findIndexStorageRoot(params.client, table);
    if (storage.root) {
      return {
        table: table,
        storageTable: storage.root,
        indexes: storage.indexes,
        unverified: [UNIQUENESS_UNVERIFIABLE],
        note:
          describeStorageRoot(table, storage) +
          " The " +
          storage.indexes.length +
          " index(es) listed are " +
          storage.root +
          "'s; they cover " +
          table +
          "'s rows too, and an index for one of " +
          table +
          "'s columns would have to be built on " +
          storage.root +
          ". NOT VERIFIED: which of them are UNIQUE — the view has no uniqueness field.",
      };
    }
    return {
      table: table,
      storageTable: table,
      indexes: [],
      unverified: [UNIQUENESS_UNVERIFIABLE],
      note: !storage.tableFound
        ? "v_db_index reports NO index for '" +
          table +
          "', and the table was not found in sys_db_object on this instance — the " +
          "table name is wrong (or the table does not exist here). Every physical " +
          "table has at least a PRIMARY index."
        : "v_db_index reports NO index for '" +
          table +
          "', and none for any ancestor either" +
          (storage.chain.length > 0 ? " (" + storage.chain.join(" -> ") + ")" : "") +
          ", although the table exists in sys_db_object. Every physical table has " +
          "at least a PRIMARY index, so the index view is not readable for it from " +
          "this identity — this is NOT evidence the table is unindexed.",
    };
  }

  return {
    table: table,
    storageTable: table,
    indexes: indexes,
    unverified: [UNIQUENESS_UNVERIFIABLE],
    note:
      "Read " +
      indexes.length +
      " index(es) for '" +
      table +
      "' from v_db_index. NOT VERIFIED: which of them are UNIQUE — the view has " +
      "no uniqueness field (every row reads its access_method, unique or not), so " +
      "enforcement is provable only by a duplicate-insert test. sys_index is " +
      "API-level-ACL 403 and sys_index_column does not exist, so there is no " +
      "second surface to cross-check against.",
  };
}
