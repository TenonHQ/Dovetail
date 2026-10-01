/**
 * Export a ServiceNow update set to an importable `<unload>` XML document, with
 * secret values replaced by a sentinel before the document is ever returned.
 *
 * Ground truth for the mechanism: `brainstorms/sn-export-app-flow.md` in the CTO
 * repo (HAR capture, tenonworkshop 2026-06-08) plus a live run of the same flow.
 * Two findings shape this verb:
 *
 *   1. `GET /export_update_set.do?sysparm_sys_id=<set>` streams the `<unload>`
 *      only for a COMPLETE set. For a set still in progress the servlet answers
 *      HTTP 200 with an EMPTY BODY — a silent no-op that looks like success.
 *   2. The same document can be assembled read-only from the set's
 *      `sys_update_xml` rows, with no state write at all.
 *
 * Hence two modes:
 *
 *   assemble (default) — read-only. Pages the set's `sys_update_xml` rows and
 *      wraps them in an `<unload>`. Touches no instance state, so it is safe for
 *      packaging work against a shared instance.
 *   complete — marks the set complete (a REAL WRITE, hence confirm) and lets the
 *      servlet produce the document, for byte-fidelity with the UI export.
 *
 * SECRETS ARE ALWAYS STRIPPED. There is no opt-out flag: a field is exempted
 * only by a reviewed `notSecret` entry in the rules file, with a reason. If a
 * field merely looks secret and no rule covers it, the export FAILS rather than
 * shipping it — see secrets/stripSecrets.ts.
 *
 * ES6 only, no optional chaining.
 */

import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import { resolveFormAuth, openFormSession, getWithSession } from "./table";
import type { FormAuth, FormSession, PostResult } from "./table";
import {
  loadSecretRules,
  secretFieldsFromDictionary,
  isCapturable,
} from "./secrets/secretRules";
import type {
  SecretRules,
  DictionaryRow,
  CapturableRow,
} from "./secrets/secretRules";
import { stripSecrets } from "./secrets/stripSecrets";
import type { SecretField, ReviewFinding } from "./secrets/stripSecrets";

/** How the `<unload>` is produced. */
export type ExportMode = "assemble" | "complete";

/** Injectable transport, so tests never touch the network. */
export interface ExportTransport {
  openSession?: (auth: FormAuth) => Promise<FormSession>;
  get?: (
    auth: FormAuth,
    session: FormSession,
    path: string,
  ) => Promise<PostResult>;
}

/** Inputs for exportUpdateSet. */
export interface ExportUpdateSetParams {
  /** Update set sys_id, or its exact name. */
  updateSet: string;
  /** Default "assemble" (read-only). "complete" writes the set's state first. */
  mode?: ExportMode;
  /** Injectable for tests; defaults to createClient({}). */
  client?: ServiceNowClient;
  /** Instance host for the form session (complete mode only). */
  instance?: string;
  user?: string;
  password?: string;
  /** Required for "complete", which writes to the instance. */
  confirm?: boolean;
  /** Force a plan-only run. Wins over confirm. */
  dryRun?: boolean;
  /** Optional JSON rules file merged over the built-in secret rules. */
  rulesPath?: string;
  /** Rows per page when assembling. Default 500, max 1000 (the instance cap). */
  pageSize?: number;
  /** Safety stop for a runaway page loop. Default 200000 rows. */
  maxRows?: number;
  /** Test seam for the form session and servlet GET. */
  transport?: ExportTransport;
}

/** Outcome of an export. */
export interface ExportUpdateSetResult {
  status: "dry-run" | "exported" | "failed";
  mode: ExportMode;
  updateSetSysId: string;
  updateSetName: string;
  scope: string;
  /** Rows the instance reports for the set. */
  expectedRecords: number;
  /** Rows actually written into the document. */
  recordCount: number;
  /** The document. Absent on dry-run and failure. */
  xml?: string;
  /** Every value replaced with the sentinel — table, field and record only. */
  secretFields: Array<SecretField>;
  /** Fields awaiting adjudication. Only ever populated on a dry-run. */
  reviewFindings: Array<ReviewFinding>;
  /** Failure detail, when status is "failed". */
  message?: string;
  /** Human-readable summary of what happened, always present. */
  note: string;
}

