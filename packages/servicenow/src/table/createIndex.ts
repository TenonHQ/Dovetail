/**
 * createIndex — create a database index on an EXISTING ServiceNow table, including
 * the COMPOSITE and NON-UNIQUE indexes `add-index` cannot build, by replaying the
 * two GlideAjax processor calls the platform's own Database Indexes dialog makes.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * AN INDEX **IS** CAPTURED IN AN UPDATE SET. The ScheduleCreator job that builds it
 * writes a `sys_update_xml` row (`type=Indexes`, name
 * `sys_index_<table>_<col>_<col>…`) into the SESSION USER'S CURRENT UPDATE SET — the
 * dialog's own confirmation text says "the index will be added to your current
 * update set", and it was read back live on tenonworkstudio 2026-10-08. That is why
 * this verb REQUIRES `updateSetSysId` on the live path: the current set is pinned to
 * the one asked for BEFORE the job is scheduled, and the captured row is read back
 * from THAT set afterwards. The physical index is still built per instance; the
 * captured record is what rebuilds it when the set is committed elsewhere.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * THE CONTRACT IS THE INSTANCE'S OWN, taken from a HAR of the Studio dialog
 * (`~/Downloads/indexing.har`, 2026-10-08) and the `dialog_index_create` UI page's
 * client script plus `table_columns.jsx`'s `indexConfirm()`, all read live. The
 * browser never submits the `index_creator_dialog` form (its `sys_action=create_index`
 * input is inert — the UI page has no processing script, which is why the previous
 * form-POST replay was a silent no-op). What it does is:
 *
 *   1. POST /xmlhttp.do  sysparm_processor=IndexCreatorErrorChecker
 *        sysparm_name=canCreate  sysparm_table_name=<t>  sysparm_field_names=a,b
 *        sysparm_unique=true|<empty>  sysparm_access_method=btree
 *      → <xml answer="{&quot;canCreate&quot;:true,&quot;errorCode&quot;:null}"/>
 *   2. POST /xmlhttp.do  sysparm_processor=ScheduleCreator
 *        sysparm_name=createSchedule  sysparm_table=<t>  sysparm_fields=a,b
 *        sysparm_access_method=btree  sysparm_unique=true|false
 *        sysparm_email=<empty = no notification>  sysparm_schedule_name=<empty>
 *      → an empty <xml/> envelope; the index build is a scheduled job.
 *
 * Both need the form-login session (cookie + X-UserToken). Basic auth NO-OPS on
 * xmlhttp.do (publishApp established that), so an API-key-only identity still cannot
 * run this verb — see TenonHQ/Dovetail#292.
 *
 * ONE IDENTITY. The pin and its read-back run through the REST client (API key when
 * one is configured); the build is scheduled by the form session (always SN_USER) and
 * captures into THAT user's current set. So the live path reads the REST caller's own
 * sys_user row first and REFUSES, before any write, unless it is the form-login user.
 *
 * THERE IS NO INDEX-NAME INPUT the dialog exposes (`sysparm_schedule_name` is wired
 * to a hidden `index_name` the index-creator page never populates); the platform
 * names the index after its leading column (live: columns
 * [sys_created_on;status;version_step;version] → index "sys_created_on"). A `name`
 * is therefore REFUSED rather than silently dropped.
 *
 * THE WRITE IS NEVER THE PROOF. After the schedule call the index is looked for in
 * `v_db_index` on a bounded poll, then the capture row is looked for in
 * `sys_update_xml` under the pinned set. No index → FAILED. Index but no capture row →
 * `created:true, captured:false` with "update-set-capture" in `unverified` — a real
 * state the caller must see, not a caveat folded into success.
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
  postForm,
  decodeHtmlEntities,
} from "./formSession";

/** A column is a plain identifier — rejects "phone;DROP", "a b", "a.b", "a^ORx". */
var COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
var SYS_ID = /^[0-9a-f]{32}$/i;
/** The GlideAjax endpoint every processor call goes to. */
export var XMLHTTP_PATH = "/xmlhttp.do";
/** The dialog's client-side default when the access-method selector is absent. */
export var DEFAULT_ACCESS_METHOD = "btree";
/** How many columns one index may span. The platform's own ceiling is lower than
 *  anything sane; this just stops an absurd request reaching the instance. */
