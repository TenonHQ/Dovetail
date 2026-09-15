/**
 * addIndex — create a single-column UNIQUE index on an EXISTING ServiceNow table,
 * headless, and then read the result back.
 *
 * THE ONLY HEADLESS LEVER IS `sys_dictionary.unique`. There is no writable index
 * table: `sys_index` fails an API-LEVEL ACL (HTTP 403) for every identity — an ACL
 * that refuses GET refuses POST — and `sys_index_column` does not exist (HTTP 400
 * "Invalid table"). So this verb patches the column's dictionary row through the
 * scope-aware `pushWithUpdateSet` op (update set + scope switched server-side,
 * exactly as `addColumn` does for max_length) and lets the platform build the
 * physical index off that flag.
 *
 * Consequences, each of which the contract encodes rather than hides:
 *
 * 1. PER-COLUMN ONLY. `unique` is a column flag, so a composite index has no
 *    dictionary lever at all. A multi-column request is REFUSED, never narrowed to
 *    its first column — quietly building a different index than the one asked for is
 *    the worst available outcome. Composite / non-unique indexes stay UI work.
 *
 * 2. THE FLAG IS NOT SELF-VERIFYING. `x_cadso_core_metric_point.idempotency_key`
 *    reads `unique=true` in the dictionary with NO index on the table — a lying row.
 *    So the write is never the proof: after the patch the dictionary row is re-read
 *    BY sys_id and the index is looked for in the `v_db_index` VIEW (`table_name`,
 *    `column_names` as a bracketed list like "[occurrence_key]", `index_name`,
 *    `access_method`). A flag with no index is a FAILURE, not a success with a note.
 *
 * 3. UNIQUENESS ENFORCEMENT IS UNREADABLE. `v_db_index` carries no uniqueness field
 *    — every row reads `access_method: btree`, unique or not — and the same view also
 *    shows the ordinary reference indexes ServiceNow builds on its own. Presence of
 *    an index over the right column is therefore NECESSARY BUT NOT SUFFICIENT, and
 *    "uniqueness-enforced" is reported in `unverified` on EVERY status, success
 *    included. Only a duplicate-insert test can prove enforcement.
 *
 * 4. A UNIQUE INDEX CANNOT BUILD OVER DUPLICATE VALUES, and the platform fails that
 *    ALTER quietly — leaving exactly the lying row above. So the live path scans the
 *    column first and ABORTS BEFORE WRITING when values repeat. EMPTY counts as a
 *    value: a newly added column that is empty on all 498 existing rows is 498
 *    collisions, which is the single most likely way this verb would be used wrong.
 *
 * `verified.indexPresent` is deliberately three-valued: `true` (a matching row was
 * read back), `false` (the view WAS read and holds no such row) and `null` (the view
 * could not be read, or was never read). Collapsing `null` into `false` would report
 * "the index is absent" when the truth is "the instrument is blind".
 *
 * `set-column` cannot do this: its WRITABLE allowlist is closed (label, mandatory,
 * default, read_only, max_length) and deliberately excludes `unique`, which has a
 * physical side effect and a verification burden the others do not.
 *
 * ES6 only, no optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";
import { encodeQueryValue } from "../choices";

var SYS_ID = /^[0-9a-f]{32}$/i;
/** A dictionary element is a plain identifier. Anything else is rejected before it
 *  reaches an encoded query or a sysparm_fields list. */
var COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** ServiceNow caps a Table API page at 1000 rows, and there is no sysparm_offset on
 *  the client — the duplicate scan pages by a sys_id keyset instead. */
var SCAN_PAGE_SIZE = 1000;
var SCAN_MAX_PAGES = 10;
var INDEX_ROW_LIMIT = 500;
var SAMPLE_VALUE_MAX = 80;
var MAX_DUPLICATE_SAMPLES = 5;

/** Never provable from a read — see header note 3. Present on every status. */
var UNIQUENESS_UNVERIFIABLE = "uniqueness-enforced";
/** Set when v_db_index was not read at all (dry-run) or could not be read (403). */
var INDEX_PRESENCE_UNVERIFIED = "index-presence";