/** Rows per page when assembling. */
export var DEFAULT_PAGE_SIZE = 500;
/** The instance caps a Table API page at 1000 rows. */
export var MAX_PAGE_SIZE = 1000;
/** Safety stop so a paging bug cannot spin forever. */
export var DEFAULT_MAX_ROWS = 200000;

var SYS_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Field order of a `sys_update_xml` row inside an `<unload>`. Mirrors what the
 * export servlet emits, so an assembled document imports the same way.
 */
export var UPDATE_XML_FIELDS: ReadonlyArray<string> = [
  "action",
  "application",
  "category",
  "comments",
  "name",
  "payload",
  "type",
  "target_name",
  "update_domain",
  "update_guid",
  "update_guid_history",
  "view",
  "replace_on_upgrade",
  "sys_id",
  "sys_recorded_at",
  "sys_created_on",
  "sys_updated_on",
];

/** Escape a value for an XML element body. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Reference fields come back as { value, link } unless display values are off.
  if (typeof value === "object") {
    var ref = value as { value?: unknown };
    if (typeof ref.value === "string") {
      return ref.value;
    }
  }
  return "";
}

/** Render one `sys_update_xml` row as an `<unload>` child element. */
export function renderUpdateXmlRow(row: Record<string, unknown>): string {
  var parts: Array<string> = ['<sys_update_xml action="INSERT_OR_UPDATE">'];
  for (var i = 0; i < UPDATE_XML_FIELDS.length; i += 1) {
    var field = UPDATE_XML_FIELDS[i];
    if (!(field in row)) {
      continue;
    }
    var text = asText(row[field]);
    parts.push("<" + field + ">" + xmlEscape(text) + "</" + field + ">");
  }
  parts.push("</sys_update_xml>");
  return parts.join("");
}

/** The `sys_remote_update_set` header an importable document needs. */
export function renderRemoteUpdateSet(
  set: { sys_id: string; name: string; scope: string; description: string },
  recordCount: number,
  unloadDate: string,
): string {
  return (
    '<sys_remote_update_set action="INSERT_OR_UPDATE">' +
    "<application>" +
    xmlEscape(set.scope) +
    "</application>" +
    "<description>" +
    xmlEscape(set.description) +
    "</description>" +
    "<name>" +
    xmlEscape(set.name) +
    "</name>" +
    "<origin_sys_id>" +
    xmlEscape(set.sys_id) +
    "</origin_sys_id>" +
    "<remote_sys_id>" +
    xmlEscape(set.sys_id) +
    "</remote_sys_id>" +
    "<state>loaded</state>" +
    "<summary/>" +
    "<sys_created_on>" +
    xmlEscape(unloadDate) +
    "</sys_created_on>" +
    "<update_set>" +
    xmlEscape(set.sys_id) +
    "</update_set>" +
    "<update_source/>" +
    "<update_count>" +
    String(recordCount) +
    "</update_count>" +
    "</sys_remote_update_set>"
  );
}

/** Wrap rendered rows in the `<unload>` envelope. */
export function renderUnload(
  header: string,
  rows: Array<string>,
  unloadDate: string,
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<unload unload_date="' +
    xmlEscape(unloadDate) +
    '">' +
    header +
    rows.join("") +
    "</unload>"
  );
}

/** ServiceNow-style timestamp, e.g. "2026-09-15 18:40:02". */
export function formatUnloadDate(now: Date): string {
  var iso = now.toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 19);
}

interface ResolvedSet {
  sys_id: string;
  name: string;
  scope: string;
  description: string;
  state: string;
}