var MAX_INDEX_COLUMNS = 16;
/** Read-back poll: an index build on a populated table is not instantaneous. */
var DEFAULT_POLL_ATTEMPTS = 10;
var DEFAULT_POLL_INTERVAL_MS = 3000;
var INDEX_ROW_LIMIT = 500;

/** Never provable from a read — see the header. */
var UNIQUENESS_UNVERIFIABLE = "uniqueness-enforced";
/** Set when the index exists but its sys_update_xml row was not found in the pinned set. */
var CAPTURE_UNVERIFIED = "update-set-capture";
/** The standing note every caller must carry forward. */
export var CAPTURE_NOTE =
  "A database index IS captured in an update set: the build job writes a " +
  "sys_update_xml row (type=Indexes) into the session user's CURRENT set, which this " +
  "verb pins to --update-set first. The physical index is still built per instance; " +
  "committing the set elsewhere rebuilds it there.";

export interface CreateIndexParams {
  /** REST client — used for the pin, the idempotency read and the read-back polls. */
  client: ServiceNowClient;
  /** The table to index, by NAME. */
  table: string;
  /** Ordered column list. Order matters to an index; it is preserved verbatim. */
  columns: Array<string>;
  /**
   * REQUIRED on the live path. The update set the index definition is captured into;
   * pinned as the user's current set before the build is scheduled, and the captured
   * row is read back from it afterwards. Must belong to the table's application scope.
   */
  updateSetSysId?: string;
  /**
   * REFUSED. The dialog exposes no name input — ServiceNow names the index itself.
   * Declared only so a caller can express it and be told why, rather than have it
   * silently ignored.
   */
  name?: string;
  /** Build a UNIQUE index. Default false (a plain index). */
  unique?: boolean;
  /** `sysparm_access_method`; defaults to "btree" exactly as the dialog's client JS does. */
  accessMethod?: string;
  /** REQUIRED to write. Without it this is a dry-run, whatever else is passed. */
  confirm?: boolean;
  /** Force a dry-run even with confirm:true. */
  dryRun?: boolean;
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
  /** True ONLY when the sys_update_xml capture row was READ BACK from the pinned set. */
  captured: boolean;
  /** The pinned update set (sys_id + name), or null before one was resolved. */
  updateSet: { sysId: string; name: string } | null;
  /**
   * Set ONLY when `captured` is false: the update set(s) OTHER than the pinned one that
   * hold a sys_update_xml row under the expected capture name, newest first — i.e.
   * where the capture actually landed. Empty when none was found (or not looked for).
   */
  captureFoundIn: Array<{ sysId: string; name: string }>;
  /** The host the write was aimed at — an index is per-instance, so this matters. */
  instance: string;
  /** Always includes "uniqueness-enforced"; adds "update-set-capture" when unproven. */
  unverified: Array<string>;
  /** HTTP status of the ScheduleCreator POST; 0 when none was sent. */
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
  updateSetSysId: string;
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
          "a query operator must never reach an encoded query or the processor's " +
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
      "index-create: refusing to set an index name — the platform's Database Indexes " +
        "dialog has NO name input; ServiceNow names the index itself (after the " +
        "leading column). Accepting '" +
        String(params.name).trim() +
        "' would mean reporting a name that is not the one on the instance. Drop " +
        "--name; the created index's real name is returned in `name`.",
    );
  }

  var updateSetSysId =
    params.updateSetSysId === undefined || params.updateSetSysId === null
      ? ""
      : String(params.updateSetSysId).trim();
  var live = params.confirm === true && params.dryRun !== true;
  if (live && !updateSetSysId) {
    throw new Error(
      "index-create: updateSetSysId is required on the live path — the index " +
        "definition is captured into the session user's CURRENT update set, so the " +
        "set must be named and pinned before the build is scheduled (a dry-run " +
        "needs none).",
    );
  }
  if (updateSetSysId && !SYS_ID.test(updateSetSysId)) {
    throw new Error(
      "index-create: updateSetSysId '" +
        updateSetSysId +
        "' is not a 32-char sys_id.",
    );
  }
  return { table: table, columns: columns, updateSetSysId: updateSetSysId };
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