export interface AddIndexParams {
  /** REST client for table/scope resolution, the dictionary patch, and the read-back. */
  client: ServiceNowClient;
  /** Existing table — its name ("x_cadso_journey_instance") OR its sys_db_object sys_id. */
  table: string;
  /** The column list. Exactly one entry today; more is REFUSED, never narrowed. */
  columns: Array<string>;
  /** Must be true — there is no dictionary lever for a plain (non-unique) index. */
  unique: true;
  /** Scope name or sys_scope sys_id. Must match the table's own scope. */
  scope?: string;
  /** Update set to capture the dictionary patch into. REQUIRED on the live path. */
  updateSetSysId?: string;
  /** Plan only — no reads, no writes. */
  dryRun?: boolean;
  /** Add diagnostic detail to the result note. */
  debug?: boolean;
}

/** What was actually READ BACK. `null` means "not read", never "absent". */
export interface AddIndexVerification {
  /** sys_dictionary.unique re-read after the patch. null when the re-read failed. */
  dictionaryUnique: boolean | null;
  /** A v_db_index row over exactly these columns. null when the view was not read. */
  indexPresent: boolean | null;
  /** The matching row's `column_names`, verbatim (e.g. "[occurrence_key]"); "" when none. */
  indexColumns: string;
}

export interface AddIndexResult {
  status: "created" | "dry-run" | "failed" | "skipped";
  /** The table's name (resolved on the live path; echoes the input on dry-run). */
  table: string;
  /** The requested column list, normalized. */
  columns: Array<string>;
  /** index_name as reported by v_db_index; "" when no matching index was read back. */
  indexName: string;
  verified: AddIndexVerification;
  /** Always includes "uniqueness-enforced". Never empty. */
  unverified: Array<string>;
  /** Update set the patch was captured into ("" on dry-run without one). */
  updateSetSysId: string;
  note: string;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return String(e);
}

function isTrue(value: string): boolean {
  var v = value.toLowerCase();
  return v === "true" || v === "1";
}

/** Validate every input BEFORE any network call, and return the single column name. */
function validate(params: AddIndexParams): string {
  if (!params || typeof params !== "object")
    throw new Error("add-index: params object required.");
  if (!params.client) throw new Error("add-index: client is required.");
  if (typeof params.table !== "string" || !params.table.trim())
    throw new Error("add-index: table is required.");

  var columns = params.columns;
  var count = Array.isArray(columns) ? columns.length : 0;
  if (!Array.isArray(columns) || count !== 1) {
    throw new Error(
      "add-index: exactly one column is required (got " +
        count +
        "). sys_dictionary.unique is a PER-COLUMN flag, so there is no headless lever " +
        "for a composite index — and taking the first column would build a DIFFERENT " +
        "index than the one asked for. Create a composite index in the platform UI.",
    );
  }
  var raw = columns[0];
  if (typeof raw !== "string" || !raw.trim())
    throw new Error("add-index: column must be a non-empty string.");
  var column = raw.trim();
  if (!COLUMN_NAME.test(column)) {
    throw new Error(
      "add-index: column '" +
        column +
        "' is not a valid column name — letters, digits and underscores only, " +
        "starting with a letter.",
    );
  }

  if (params.unique !== true) {
    throw new Error(
      "add-index: only a unique index can be created headlessly. The sole lever is " +
        "sys_dictionary.unique, which has no equivalent for a plain (non-unique) index " +
        "— pass unique:true, or create that index in the platform UI.",
    );
  }

  if (
    params.dryRun !== true &&
    (!params.updateSetSysId || !String(params.updateSetSysId).trim())
  ) {
    throw new Error(
      "add-index: updateSetSysId is required on the live path so the sys_dictionary " +
        "change is captured in a known update set (dry-run does not need one).",
    );
  }
  return column;
}

/** Resolve the table by name or sys_id; returns its name, sys_id, and sys_scope sys_id. */
async function resolveTable(
  client: ServiceNowClient,
  table: string,
): Promise<{ name: string; sysId: string; scopeSysId: string }> {
  var query = SYS_ID.test(table)
    ? "sys_id=" + encodeQueryValue(table)
    : "name=" + encodeQueryValue(table);
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_db_object",
    query,
    { limit: 1, fields: ["sys_id", "name", "sys_scope"] },
  );
  if (rows.length === 0) {
    throw new Error(
      "add-index: table '" + table + "' not found in sys_db_object.",
    );
  }
  return {
    name: fieldToString(rows[0].name) || table,
    sysId: fieldToString(rows[0].sys_id),
    scopeSysId: fieldToString(rows[0].sys_scope),
  };
}

