/**
 * createIndex — create a database index on an EXISTING ServiceNow table, including
 * the COMPOSITE and NON-UNIQUE indexes `add-index` cannot build, by replaying the
 * platform's own index-creator form.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * A DATABASE INDEX IS A PHYSICAL, PER-INSTANCE CHANGE. IT IS **NOT** CAPTURED IN AN
 * UPDATE SET, AND IT DOES **NOT** TRAVEL WITH A PROMOTION. Every environment that
 * needs the index must have this run against it. That is why this verb takes no
 * `updateSetSysId` — there is nothing for one to capture.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHY A FORM REPLAY. There is no record path to an index:
 *   - `sys_index` is API-level-ACL 403 for every identity (an ACL that refuses GET
 *     refuses POST), and `sys_index_column` does not exist (HTTP 400 "Invalid
 *     table"). So the "insert two records" design is not merely blocked, it is
 *     not a real model of the platform.
 *   - `sys_dictionary.unique` is the one record-shaped lever, and it is PER-COLUMN
 *     and UNIQUE-ONLY. That lever is already shipped as `add-index`; this verb
 *     exists for everything that lever cannot express.
 *
 * THE FORM CONTRACT IS THE INSTANCE'S OWN. It was not guessed and it was not read
 * off a stale HAR: it is lifted from the shipped `index_creator_information`
 * sys_ui_macro and the `v_index_creator` "New" UI action, both read live from a
 * Tenon instance 2026-09-30. The macro's own inputs are:
 *
 *     sys_action                = "create_index"   (hidden)
 *     sysparm_index_table       = <table>
 *     sysparm_fields            = <comma-separated column list>
 *     sysparm_unique_index_SKIP = "on"             (the Unique Index checkbox)
 *     sysparm_access_method     = <method>         (only when
 *                                 glide.ui.index_method.enabled is true)
 *
 * and the dialog is the `index_creator_dialog` UI page. The POST target is taken
 * from that page's own `<form action>` when it renders one, falling back to the
 * page itself — harvest-then-use, the same discipline createTable applies to the
 * list-edit key rather than hard-coding a guess.
 *
 * THERE IS NO INDEX-NAME INPUT. The form has none; ServiceNow names the index
 * itself (in practice after the leading column). A `name` is therefore REFUSED
 * rather than silently dropped — a caller who asked for `idx_phone_created` and got
 * `phone` would have no way to know, and the whole point of this module is that the
 * instance is read back rather than believed.
 *
 * THE WRITE IS NEVER THE PROOF. After the POST the index is looked for in
 * `v_db_index` on a bounded poll (index builds are asynchronous on a populated
 * table). If it never appears, this FAILS loudly — a 200 from a form processor is
 * not evidence an ALTER ran. `verified:true` means a matching row was READ BACK.
 *
 * WHAT IS STILL NOT PROVABLE: that a unique index actually REJECTS duplicates.
 * `v_db_index` has no uniqueness field, so "uniqueness-enforced" is reported in
 * `unverified` on every status, success included.
 *
 * ES6 only, no optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";
import { encodeQueryValue } from "../choices";
import { indexMatchesColumns, parseIndexColumns } from "./addIndex";
import { assertTableName } from "./listIndexes";
import {
  resolveFormAuth,
  openFormSession,
  getFormPage,
  postForm,
} from "./formSession";

/** A column is a plain identifier — rejects "phone;DROP", "a b", "a.b", "a^ORx". */
var COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** The UI page that renders the index creator. Overridable per instance. */
export var DEFAULT_INDEX_FORM_PATH = "/index_creator_dialog.do";
/** How many columns one index may span. The platform's own ceiling is lower than
 *  anything sane; this just stops an absurd request reaching the instance. */
var MAX_INDEX_COLUMNS = 16;
/** Read-back poll: an index build on a populated table is not instantaneous. */
var DEFAULT_POLL_ATTEMPTS = 10;
var DEFAULT_POLL_INTERVAL_MS = 3000;
var INDEX_ROW_LIMIT = 500;

/** Never provable from a read — see the header. */
var UNIQUENESS_UNVERIFIABLE = "uniqueness-enforced";
/** The standing caveat every caller must carry forward. */
export var NOT_IN_UPDATE_SET =
  "A database index is a PHYSICAL, PER-INSTANCE change: it is NOT captured in an " +
  "update set and does NOT travel with a promotion. Re-run this against every " +
  "environment that needs the index (dev, test, uat, staging, prod).";