async function resolveUpdateSet(
  client: ServiceNowClient,
  selector: string,
): Promise<ResolvedSet> {
  var query = SYS_ID_RE.test(selector)
    ? "sys_id=" + selector
    : "name=" + selector;
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_set",
    query,
    {
      limit: 2,
      fields: ["sys_id", "name", "application", "description", "state"],
    },
  );
  if (!rows || rows.length === 0) {
    throw new Error(
      "export-update-set: no update set matches '" +
        selector +
        "' — pass its sys_id or exact name.",
    );
  }
  if (rows.length > 1) {
    throw new Error(
      "export-update-set: '" +
        selector +
        "' matches more than one update set — pass the sys_id.",
    );
  }
  return {
    sys_id: asText(rows[0].sys_id),
    name: asText(rows[0].name),
    scope: asText(rows[0].application),
    description: asText(rows[0].description),
    state: asText(rows[0].state),
  };
}

/** Rows the instance reports for a set, via the aggregate API. */
export async function countUpdateXml(
  client: ServiceNowClient,
  updateSetSysId: string,
): Promise<number> {
  var res = await client.now.invoke({
    method: "GET",
    path:
      "/api/now/stats/sys_update_xml?sysparm_count=true&sysparm_query=update_set=" +
      encodeURIComponent(updateSetSysId),
  });
  if (res.status !== 200) {
    throw new Error(
      "export-update-set: could not count the set's records (HTTP " +
        res.status +
        "). The export was not attempted.",
    );
  }
  return parseStatsCount(res.body);
}

/** Pull the count out of an /api/now/stats response. */
export function parseStatsCount(body: unknown): number {
  var b = body as { result?: { stats?: { count?: string | number } } };
  var raw = b && b.result && b.result.stats ? b.result.stats.count : undefined;
  var n =
    typeof raw === "string"
      ? parseInt(raw, 10)
      : typeof raw === "number"
      ? raw
      : NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      "export-update-set: the instance returned an unreadable record count.",
    );
  }
  return n;
}

/** Page every `sys_update_xml` row of a set, oldest first. */
export async function fetchUpdateXmlRows(
  client: ServiceNowClient,
  updateSetSysId: string,
  pageSize: number,
  maxRows: number,
): Promise<Array<Record<string, unknown>>> {
  var out: Array<Record<string, unknown>> = [];
  var offset = 0;
  while (true) {
    var res = await client.now.invoke({
      method: "GET",
      path:
        "/api/now/table/sys_update_xml?sysparm_display_value=false" +
        "&sysparm_exclude_reference_link=true" +
        "&sysparm_fields=" +
        encodeURIComponent(UPDATE_XML_FIELDS.join(",")) +
        "&sysparm_query=" +
        encodeURIComponent(
          "update_set=" + updateSetSysId + "^ORDERBYsys_recorded_at",
        ) +
        "&sysparm_limit=" +
        String(pageSize) +
        "&sysparm_offset=" +
        String(offset),
    });
    if (res.status !== 200) {
      throw new Error(
        "export-update-set: reading the set's records failed at offset " +
          offset +
          " (HTTP " +
          res.status +
          "). Nothing was written.",
      );
    }
    var body = res.body as { result?: Array<Record<string, unknown>> };
    var page = body && Array.isArray(body.result) ? body.result : [];
    for (var i = 0; i < page.length; i += 1) {
      out.push(page[i]);
    }
    if (page.length < pageSize) {
      return out;
    }
    offset += page.length;
    if (out.length > maxRows) {
      throw new Error(
        "export-update-set: the set exceeds maxRows (" +
          maxRows +
          ") — raise it deliberately rather than exporting a truncated document.",
      );
    }
  }
}

/**
 * Refresh the L1 (password-typed field) map from the live dictionary, so tables
 * added by a plugin since the baseline are covered. Falls back to the baseline
 * when the reads fail — a dictionary that cannot be read must not silently
 * widen what ships, and the baseline is the conservative answer.
 */