/** Resolve a sys_scope sys_id to its scope NAME (e.g. "x_cadso_journey"). */
async function resolveScopeName(
  client: ServiceNowClient,
  scopeSysId: string,
): Promise<string> {
  if (!scopeSysId) return "";
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_scope",
    "sys_id=" + encodeQueryValue(scopeSysId),
    { limit: 1, fields: ["scope"] },
  );
  return rows.length > 0 ? fieldToString(rows[0].scope) : "";
}

/** One repeated value and how many ROWS carry it. */
export interface DuplicateValue {
  value: string;
  rows: number;
}

export interface DuplicateScan {
  duplicates: Array<DuplicateValue>;
  /** Rows actually read. */
  scanned: number;
  /** True when the scan hit its page cap — "no duplicates seen" is then not "none exist". */
  incomplete: boolean;
}

/**
 * Read the column's values across the table and count repeats. EMPTY is counted as a
 * value, not skipped: ServiceNow stores an unset string as "", and "" collides with ""
 * — the 498-rows-with-a-new-empty-column trap. Pages by a sys_id keyset because
 * `client.table.query` exposes no sysparm_offset.
 */
export async function scanForDuplicates(
  client: ServiceNowClient,
  table: string,
  column: string,
): Promise<DuplicateScan> {
  var counts = new Map<string, number>();
  var cursor = "";
  var scanned = 0;
  var incomplete = false;
  for (var page = 0; page < SCAN_MAX_PAGES; page += 1) {
    var query =
      (cursor ? "sys_id>" + encodeQueryValue(cursor) + "^" : "") +
      "ORDERBYsys_id";
    var rows = await client.table.query<Record<string, unknown>>(table, query, {
      limit: SCAN_PAGE_SIZE,
      fields: ["sys_id", column],
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    var moved = false;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] && typeof rows[i] === "object" ? rows[i] : {};
      var value = fieldToString(row[column]);
      var seen = counts.get(value);
      counts.set(value, (seen === undefined ? 0 : seen) + 1);
      var sysId = fieldToString(row.sys_id);
      if (sysId && sysId !== cursor) {
        cursor = sysId;
        moved = true;
      }
    }
    scanned += rows.length;
    if (rows.length < SCAN_PAGE_SIZE) break;
    // A full page that did not advance the cursor would re-read itself forever.
    if (!moved || page === SCAN_MAX_PAGES - 1) {
      incomplete = true;
      break;
    }
  }
  var duplicates: Array<DuplicateValue> = [];
  counts.forEach(function (rowCount, value) {
    if (rowCount > 1) duplicates.push({ value: value, rows: rowCount });
  });
  duplicates.sort(function (a, b) {
    return b.rows - a.rows;
  });
  return { duplicates: duplicates, scanned: scanned, incomplete: incomplete };
}

function sampleValue(value: string): string {
  if (value === "") return "(empty)";
  if (value.length <= SAMPLE_VALUE_MAX) return "'" + value + "'";
  return "'" + value.slice(0, SAMPLE_VALUE_MAX) + "' (truncated)";
}

function describeDuplicates(scan: DuplicateScan): string {
  var collidingRows = 0;
  scan.duplicates.forEach(function (d) {
    collidingRows += d.rows;
  });
  var shown = scan.duplicates.slice(0, MAX_DUPLICATE_SAMPLES).map(function (d) {
    return sampleValue(d.value) + " (" + d.rows + " rows)";
  });
  return (
    scan.duplicates.length +
    " duplicated value(s) across " +
    collidingRows +
    " rows, of " +
    scan.scanned +
    " scanned: " +
    shown.join(", ") +
    (scan.duplicates.length > shown.length ? ", ..." : "")
  );
}

/** Parse a v_db_index `column_names` cell ("[a]", "[a,b]") into its column list. */
export function parseIndexColumns(raw: string): Array<string> {
  var text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (
    text.length > 1 &&
    text.charAt(0) === "[" &&
    text.charAt(text.length - 1) === "]"
  ) {
    text = text.slice(1, text.length - 1);
  }
  if (!text) return [];
  return text
    .split(",")
    .map(function (part) {
      return part.trim();
    })
    .filter(function (part) {
      return part.length > 0;
    });
}

/**
 * Does this row's column list match the requested one EXACTLY? Parsed, never
 * substring-matched: "[occurrence_key_extra]" contains "occurrence_key", and an
 * indexOf test would green-light an index over the wrong column.
 */
