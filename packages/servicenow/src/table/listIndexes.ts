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
/** A table can carry a lot of indexes; cap the read so one call cannot run away. */
var INDEX_ROW_LIMIT = 500;

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

export async function listIndexes(
  params: ListIndexesParams,
): Promise<ListIndexesResult> {
  if (!params || typeof params !== "object") {
    throw new Error("index-list: params object required.");
  }
  if (!params.client) throw new Error("index-list: client is required.");
  var table = assertTableName(params.table, "index-list");

  var rows = await params.client.table.query<Record<string, unknown>>(
    "v_db_index",
    "table_name=" + encodeQueryValue(table),
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
    if (fieldToString(row.table_name) !== table) continue;
    var raw = fieldToString(row.column_names);
    indexes.push({
      name: fieldToString(row.index_name),
      columns: parseIndexColumns(raw),
      type: fieldToString(row.access_method),
      rawColumns: raw,
    });
  }

  return {
    table: table,
    indexes: indexes,
    unverified: [UNIQUENESS_UNVERIFIABLE],
    note:
      indexes.length === 0
        ? "v_db_index reports NO index for '" +
          table +
          "'. Every physical table has at least a PRIMARY index, so an empty result " +
          "more likely means the table name is wrong (or does not exist on this " +
          "instance) than that the table is genuinely unindexed."
        : "Read " +
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