/** The table's sys_scope sys_id, or "" when the table is unknown. */
async function readTableScope(
  client: ServiceNowClient,
  table: string,
): Promise<{ found: boolean; scopeSysId: string }> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_db_object",
    "name=" + encodeQueryValue(table),
    { limit: 1, fields: ["sys_id", "name", "sys_scope"] },
  );
  var safe = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < safe.length; i += 1) {
    var row = safe[i] && typeof safe[i] === "object" ? safe[i] : {};
    if (fieldToString(row.name) !== table) continue;
    return { found: true, scopeSysId: fieldToString(row.sys_scope) };
  }
  return { found: false, scopeSysId: "" };
}

/** The update set by sys_id: name, application scope sys_id, state. */
async function readUpdateSet(
  client: ServiceNowClient,
  sysId: string,
): Promise<{ found: boolean; name: string; application: string; state: string }> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_set",
    "sys_id=" + encodeQueryValue(sysId),
    { limit: 1, fields: ["sys_id", "name", "application", "state"] },
  );
  var safe = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < safe.length; i += 1) {
    var row = safe[i] && typeof safe[i] === "object" ? safe[i] : {};
    if (fieldToString(row.sys_id).toLowerCase() !== sysId.toLowerCase()) continue;
    return {
      found: true,
      name: fieldToString(row.name),
      application: fieldToString(row.application),
      state: fieldToString(row.state),
    };
  }
  return { found: false, name: "", application: "", state: "" };
}

/**
 * The capture row's name as the platform builds it:
 * `sys_index_<table>_<col>_<col>…` (live: sys_index_x_cadso_journey_instance_step_
 * sys_created_on_status_version_step_version).
 */
export function captureRowName(table: string, columns: Array<string>): string {
  return "sys_index_" + table + "_" + columns.join("_");
}

/** Look for the index's sys_update_xml row in the pinned set. */
async function readCaptureRow(
  client: ServiceNowClient,
  updateSetSysId: string,
  table: string,
  columns: Array<string>,
): Promise<{ found: boolean; name: string }> {
  var expected = captureRowName(table, columns);
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_xml",
    "update_set=" +
      encodeQueryValue(updateSetSysId) +
      "^type=Indexes^name=" +
      encodeQueryValue(expected),
    { limit: 5, fields: ["sys_id", "name", "type", "update_set"] },
  );
  var safe = Array.isArray(rows) ? rows : [];
  for (var i = 0; i < safe.length; i += 1) {
    var row = safe[i] && typeof safe[i] === "object" ? safe[i] : {};
    // Re-check both keys: an unknown column in an encoded query is silently ignored
    // and would return the unfiltered set.
    if (fieldToString(row.name) !== expected) continue;
    var set = row.update_set;
    var setId =
      set && typeof set === "object" && "value" in (set as object)
        ? fieldToString((set as { value: unknown }).value)
        : fieldToString(set);
    if (setId && setId.toLowerCase() !== updateSetSysId.toLowerCase()) continue;
    return { found: true, name: expected };
  }
  return { found: false, name: expected };
}

/** How many other sets a missing capture is reported in — enough to locate it. */
var CAPTURE_ELSEWHERE_LIMIT = 5;

/**
 * When the capture row is NOT in the pinned set, find where it DID land: the same
 * capture name searched across every update set, newest first. Each set is named
 * best-effort (an unreadable set keeps its sys_id with an empty name).
 */
async function findCaptureElsewhere(
  client: ServiceNowClient,
  pinnedSetSysId: string,
  table: string,
  columns: Array<string>,
): Promise<Array<{ sysId: string; name: string }>> {
  var expected = captureRowName(table, columns);
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_xml",
    "type=Indexes^name=" +
      encodeQueryValue(expected) +
      "^ORDERBYDESCsys_created_on",
    {
      limit: CAPTURE_ELSEWHERE_LIMIT,
      fields: ["sys_id", "name", "type", "update_set", "sys_created_on"],
    },
  );
  var safe = Array.isArray(rows) ? rows : [];
  var out: Array<{ sysId: string; name: string }> = [];
  var seen: Record<string, boolean> = {};
  for (var i = 0; i < safe.length; i += 1) {
    var row = safe[i] && typeof safe[i] === "object" ? safe[i] : {};
    // Re-check the name: an encoded query the instance did not understand returns
    // the unfiltered set, and an unrelated row must never be reported as "the capture".
    if (fieldToString(row.name) !== expected) continue;
    var setId = fieldToString(row.update_set).trim();
    if (!SYS_ID.test(setId)) continue;
    var key = setId.toLowerCase();
    if (key === pinnedSetSysId.toLowerCase() || seen[key]) continue;
    seen[key] = true;
    var setName = "";
    try {
      setName = (await readUpdateSet(client, setId)).name;
    } catch (e) {
      setName = "";
    }
    out.push({ sysId: setId, name: setName });
  }
  return out;
}