export function indexMatchesColumns(
  raw: string,
  columns: Array<string>,
): boolean {
  var parsed = parseIndexColumns(raw);
  if (parsed.length !== columns.length) return false;
  for (var i = 0; i < parsed.length; i += 1) {
    if (parsed[i].toLowerCase() !== String(columns[i]).toLowerCase()) {
      return false;
    }
  }
  return true;
}

interface IndexReadBack {
  /** False when the view could not be read at all — presence is then UNKNOWN. */
  readable: boolean;
  error: string;
  present: boolean;
  indexName: string;
  indexColumns: string;
  /** Every index the view reports for the table — the "an index, but not THIS one" evidence. */
  others: Array<string>;
}

/**
 * Read the index back from `v_db_index`. `sys_index` is never touched: it is
 * API-level-ACL 403 to every identity, so reading it would turn a blind instrument
 * into a hard failure of the whole verb.
 */
async function readIndexBack(
  client: ServiceNowClient,
  table: string,
  columns: Array<string>,
): Promise<IndexReadBack> {
  var rows: Array<Record<string, unknown>>;
  try {
    rows = await client.table.query<Record<string, unknown>>(
      "v_db_index",
      "table_name=" + encodeQueryValue(table),
      {
        limit: INDEX_ROW_LIMIT,
        fields: ["table_name", "index_name", "column_names", "access_method"],
      },
    );
  } catch (e) {
    return {
      readable: false,
      error: errorMessage(e),
      present: false,
      indexName: "",
      indexColumns: "",
      others: [],
    };
  }
  var others: Array<string> = [];
  var match: Record<string, unknown> | undefined;
  var safeRows = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < safeRows.length; i += 1) {
    var row = safeRows[i] && typeof safeRows[i] === "object" ? safeRows[i] : {};
    if (fieldToString(row.table_name) !== table) continue;
    var cols = fieldToString(row.column_names);
    if (!match && indexMatchesColumns(cols, columns)) {
      match = row;
    } else {
      others.push(fieldToString(row.index_name) + " over " + cols);
    }
  }
  return {
    readable: true,
    error: "",
    present: Boolean(match),
    indexName: match ? fieldToString(match.index_name) : "",
    indexColumns: match ? fieldToString(match.column_names) : "",
    others: others,
  };
}

interface LiveState {
  table: string;
  columns: Array<string>;
  updateSetSysId: string;
  dictionaryUnique: boolean | null;
  indexPresent: boolean | null;
  indexColumns: string;
  indexName: string;
  extraUnverified: Array<string>;
}

function finish(
  state: LiveState,
  status: AddIndexResult["status"],
  note: string,
): AddIndexResult {
  return {
    status: status,
    table: state.table,
    columns: state.columns.slice(),
    indexName: state.indexName,
    verified: {
      dictionaryUnique: state.dictionaryUnique,
      indexPresent: state.indexPresent,
      indexColumns: state.indexColumns,
    },
    unverified: [UNIQUENESS_UNVERIFIABLE].concat(state.extraUnverified),
    updateSetSysId: state.updateSetSysId,
    note: note,
  };
}

/** The read-back verdict, shared by the "we wrote" and "already set" paths. */
function verdict(
  state: LiveState,
  readBack: IndexReadBack,
  wrote: boolean,
  table: string,
  column: string,
  extraNote: string,
): AddIndexResult {
  var target = table + "." + column;
  var caveat =
    " NOT VERIFIED: that the index actually REJECTS duplicates — v_db_index carries no " +
    "uniqueness field (every row reads btree, unique or not), so enforcement is provable " +
    "only by a duplicate-insert test.";

  if (!readBack.readable) {
    state.indexPresent = null;
    state.extraUnverified.push(INDEX_PRESENCE_UNVERIFIED);
    return finish(
      state,
      "failed",
      (wrote
        ? "sys_dictionary.unique=true was written for " + target + ", but "
        : target + " already reads unique=true in sys_dictionary, but ") +
        "v_db_index could not be read — index presence is UNKNOWN, which is NOT the " +
        "same as absent: " +
        readBack.error +
        ". Re-run the read-back with an identity that can read v_db_index before " +
        "treating this index as built." +
        caveat +
        extraNote,
    );
  }

  state.indexPresent = readBack.present;
  state.indexName = readBack.indexName;
  state.indexColumns = readBack.indexColumns;

  if (!readBack.present) {
    return finish(
      state,
      "failed",
      (wrote
        ? "sys_dictionary.unique=true was written for " +
          target +
          ", but the index is "
        : target +
          " already reads unique=true in sys_dictionary, but the index is ") +
        "NOT OBSERVED in v_db_index" +
        (readBack.others.length > 0
          ? " (the table's other indexes: " + readBack.others.join("; ") + ")"
          : " (the view reports no index at all for this table)") +
        ". This is the lying-row case — a dictionary flag with no physical index " +
        "behind it, which enforces nothing. " +
        (wrote
          ? "The most likely cause is duplicate values the ALTER could not build over."
          : "Writing 'true' over 'true' fires no ALTER, so nothing was written and " +
            "add-index cannot repair this: clear the duplicates and rebuild the index " +
            "in the platform UI.") +
        caveat +
        extraNote,
    );
  }

  return finish(
    state,
    wrote ? "created" : "skipped",
    (wrote
      ? "Set sys_dictionary.unique=true on " +
        target +
        " and READ BACK a matching index in v_db_index: "
      : target +
        " already reads unique=true in sys_dictionary and v_db_index already holds a " +
        "matching index — nothing was written: ") +
      (readBack.indexName || "(unnamed)") +
      " over " +
      readBack.indexColumns +
      "." +
      caveat +
      extraNote,
  );
}