export interface CreateIndexParams {
  /** REST client — used for the idempotency read and the read-back poll. */
  client: ServiceNowClient;
  /** The table to index, by NAME. */
  table: string;
  /** Ordered column list. Order matters to an index; it is preserved verbatim. */
  columns: Array<string>;
  /**
   * REFUSED. The platform's index-creator form has no name input — ServiceNow names
   * the index itself. Declared only so a caller can express it and be told why,
   * rather than have it silently ignored.
   */
  name?: string;
  /** Tick the form's "Unique Index" checkbox. Default false (a plain index). */
  unique?: boolean;
  /** `sysparm_access_method`, when the instance exposes the selector. */
  accessMethod?: string;
  /** REQUIRED to write. Without it this is a dry-run, whatever else is passed. */
  confirm?: boolean;
  /** Force a dry-run even with confirm:true. */
  dryRun?: boolean;
  /** Override the index-creator page path (default DEFAULT_INDEX_FORM_PATH). */
  formPath?: string;
  /** Read-back poll shape. Defaults: 10 attempts, 3000 ms apart. */
  pollAttempts?: number;
  pollIntervalMs?: number;
  /** Instance/creds for the form session (default: env, same precedence as the client). */
  instance?: string;
  user?: string;
  password?: string;
  /** Add diagnostic detail to the note. */
  debug?: boolean;
}

export interface CreateIndexResult {
  status: "created" | "already-exists" | "dry-run" | "failed";
  /** True ONLY on a fresh, read-back-verified create. */
  created: boolean;
  table: string;
  /** The index name as `v_db_index` reports it — never a name we asked for. */
  name: string;
  /** The requested column list, normalized. */
  columns: Array<string>;
  /** True ONLY when a matching `v_db_index` row was READ BACK. */
  verified: boolean;
  /** The host the write was aimed at — an index is per-instance, so this matters. */
  instance: string;
  /** Always includes "uniqueness-enforced". Never empty. */
  unverified: Array<string>;
  /** HTTP status of the form POST; 0 when none was sent. */
  httpStatus: number;
  note: string;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return String(e);
}

/** Validate every input BEFORE any network call. Returns the normalized columns. */
export function validateCreateIndex(params: CreateIndexParams): {
  table: string;
  columns: Array<string>;
} {
  if (!params || typeof params !== "object") {
    throw new Error("index-create: params object required.");
  }
  if (!params.client) throw new Error("index-create: client is required.");
  var table = assertTableName(params.table, "index-create");

  var raw = params.columns;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      "index-create: at least one column is required (--columns a,b).",
    );
  }
  if (raw.length > MAX_INDEX_COLUMNS) {
    throw new Error(
      "index-create: " +
        raw.length +
        " columns requested; refusing more than " +
        MAX_INDEX_COLUMNS +
        " in one index.",
    );
  }
  var columns: Array<string> = [];
  var seen: Record<string, boolean> = {};
  for (var i = 0; i < raw.length; i += 1) {
    var entry = raw[i];
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(
        "index-create: column " + (i + 1) + " must be a non-empty string.",
      );
    }
    var column = entry.trim();
    if (!COLUMN_NAME.test(column)) {
      throw new Error(
        "index-create: column '" +
          column +
          "' is not a valid column name — letters, digits and underscores only, " +
          "starting with a letter. A value carrying a separator, a space, a dot or " +
          "a query operator must never reach an encoded query or the form's " +
          "comma-separated field list.",
      );
    }
    var key = column.toLowerCase();
    if (seen[key]) {
      throw new Error(
        "index-create: column '" +
          column +
          "' is listed twice — an index cannot span the same column twice.",
      );
    }
    seen[key] = true;
    columns.push(column);
  }

  if (params.name !== undefined && String(params.name).trim()) {
    throw new Error(
      "index-create: refusing to set an index name — the platform's index-creator " +
        "form has NO name input; ServiceNow names the index itself (in practice " +
        "after the leading column). Accepting '" +
        String(params.name).trim() +
        "' would mean reporting a name that is not the one on the instance. Drop " +
        "--name; the created index's real name is returned in `name`.",
    );
  }
  return { table: table, columns: columns };
}

/** Read every index the view reports for the table, already parsed. */
async function readIndexes(
  client: ServiceNowClient,
  table: string,
): Promise<Array<{ name: string; columns: Array<string>; raw: string }>> {
  var rows = await client.table.query<Record<string, unknown>>(
    "v_db_index",
    "table_name=" + encodeQueryValue(table),
    {
      limit: INDEX_ROW_LIMIT,
      fields: ["table_name", "index_name", "column_names", "access_method"],
    },
  );
  var safeRows = Array.isArray(rows) ? rows : [];
  var out: Array<{ name: string; columns: Array<string>; raw: string }> = [];
  for (var i = 0; i < safeRows.length; i += 1) {
    var row = safeRows[i] && typeof safeRows[i] === "object" ? safeRows[i] : {};
    // An encoded query the instance does not understand returns the UNFILTERED set
    // instead of erroring, so the table name is re-checked per row.
    if (fieldToString(row.table_name) !== table) continue;
    var raw = fieldToString(row.column_names);
    out.push({
      name: fieldToString(row.index_name),
      columns: parseIndexColumns(raw),
      raw: raw,
    });
  }
  return out;
}