/**
 * The user the REST client is authenticated as — which is NOT necessarily the form
 * login: the REST client prefers an inbound API key (whose identity is the key's
 * user), while the form session always logs in as SN_USER. Resolved by asking the
 * instance for the CALLER's own sys_user row (`gs.getUserID()` evaluated server-side
 * for the REST identity). Anything but exactly one row with a user_name is reported as
 * an error, never guessed at: an unevaluated or ignored filter returns zero rows or
 * the unfiltered table.
 */
async function readRestIdentity(
  client: ServiceNowClient,
): Promise<{ userName: string; error: string }> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_user",
    "sys_id=javascript:gs.getUserID()",
    { limit: 2, fields: ["sys_id", "user_name"] },
  );
  var safe = Array.isArray(rows) ? rows : [];
  if (safe.length !== 1) {
    return {
      userName: "",
      error:
        "the caller's own sys_user row read back as " +
        safe.length +
        " rows (expected exactly 1)",
    };
  }
  var row = safe[0] && typeof safe[0] === "object" ? safe[0] : {};
  var userName = fieldToString(row.user_name).trim();
  if (!userName) {
    return { userName: "", error: "the caller's sys_user row has no user_name" };
  }
  return { userName: userName, error: "" };
}

/**
 * Parse the `answer` attribute out of a GlideAjax envelope
 * (`<xml answer="…"/>`). Returns "" when absent — the caller decides what that means.
 */
export function parseAjaxAnswer(xml: string): string {
  if (typeof xml !== "string" || !xml) return "";
  var m = /\banswer\s*=\s*"([^"]*)"/.exec(xml);
  return m ? decodeHtmlEntities(m[1]) : "";
}

/** The processor's canCreate verdict, defensively parsed. */
export function parseCanCreate(answer: string): {
  canCreate: boolean;
  errorCode: string;
  parseError: string;
} {
  if (!answer) {
    return { canCreate: false, errorCode: "", parseError: "empty answer" };
  }
  var parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch (e) {
    return {
      canCreate: false,
      errorCode: "",
      parseError: "answer is not JSON: " + answer.slice(0, 200),
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      canCreate: false,
      errorCode: "",
      parseError: "answer is not an object: " + answer.slice(0, 200),
    };
  }
  var obj = parsed as Record<string, unknown>;
  var code = obj.errorCode;
  return {
    canCreate: obj.canCreate === true,
    errorCode:
      code === null || code === undefined ? "" : String(code),
    parseError: "",
  };
}

/** The exact field map IndexCreatorErrorChecker.canCreate receives (HAR-verified). */
export function buildCanCreateFields(p: {
  table: string;
  columns: Array<string>;
  unique: boolean;
  accessMethod: string;
}): Record<string, string> {
  return {
    sysparm_processor: "IndexCreatorErrorChecker",
    sysparm_scope: "global",
    sysparm_want_session_messages: "true",
    sysparm_name: "canCreate",
    sysparm_table_name: p.table,
    sysparm_field_names: p.columns.join(","),
    // The dialog sends the checkbox's `checked` straight through: "true" or empty.
    sysparm_unique: p.unique ? "true" : "",
    sysparm_access_method: p.accessMethod,
  };
}

/** The exact field map ScheduleCreator.createSchedule receives (HAR-verified). */
export function buildCreateScheduleFields(p: {
  table: string;
  columns: Array<string>;
  unique: boolean;
  accessMethod: string;
}): Record<string, string> {
  return {
    sysparm_processor: "ScheduleCreator",
    sysparm_scope: "global",
    sysparm_want_session_messages: "true",
    sysparm_name: "createSchedule",
    sysparm_table: p.table,
    sysparm_fields: p.columns.join(","),
    sysparm_access_method: p.accessMethod,
    // Here the dialog normalises to the strings "true" / "false".
    sysparm_unique: p.unique ? "true" : "false",
    // Empty email = the "Do not notify me" radio; empty name = platform-named index.
    sysparm_email: "",
    sysparm_schedule_name: "",
  };
}