export async function addIndex(
  params: AddIndexParams,
): Promise<AddIndexResult> {
  var column = validate(params);
  var client = params.client;

  if (params.dryRun) {
    return {
      status: "dry-run",
      table: params.table,
      columns: [column],
      indexName: "",
      verified: {
        dictionaryUnique: false,
        indexPresent: null,
        indexColumns: "",
      },
      unverified: [UNIQUENESS_UNVERIFIABLE, INDEX_PRESENCE_UNVERIFIED],
      updateSetSysId: params.updateSetSysId ? params.updateSetSysId : "",
      note:
        "dry-run: nothing written and nothing read. Would set sys_dictionary.unique=true " +
        "on '" +
        params.table +
        "." +
        column +
        "' — the only headless lever for an index — captured into update set " +
        (params.updateSetSysId ? params.updateSetSysId : "(none provided)") +
        ", then re-read the dictionary row and look for an index over [" +
        column +
        "] in v_db_index. A dry-run does NOT check that the column exists, that its " +
        "values are free of duplicates (a unique index cannot build over them, empty " +
        "values included), or that an index is already there — the live path does all " +
        "three before it writes.",
    };
  }

  // ---- LIVE PATH ------------------------------------------------------------
  var updateSetSysId = String(params.updateSetSysId).trim();
  var resolved = await resolveTable(client, params.table);
  var scopeName = await resolveScopeName(client, resolved.scopeSysId);
  if (!scopeName) {
    throw new Error(
      "add-index: could not resolve the scope name for table '" +
        resolved.name +
        "' (sys_scope " +
        (resolved.scopeSysId || "(none)") +
        ") — needed to confirm the column is written in its own scope.",
    );
  }
  // A column lives in its table's scope; an explicit override must match it.
  if (params.scope && params.scope.trim()) {
    var override = params.scope.trim();
    if (override !== scopeName && override !== resolved.scopeSysId) {
      throw new Error(
        "add-index: --scope '" +
          override +
          "' does not match table '" +
          resolved.name +
          "' scope '" +
          scopeName +
          "' — an index lives in its table's scope. Omit --scope or set it to '" +
          scopeName +
          "'.",
      );
    }
  }

  var state: LiveState = {
    table: resolved.name,
    columns: [column],
    updateSetSysId: updateSetSysId,
    dictionaryUnique: false,
    indexPresent: null,
    indexColumns: "",
    indexName: "",
    extraUnverified: [],
  };

  var dictRows = await client.table.query<Record<string, unknown>>(
    "sys_dictionary",
    "name=" +
      encodeQueryValue(resolved.name) +
      "^element=" +
      encodeQueryValue(column),
    {
      limit: 1,
      fields: ["sys_id", "name", "element", "internal_type", "unique"],
    },
  );
  if (dictRows.length === 0) {
    return finish(
      state,
      "failed",
      "column '" +
        column +
        "' does not exist on " +
        resolved.name +
        " — no sys_dictionary row for name=" +
        resolved.name +
        "^element=" +
        column +
        ". Nothing was written. Add the column first (dove-sn add-column), backfill it, " +
        "then index it.",
    );
  }
  var dictSysId = fieldToString(dictRows[0].sys_id);
  var internalType = fieldToString(dictRows[0].internal_type);
  if (!dictSysId) {
    // The patch targets the dictionary row BY sys_id. Without one there is nothing to
    // aim at, and sending an empty record_sys_id would write blind.
    return finish(
      state,
      "failed",
      "the sys_dictionary row for " +
        resolved.name +
        "." +
        column +
        " came back without a sys_id, so there is no row to patch. Nothing was " +
        "written — check the column (and the caller's read access to sys_dictionary) " +
        "on the instance.",
    );
  }
  var alreadyUnique = isTrue(fieldToString(dictRows[0].unique));
  state.dictionaryUnique = alreadyUnique;
  var debugNote = params.debug
    ? " [debug: dictionarySysId=" +
      dictSysId +
      " internalType=" +
      (internalType || "(none)") +
      " scope=" +
      scopeName +
      " tableSysId=" +
      resolved.sysId +
      "]"
    : "";

  // Already flagged: writing "true" over "true" fires no ALTER, so there is nothing
  // this verb can do — go straight to the read-back and report what is actually there.
  if (alreadyUnique) {
    var existing = await readIndexBack(client, resolved.name, [column]);
    return verdict(state, existing, false, resolved.name, column, debugNote);
  }

  // A unique index cannot build over duplicates, and the failed ALTER is SILENT —
  // it leaves the dictionary claiming unique=true with no index behind it. Check first.
  var scan = await scanForDuplicates(client, resolved.name, column);
  if (scan.duplicates.length > 0) {
    return finish(
      state,
      "failed",
      "Refusing to write: a unique index cannot build over duplicate values, and " +
        resolved.name +
        "." +
        column +
        " holds them — the platform would fail the ALTER silently and leave " +
        "sys_dictionary claiming unique=true with NO index behind it (the " +
        "x_cadso_core_metric_point.idempotency_key trap). " +
        describeDuplicates(scan) +
        ". An EMPTY value counts: every empty row collides with every other empty row. " +
        "Nothing was written — backfill or clear those rows, then re-run." +
        debugNote,
    );
  }
  if (scan.incomplete) {
    state.extraUnverified.push(
      "duplicate-free-beyond-" + scan.scanned + "-scanned-rows",
    );
  }
  var scanNote = scan.incomplete
    ? " NOTE: the duplicate scan stopped after " +
      scan.scanned +
      " rows, so freedom from duplicates was checked only that far."
    : "";

  try {
    await client.claude.pushWithUpdateSet({
      update_set_sys_id: updateSetSysId,
      table: "sys_dictionary",
      record_sys_id: dictSysId,
      fields: { unique: "true" },
    });
  } catch (e) {
    return finish(
      state,
      "failed",
      "The sys_dictionary patch FAILED, so nothing changed: " +
        errorMessage(e) +
        ". " +
        resolved.name +
        "." +
        column +
        " still read unique=false before the attempt; no index was created and no " +
        "update-set entry was captured." +
        debugNote,
    );
  }

  // Read the flag back BY sys_id — the write returning 200 is not evidence the row
  // changed, and it is certainly not evidence an index was built.
  try {
    var after = await client.table.query<Record<string, unknown>>(
      "sys_dictionary",
      "sys_id=" + encodeQueryValue(dictSysId),
      { limit: 1, fields: ["sys_id", "element", "internal_type", "unique"] },
    );
    state.dictionaryUnique =
      after.length > 0 ? isTrue(fieldToString(after[0].unique)) : false;
  } catch (e) {
    state.dictionaryUnique = null;
    return finish(
      state,
      "failed",
      "The sys_dictionary patch was accepted for " +
        resolved.name +
        "." +
        column +
        ", but re-reading the row failed, so nothing about this run is verified: " +
        errorMessage(e) +
        ". Check the column on the instance before relying on it." +
        debugNote,
    );
  }
  if (state.dictionaryUnique !== true) {
    return finish(
      state,
      "failed",
      "The sys_dictionary patch was accepted for " +
        resolved.name +
        "." +
        column +
        ", but the row still does NOT read unique=true on read-back — the flag did not " +
        "stick, so no index was built. Check the column (and the update set) on the " +
        "instance." +
        debugNote,
    );
  }

  var readBack = await readIndexBack(client, resolved.name, [column]);
  return verdict(
    state,
    readBack,
    true,
    resolved.name,
    column,
    " Captured into update set " + updateSetSysId + "." + scanNote + debugNote,
  );
}