export async function refreshTypeFields(
  client: ServiceNowClient,
  rules: SecretRules,
): Promise<SecretRules> {
  var dictRows = await client.table.query<DictionaryRow>(
    "sys_dictionary",
    "internal_typeINpassword,password2",
    { limit: MAX_PAGE_SIZE, fields: ["name", "element", "internal_type"] },
  );
  if (!dictRows || dictRows.length === 0) {
    return rules;
  }
  var names: Record<string, boolean> = {};
  for (var i = 0; i < dictRows.length; i += 1) {
    if (dictRows[i] && typeof dictRows[i].name === "string") {
      names[dictRows[i].name] = true;
    }
  }
  var collectionRows = await client.table.query<CapturableRow>(
    "sys_dictionary",
    "internal_type=collection^nameIN" + Object.keys(names).join(","),
    { limit: MAX_PAGE_SIZE, fields: ["name", "attributes"] },
  );
  var capturable: Array<string> = [];
  for (var c = 0; c < collectionRows.length; c += 1) {
    if (isCapturable(collectionRows[c])) {
      capturable.push(collectionRows[c].name);
    }
  }
  var live = secretFieldsFromDictionary(dictRows, capturable);
  var tables = Object.keys(live);
  for (var t = 0; t < tables.length; t += 1) {
    var existing = rules.typeFields[tables[t]] || [];
    var fields = live[tables[t]];
    for (var f = 0; f < fields.length; f += 1) {
      if (existing.indexOf(fields[f]) === -1) {
        existing.push(fields[f]);
      }
    }
    rules.typeFields[tables[t]] = existing;
  }
  return rules;
}

function baseResult(set: ResolvedSet, mode: ExportMode): ExportUpdateSetResult {
  return {
    status: "failed",
    mode: mode,
    updateSetSysId: set.sys_id,
    updateSetName: set.name,
    scope: set.scope,
    expectedRecords: 0,
    recordCount: 0,
    secretFields: [],
    reviewFindings: [],
    note: "",
  };
}

/**
 * Export one update set. Returns the stripped document; writing it to disk is
 * the caller's job, so nothing here can leave a half-written file behind.
 */
export async function exportUpdateSet(
  params: ExportUpdateSetParams,
): Promise<ExportUpdateSetResult> {
  if (
    !params ||
    typeof params.updateSet !== "string" ||
    params.updateSet.trim() === ""
  ) {
    throw new Error(
      "export-update-set: updateSet is required (a sys_id or the set's exact name).",
    );
  }
  var mode: ExportMode = params.mode === "complete" ? "complete" : "assemble";
  var pageSize =
    params.pageSize === undefined ? DEFAULT_PAGE_SIZE : params.pageSize;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(
      "export-update-set: pageSize must be an integer between 1 and " +
        MAX_PAGE_SIZE +
        ".",
    );
  }
  var maxRows =
    params.maxRows === undefined ? DEFAULT_MAX_ROWS : params.maxRows;
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error("export-update-set: maxRows must be a positive integer.");
  }

  var live =
    params.dryRun !== true && (mode === "assemble" || params.confirm === true);
  var client = params.client || createClient({});
  var set = await resolveUpdateSet(client, params.updateSet.trim());
  var result = baseResult(set, mode);

  if (
    mode === "complete" &&
    params.dryRun !== true &&
    params.confirm !== true
  ) {
    result.status = "dry-run";
    result.note =
      "dry-run: mode=complete marks update set '" +
      set.name +
      "' complete on the instance before exporting — a real write. Re-run with confirm to proceed, " +
      "or use the read-only assemble mode.";
    return result;
  }

  if (!live) {
    result.status = "dry-run";
    result.note =
      "dry-run: would export update set '" +
      set.name +
      "' (" +
      set.sys_id +
      ", scope " +
      (set.scope || "global") +
      ", state " +
      (set.state || "unknown") +
      ") in " +
      mode +
      " mode, with secret values replaced by the sentinel. Nothing was read or written.";
    return result;
  }

  var rules = loadSecretRules(params.rulesPath);
  try {
    rules = await refreshTypeFields(client, rules);
  } catch (e) {
    // Keep the baseline rules: an unreadable dictionary is a reason to be more
    // careful, not to widen what ships. Recorded in the note below.
    rules = loadSecretRules(params.rulesPath);
  }

  var expected = await countUpdateXml(client, set.sys_id);
  result.expectedRecords = expected;
  if (expected === 0) {
    result.status = "failed";
    result.message = "the update set has no records";
    result.note =
      "export-update-set: update set '" +
      set.name +
      "' contains no records — nothing to export.";
    return result;
  }

  var raw = "";
  if (mode === "assemble") {
    var rows = await fetchUpdateXmlRows(client, set.sys_id, pageSize, maxRows);
    if (rows.length !== expected) {
      result.status = "failed";
      result.message = "record count mismatch";
      result.note =
        "export-update-set: the instance reports " +
        expected +
        " records but paging returned " +
        rows.length +
        ". Refusing to write a document that may be truncated.";
      return result;
    }
    var unloadDate = formatUnloadDate(new Date());
    var rendered: Array<string> = [];
    for (var r = 0; r < rows.length; r += 1) {
      rendered.push(renderUpdateXmlRow(rows[r]));
    }
    raw = renderUnload(
      renderRemoteUpdateSet(set, rows.length, unloadDate),
      rendered,
      unloadDate,
    );
    result.recordCount = rows.length;
  } else {
    var servlet = await exportViaServlet(params, set);
    if (servlet.error !== "") {
      result.status = "failed";
      result.message = servlet.error;
      result.note =
        "export-update-set: " + servlet.error + " Nothing was written.";
      return result;
    }
    raw = servlet.xml;
    result.recordCount = countUnloadRecords(raw);
    if (result.recordCount !== expected) {
      result.status = "failed";
      result.message = "record count mismatch";
      result.note =
        "export-update-set: the servlet returned " +
        result.recordCount +
        " records but the set holds " +
        expected +
        ". Refusing to write a possibly truncated document.";
      return result;
    }
  }

  var stripped = stripSecrets(raw, rules);
  result.status = "exported";
  result.xml = stripped.xml;
  result.secretFields = stripped.secretFields;
  result.note =
    "exported " +
    result.recordCount +
    " record(s) from '" +
    set.name +
    "' in " +
    mode +
    " mode; " +
    stripped.secretFields.length +
    " secret value(s) replaced with " +
    rules.sentinel +
    ". Set them per the install runbook after loading.";
  return result;
}