/**
 * Read the current set out of whatever shape the currentUpdateSet op answers with:
 * { sys_id, name }, { sysId, name }, or either nested under update_set / updateSet /
 * result. Missing pieces come back as "" rather than throwing.
 */
export function readCurrentSet(raw: unknown): { sysId: string; name: string } {
  var out = { sysId: "", name: "" };
  if (!raw || typeof raw !== "object") return out;
  var obj = raw as Record<string, unknown>;
  var nestedKeys = ["update_set", "updateSet", "result", "current"];
  for (var n = 0; n < nestedKeys.length; n += 1) {
    var nested = obj[nestedKeys[n]];
    if (nested && typeof nested === "object") {
      var inner = readCurrentSet(nested);
      if (inner.sysId || inner.name) return inner;
    }
  }
  var idKeys = ["sys_id", "sysId", "sysid", "id", "value"];
  for (var i = 0; i < idKeys.length; i += 1) {
    var v = obj[idKeys[i]];
    if (typeof v === "string" && SYS_ID.test(v.trim())) {
      out.sysId = v.trim();
      break;
    }
  }
  var nameKeys = ["name", "display_value", "displayValue"];
  for (var k = 0; k < nameKeys.length; k += 1) {
    var nv = obj[nameKeys[k]];
    if (typeof nv === "string" && nv.trim()) {
      out.name = nv.trim();
      break;
    }
  }
  return out;
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
  var unverified = [UNIQUENESS_UNVERIFIABLE];
  if (partial.captured !== true) unverified.push(CAPTURE_UNVERIFIED);
  return {
    status: partial.status,
    created: partial.created === true,
    table: partial.table,
    name: partial.name ? partial.name : "",
    columns: partial.columns.slice(),
    verified: partial.verified === true,
    captured: partial.captured === true,
    updateSet: partial.updateSet ? partial.updateSet : null,
    captureFoundIn:
      partial.captured !== true && Array.isArray(partial.captureFoundIn)
        ? partial.captureFoundIn.slice()
        : [],
    instance: partial.instance,
    unverified: unverified,
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
  var updateSetSysId = checked.updateSetSysId;
  var unique = params.unique === true;
  var accessMethod =
    params.accessMethod && params.accessMethod.trim()
      ? params.accessMethod.trim()
      : DEFAULT_ACCESS_METHOD;
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
      updateSet: updateSetSysId ? { sysId: updateSetSysId, name: "" } : null,
      note:
        "dry-run: nothing sent and nothing read. Would pin update set " +
        (updateSetSysId || "(none given — required on the live path)") +
        " as the current set, check IndexCreatorErrorChecker.canCreate, then " +
        "schedule a " +
        (unique ? "UNIQUE" : "non-unique") +
        " " +
        accessMethod +
        " index on " +
        spec +
        " via ScheduleCreator.createSchedule, poll v_db_index up to " +
        attempts +
        " times, " +
        intervalMs +
        " ms apart, and read the capture row back from sys_update_xml. A dry-run " +
        "does NOT check that the table, columns or update set exist, and does NOT " +
        "check whether the index is already there — the live path does all of that " +
        "before it writes. Pass confirm:true to write. " +
        CAPTURE_NOTE,
    });
  }

  // ---- LIVE PATH ------------------------------------------------------------
  var auth = resolveFormAuth({
    instance: params.instance,
    user: params.user,
    password: params.password,
  });
  var instance = auth.host;

  // TARGET CHECKS. The table must exist and the update set must be in that table's
  // application scope — a scope mismatch is the classic wrong-scope slip and the
  // platform would capture the row into whatever scope the set belongs to.
  var tableInfo: { found: boolean; scopeSysId: string };
  var setInfo: { found: boolean; name: string; application: string; state: string };
  try {
    tableInfo = await readTableScope(params.client, table);
    setInfo = await readUpdateSet(params.client, updateSetSysId);
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      note:
        "Refusing to write: the table or update set could not be read, so the " +
        "capture target is UNKNOWN: " +
        errorMessage(e) +
        ". Nothing was sent. " +
        CAPTURE_NOTE,
    });
  }
  if (!tableInfo.found) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      note:
        "Nothing written — table '" +
        table +
        "' was not found in sys_db_object on " +
        instance +
        ". " +
        CAPTURE_NOTE,
    });
  }
  if (!setInfo.found) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      note:
        "Nothing written — update set " +
        updateSetSysId +
        " was not found in sys_update_set on " +
        instance +
        ". " +
        CAPTURE_NOTE,
    });
  }
  var updateSet = { sysId: updateSetSysId, name: setInfo.name };
  if (
    tableInfo.scopeSysId &&
    setInfo.application &&
    tableInfo.scopeSysId.toLowerCase() !== setInfo.application.toLowerCase()
  ) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "Nothing written — update set '" +
        setInfo.name +
        "' belongs to application " +
        setInfo.application +
        " but table " +
        table +
        " is owned by " +
        tableInfo.scopeSysId +
        ". The index capture would land in the wrong scope. Pick a set in the " +
        "table's own application. " +
        CAPTURE_NOTE,
    });
  }
  if (setInfo.state && setInfo.state !== "in progress") {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "Nothing written — update set '" +
        setInfo.name +
        "' is '" +
        setInfo.state +
        "', not 'in progress'; the platform would not capture into it. " +
        CAPTURE_NOTE,
    });
  }

  // IDEMPOTENCY. An index over exactly these columns already present means there is
  // nothing to do — re-running the job would at best be a no-op and at worst leave a
  // second, redundant index on the table.
  var existing: Array<{ name: string; columns: Array<string>; raw: string }>;
  try {
    existing = await readIndexes(params.client, table);
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "Refusing to write: v_db_index could not be read, so whether this index " +
        "already exists is UNKNOWN — and creating a duplicate index is not something " +
        "to do blind: " +
        errorMessage(e) +
        ". Nothing was sent. " +
        CAPTURE_NOTE,
    });
  }
  var already = findMatch(existing, columns);
  if (already) {
    return result({
      status: "already-exists",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
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
        "duplicate-insert test rather than inferring it from this row. Its capture " +
        "row (if any) was NOT looked for in " +
        setInfo.name +
        ". " +
        CAPTURE_NOTE,
    });
  }

  // ONE IDENTITY OR NOTHING. The pin and its read-back below go through the REST
  // client, which authenticates with the API key when one is configured; the build is
  // scheduled by a form session that always logs in as the basic-auth user. The job
  // captures into the FORM user's current set, so when the two identities differ the
  // pin "reads back" for one user while the capture lands in the other user's set.
  // Prove they are the same user BEFORE the first write, or do not write at all.
  var restIdentity: { userName: string; error: string };
  try {
    restIdentity = await readRestIdentity(params.client);
  } catch (e) {
    restIdentity = { userName: "", error: errorMessage(e) };
  }
  var formUser = String(auth.user || "").trim();
  if (restIdentity.error) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "Refusing to write: the REST client's identity could not be established (" +
        restIdentity.error +
        "), so it cannot be shown to be the form-login user '" +
        formUser +
        "' that schedules the build. The pin would be proven for one user while the " +
        "capture lands in another's current update set. Nothing was sent. " +
        CAPTURE_NOTE,
    });
  }
  if (restIdentity.userName.toLowerCase() !== formUser.toLowerCase()) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "Refusing to write: the REST client is authenticated as '" +
        restIdentity.userName +
        "' (it would pin and read back the update set) but the index build is " +
        "scheduled by a form session logged in as '" +
        formUser +
        "'. The build job captures into the FORM user's current update set, which " +
        "the pin never touches — the capture would land in whatever set '" +
        formUser +
        "' has current, not in '" +
        setInfo.name +
        "'. Run with ONE identity — the REST client must authenticate as the same " +
        "user the form session logs in as (e.g. basic auth as that user, with no API " +
        "key, for this run). Nothing was sent. " +
        CAPTURE_NOTE,
    });
  }

  // PIN THE UPDATE SET. Dovetail's own changeUpdateSet op sets the user's current set
  // (the user preference GlideUpdateSet reads), which is what the scheduled build job
  // captures into. Done BEFORE the form session opens so the login inherits it, and
  // verified by reading the current set back — a pin that did not take is a wrong-set
  // capture waiting to happen, so it stops the run.
  try {
    await params.client.claude.changeUpdateSet({ sysId: updateSetSysId });
    var current: unknown = await params.client.claude.currentUpdateSet();
    var readBack = readCurrentSet(current);
    var pinned = readBack.sysId
      ? readBack.sysId.toLowerCase() === updateSetSysId.toLowerCase()
      : // The op may answer with the name only — then the name is the evidence.
        !!readBack.name && readBack.name === setInfo.name;
    if (!pinned) {
      return result({
        status: "failed",
        table: table,
        columns: columns,
        instance: instance,
        updateSet: updateSet,
        note:
          "Nothing scheduled — changeUpdateSet was called for " +
          updateSetSysId +
          " but the current set read back as '" +
          (readBack.name || readBack.sysId || "(none)") +
          "'. The build job would have captured into the wrong set. " +
          CAPTURE_NOTE +
          (params.debug
            ? " [debug: currentUpdateSet=" + JSON.stringify(current).slice(0, 300) + "]"
            : ""),
      });
    }
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "Nothing scheduled — the update set could not be pinned as current: " +
        errorMessage(e) +
        ". " +
        CAPTURE_NOTE,
    });
  }

  // Open the form session. This THROWS with a diagnosis when the instance is not
  // accepting form logins (API-key-only / SSO / wrong password) — xmlhttp.do ignores
  // Basic auth, and failing here beats a silent no-op later.
  var session;
  try {
    session = await openFormSession(auth);
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "Nothing scheduled — a form session could not be opened: " +
        errorMessage(e) +
        " The index processors (IndexCreatorErrorChecker, ScheduleCreator) run on " +
        "xmlhttp.do, which needs a logged-in session with X-UserToken; Basic auth " +
        "no-ops there, so there is no fallback path from here. " +
        CAPTURE_NOTE,
    });
  }

  // PRE-FLIGHT — the dialog's own validation. A refusal here is the platform's
  // verdict (bad column, columnstore rules, …) carried back verbatim.
  var canFields = buildCanCreateFields({
    table: table,
    columns: columns,
    unique: unique,
    accessMethod: accessMethod,
  });
  var canRes;
  try {
    canRes = await postForm(auth, session, XMLHTTP_PATH, canFields);
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "Nothing scheduled — IndexCreatorErrorChecker.canCreate failed in transit: " +
        errorMessage(e) +
        ". " +
        CAPTURE_NOTE,
    });
  }
  var verdict = parseCanCreate(parseAjaxAnswer(canRes.body));
  if (canRes.status < 200 || canRes.status >= 300 || verdict.parseError) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      httpStatus: canRes.status,
      note:
        "Nothing scheduled — IndexCreatorErrorChecker.canCreate returned HTTP " +
        canRes.status +
        (canRes.location ? " -> " + canRes.location : "") +
        (verdict.parseError ? " (" + verdict.parseError + ")" : "") +
        ". A redirect here means the session is not logged in. " +
        CAPTURE_NOTE,
    });
  }
  if (!verdict.canCreate) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      httpStatus: canRes.status,
      note:
        "Nothing scheduled — the platform refused the index on " +
        spec +
        ": canCreate=false" +
        (verdict.errorCode ? ", errorCode='" + verdict.errorCode + "'" : "") +
        ". " +
        CAPTURE_NOTE,
    });
  }

  // CREATE — schedules the build job.
  var createFields = buildCreateScheduleFields({
    table: table,
    columns: columns,
    unique: unique,
    accessMethod: accessMethod,
  });
  var posted;
  try {
    posted = await postForm(auth, session, XMLHTTP_PATH, createFields);
  } catch (e) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      note:
        "ScheduleCreator.createSchedule failed in transit: " +
        errorMessage(e) +
        ". It is NOT known whether the build was scheduled — read " +
        table +
        "'s indexes (dove-sn index-list) before retrying. " +
        CAPTURE_NOTE,
    });
  }
  if (posted.status < 200 || posted.status >= 300) {
    return result({
      status: "failed",
      table: table,
      columns: columns,
      instance: instance,
      updateSet: updateSet,
      httpStatus: posted.status,
      note:
        "ScheduleCreator.createSchedule returned HTTP " +
        posted.status +
        (posted.location ? " -> " + posted.location : "") +
        " for " +
        spec +
        ". Treat the index as NOT scheduled; read " +
        table +
        "'s indexes (dove-sn index-list) before retrying. " +
        CAPTURE_NOTE,
    });
  }

  // READ IT BACK. The build is a scheduled job, so poll — but bounded, and a poll
  // that never sees the index is a FAILURE, not a caveat.
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
    ? " [debug: canCreateHttp=" +
      canRes.status +
      " scheduleHttp=" +
      posted.status +
      " scheduleBody=" +
      String(posted.body || "").slice(0, 120) +
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
      updateSet: updateSet,
      httpStatus: posted.status,
      note:
        "ScheduleCreator.createSchedule was accepted for " +
        spec +
        " (HTTP " +
        posted.status +
        "), but NO matching index appeared in v_db_index after " +
        attempts +
        " checks over ~" +
        Math.round((attempts * intervalMs) / 1000) +
        "s" +
        (lastError ? " (last read-back error: " + lastError + ")" : "") +
        ". Treat the index as NOT created: an accepted schedule is not evidence the " +
        "ALTER ran, and a unique index cannot build over duplicate values (EMPTY " +
        "counts as a value — every empty row collides with every other). Check the " +
        "table's indexes and its data on " +
        instance +
        " before retrying. " +
        CAPTURE_NOTE +
        debugNote,
    });
  }

  // CAPTURE READ-BACK. The job writes the sys_update_xml row as it finishes; look
  // for it in the pinned set.
  var capture = { found: false, name: captureRowName(table, columns) };
  var captureError = "";
  try {
    capture = await readCaptureRow(params.client, updateSetSysId, table, columns);
  } catch (e) {
    captureError = errorMessage(e);
  }

  // NOT IN THE PINNED SET? Then say where it DID land. A capture in another set is
  // the wrong-set outcome this verb exists to prevent, and the caller has to move it
  // before promoting — "not found here" alone would leave them hunting for it.
  var elsewhere: Array<{ sysId: string; name: string }> = [];
  var elsewhereError = "";
  if (!capture.found) {
    try {
      elsewhere = await findCaptureElsewhere(
        params.client,
        updateSetSysId,
        table,
        columns,
      );
    } catch (e) {
      elsewhereError = errorMessage(e);
    }
  }
  var elsewhereNote = capture.found
    ? ""
    : elsewhere.length > 0
      ? "It WAS found in " +
        elsewhere
          .map(function (s) {
            return "update set '" + (s.name || "(name unreadable)") + "' (" + s.sysId + ")";
          })
          .join(", ") +
        " — the capture landed in the WRONG set; move it into '" +
        setInfo.name +
        "' before promoting. "
      : elsewhereError
        ? "Where it landed instead could not be checked (" + elsewhereError + "). "
        : "No sys_update_xml row by that name exists in ANY update set. ";

  return result({
    status: "created",
    created: true,
    table: table,
    columns: columns,
    instance: instance,
    updateSet: updateSet,
    name: observed.name,
    verified: true,
    captured: capture.found,
    captureFoundIn: elsewhere,
    httpStatus: posted.status,
    note:
      "Created a " +
      (unique ? "UNIQUE" : "non-unique") +
      " " +
      accessMethod +
      " index on " +
      spec +
      " and READ IT BACK from v_db_index: '" +
      (observed.name || "(unnamed)") +
      "' over " +
      observed.raw +
      " on " +
      instance +
      ". " +
      (capture.found
        ? "Capture row '" +
          capture.name +
          "' READ BACK in update set '" +
          setInfo.name +
          "'. "
        : "NOT VERIFIED: capture row '" +
          capture.name +
          "' was NOT found in update set '" +
          setInfo.name +
          "'" +
          (captureError ? " (" + captureError + ")" : "") +
          " — the index exists on this instance but its definition may not " +
          "travel; check sys_update_xml before promoting. " +
          elsewhereNote) +
      "NOT VERIFIED: that it REJECTS duplicates — v_db_index carries no uniqueness " +
      "field, so enforcement is provable only by a duplicate-insert test. " +
      CAPTURE_NOTE +
      debugNote,
  });
}