/** The first index over EXACTLY these columns, or undefined. Parsed, never substring. */
function findMatch(
  indexes: Array<{ name: string; columns: Array<string>; raw: string }>,
  columns: Array<string>,
): { name: string; columns: Array<string>; raw: string } | undefined {
  for (var i = 0; i < indexes.length; i += 1) {
    if (indexMatchesColumns(indexes[i].raw, columns)) return indexes[i];
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** A positive integer, or the default. Guards an infinite/zero poll from a bad arg. */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      "index-create: poll settings must be positive integers (got " +
        String(value) +
        ").",
    );
  }
  return value;
}

function result(
  partial: Partial<CreateIndexResult> & {
    status: CreateIndexResult["status"];
    table: string;
    columns: Array<string>;
    instance: string;
    note: string;
  },
): CreateIndexResult {
  return {
    status: partial.status,
    created: partial.created === true,
    table: partial.table,
    name: partial.name ? partial.name : "",
    columns: partial.columns.slice(),
    verified: partial.verified === true,
    instance: partial.instance,
    unverified: [UNIQUENESS_UNVERIFIABLE],
    httpStatus: partial.httpStatus ? partial.httpStatus : 0,
    note: partial.note,
  };
}

export async function createIndex(
  params: CreateIndexParams,
): Promise<CreateIndexResult> {
  var checked = validateCreateIndex(params);
  var table = checked.table;
  var columns = checked.columns;
  var unique = params.unique === true;
  var attempts = positiveInt(params.pollAttempts, DEFAULT_POLL_ATTEMPTS);
  var intervalMs = positiveInt(params.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  var spec = table + " [" + columns.join(", ") + "]";

  // DRY-RUN IS THE DEFAULT, and it is PURE — no session, no query, no write. The
  // idempotency check deliberately lives on the live path: a dry-run that quietly
  // hit the instance would make "nothing is sent without confirm" untrue.
  if (params.dryRun === true || params.confirm !== true) {
    return result({
      status: "dry-run",
      table: table,
      columns: columns,
      instance: "",
      note:
        "dry-run: nothing sent and nothing read. Would create a " +
        (unique ? "UNIQUE" : "non-unique") +
        " index on " +
        spec +
        " by replaying the platform index-creator form (sys_action=create_index), " +
        "then poll v_db_index up to " +
        attempts +
        " times, " +
        intervalMs +
        " ms apart, until the index is observed. A dry-run does NOT check that the " +
        "table or columns exist, and does NOT check whether the index is already " +
        "there — the live path does both before it writes. Pass confirm:true to " +
        "write. " +
        NOT_IN_UPDATE_SET,
    });
  }

  // ---- LIVE PATH ------------------------------------------------------------
  var auth = resolveFormAuth({
    instance: params.instance,
    user: params.user,
    password: params.password,
  });
  var instance = auth.host;

  // IDEMPOTENCY. An index over exactly these columns already present means there is
  // nothing to do — and re-running the form would at best be a no-op and at worst
  // leave a second, redundant index on the table.
  var existing: Array<{ name: string; columns: Array<string>; raw: string }>;
  try {
    existing = await readIndexes(params.client, table);
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      note:
        "Refusing to write: v_db_index could not be read, so whether this index " +
        "already exists is UNKNOWN — and creating a duplicate index is not something " +
        "to do blind: " +
        errorMessage(e) +
        ". Nothing was sent. " +
        NOT_IN_UPDATE_SET,
    });
  }
  var already = findMatch(existing, columns);
  if (already) {
    return result({
      status: "already-exists",
      table: table,
      columns: columns,
      instance: instance,
      name: already.name,
      verified: true,
      note:
        "Nothing written — " +
        table +
        " already carries an index over exactly these columns: '" +
        (already.name || "(unnamed)") +
        "' over " +
        already.raw +
        ". NOT VERIFIED: whether that existing index is UNIQUE — v_db_index has no " +
        "uniqueness field, so if you need uniqueness specifically, prove it with a " +
        "duplicate-insert test rather than inferring it from this row. " +
        NOT_IN_UPDATE_SET,
    });
  }

  // Open the form session. This THROWS with a diagnosis when the instance is not
  // accepting form logins (API-key-only / SSO / wrong password) — a .do replay
  // cannot work at all in that state, and failing here beats a mystery 302 later.
  var session;
  try {
    session = await openFormSession(auth);
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      note:
        "Nothing written — the index-creator form could not be reached: " +
        errorMessage(e) +
        " An index can only be created by replaying that form (sys_index is " +
        "API-level-ACL 403 and sys_index_column does not exist), so there is no " +
        "fallback path from here. " +
        NOT_IN_UPDATE_SET,
    });
  }

  var formPath =
    params.formPath && params.formPath.trim()
      ? params.formPath.trim()
      : DEFAULT_INDEX_FORM_PATH;
  var page = await getFormPage(
    auth,
    session,
    formPath +
      (formPath.indexOf("?") === -1 ? "?" : "&") +
      "sysparm_table_name=" +
      encodeURIComponent(table),
  );
  if (page.status >= 300) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      httpStatus: page.status,
      note:
        "Nothing written — the index-creator page " +
        formPath +
        " returned HTTP " +
        page.status +
        (page.location ? " -> " + page.location : "") +
        ". The form was never rendered, so no create was attempted. " +
        NOT_IN_UPDATE_SET,
    });
  }

  // Overlay the capability values onto whatever the page itself submits, exactly as
  // createTable does: the harvested hidden fields (sysparm_ck above all) are the
  // page's, the five below are ours.
  var fields: Record<string, string> = {};
  var harvested = Object.keys(page.fields);
  for (var h = 0; h < harvested.length; h += 1) {
    fields[harvested[h]] = page.fields[harvested[h]];
  }
  fields["sysparm_ck"] = page.fields["sysparm_ck"] || session.ck;
  fields["sys_action"] = "create_index";
  fields["sysparm_table_name"] = table;
  fields["sysparm_index_table"] = table;
  fields["sysparm_fields"] = columns.join(",");
  if (unique) {
    // An unticked checkbox is ABSENT from a form submission, never "off" — sending
    // "off" would be a truthy value to a server that only tests for presence.
    fields["sysparm_unique_index_SKIP"] = "on";
  } else {
    delete fields["sysparm_unique_index_SKIP"];
  }
  if (params.accessMethod && params.accessMethod.trim()) {
    fields["sysparm_access_method"] = params.accessMethod.trim();
  }

  // Post where the page says to post. Only a same-instance relative action is
  // honoured — an absolute action would aim the authenticated session (cookies AND
  // the g_ck) at whatever host the page named.
  var action = page.formAction && page.formAction.trim();
  var postPath =
    action && action.indexOf("/") === 0 && action.indexOf("//") !== 0
      ? action
      : formPath;

  var posted;
  try {
    posted = await postForm(auth, session, postPath, fields);
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      note:
        "The index-creator POST failed in transit: " +
        errorMessage(e) +
        ". It is NOT known whether the index build started — read " +
        table +
        "'s indexes (dove-sn index-list) before retrying. " +
        NOT_IN_UPDATE_SET,
    });
  }

  // READ IT BACK. An index build is asynchronous on a populated table, so poll —
  // but bounded, and a poll that never sees the index is a FAILURE, not a caveat.
  var observed:
    | { name: string; columns: Array<string>; raw: string }
    | undefined;
  var lastError = "";
  for (var attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    try {
      observed = findMatch(await readIndexes(params.client, table), columns);
      lastError = "";
    } catch (e) {
      lastError = errorMessage(e);
    }
    if (observed) break;
  }

  var debugNote = params.debug
    ? " [debug: postPath=" +
      postPath +
      " formAction=" +
      (page.formAction || "(none)") +
      " harvestedFields=" +
      harvested.length +
      " httpStatus=" +
      posted.status +
      " location=" +
      (posted.location || "(none)") +
      "]"
    : "";

  if (!observed) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      httpStatus: posted.status,
      note:
        "The index-creator form was POSTed for " +
        spec +
        " (HTTP " +
        posted.status +
        "), but NO matching index appeared in v_db_index after " +
        attempts +
        " checks over ~" +
        Math.round((attempts * intervalMs) / 1000) +
        "s" +
        (lastError ? " (last read-back error: " + lastError + ")" : "") +
        ". Treat the index as NOT created: a form processor returning a page is not " +
        "evidence an ALTER ran, and a unique index cannot build over duplicate " +
        "values (EMPTY counts as a value — every empty row collides with every " +
        "other). Check the table's indexes and its data on " +
        instance +
        " before retrying. " +
        NOT_IN_UPDATE_SET +
        debugNote,
    });
  }

  return result({
    status: "created",
    created: true,
    table: table,
    columns: columns,
    instance: instance,
    name: observed.name,
    verified: true,
    httpStatus: posted.status,
    note:
      "Created a " +
      (unique ? "UNIQUE" : "non-unique") +
      " index on " +
      spec +
      " and READ IT BACK from v_db_index: '" +
      (observed.name || "(unnamed)") +
      "' over " +
      observed.raw +
      " on " +
      instance +
      ". NOT VERIFIED: that it REJECTS duplicates — v_db_index carries no uniqueness " +
      "field, so enforcement is provable only by a duplicate-insert test. " +
      NOT_IN_UPDATE_SET +
      debugNote,
  });
}