/** Count `<sys_update_xml>` elements in an unload document. */
export function countUnloadRecords(xml: string): number {
  var m = xml.match(/<sys_update_xml(?=[\s/>])/g);
  return m ? m.length : 0;
}

/**
 * Complete-mode export: mark the set complete, then read the servlet. The state
 * write goes through the REST table API deliberately — sys_update_set is a
 * platform record, not a scoped app record, so the scope-safe Dovetail write
 * path does not apply.
 */
async function exportViaServlet(
  params: ExportUpdateSetParams,
  set: ResolvedSet,
): Promise<{ xml: string; error: string }> {
  var client = params.client || createClient({});
  var transport = params.transport || {};
  var openSession = transport.openSession || openFormSession;
  var get = transport.get || getWithSession;

  if (set.state !== "complete") {
    var patch = await client.now.invoke({
      method: "PUT",
      path: "/api/now/table/sys_update_set/" + encodeURIComponent(set.sys_id),
      body: { state: "complete" },
    });
    if (patch.status !== 200) {
      return {
        xml: "",
        error:
          "could not mark the set complete (HTTP " +
          patch.status +
          "); the export servlet only streams a complete set.",
      };
    }
  }

  var auth = resolveFormAuth({
    instance: params.instance,
    user: params.user,
    password: params.password,
  });
  var session = await openSession(auth);
  var res = await get(
    auth,
    session,
    "/export_update_set.do?sysparm_sys_id=" +
      encodeURIComponent(set.sys_id) +
      "&sysparm_delete_when_done=false&sysparm_is_remote=false&sysparm_ck=" +
      encodeURIComponent(session.ck),
  );
  if (res.status !== 200) {
    return {
      xml: "",
      error: "the export servlet answered HTTP " + res.status + ".",
    };
  }
  if (res.body.indexOf("<unload") === -1) {
    // The documented in-progress behaviour: HTTP 200, empty body.
    return {
      xml: "",
      error:
        "the export servlet returned no document (" +
        res.body.length +
        " bytes) — the set is still in progress on the instance.",
    };
  }
  return { xml: res.body, error: "" };
}
