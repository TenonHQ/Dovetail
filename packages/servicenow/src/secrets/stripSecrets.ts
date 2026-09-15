/**
 * Replace secret field VALUES in an update-set `<unload>` document with a
 * sentinel, preserving record structure, keys and every non-secret field.
 *
 * Runs on the exported XML, never on the instance: the source instance's own
 * `sys_update_xml` captures are left untouched, so nothing here can corrupt a
 * real update set. See secretRules.ts for the rule layers and the ground truth
 * behind them.
 *
 * Shape of the documents this walks:
 *
 *   <unload …>
 *     <sys_update_xml action="INSERT_OR_UPDATE">
 *       <name>sys_properties_5878…</name>
 *       <payload>&lt;record_update table="sys_properties"&gt;…&lt;/record_update&gt;</payload>
 *       …
 *     </sys_update_xml>
 *   </unload>
 *
 * The record lives ENTITY-ENCODED inside `<payload>`, so each payload is
 * decoded, stripped, and re-encoded. A payload may also arrive CDATA-wrapped;
 * both forms are handled.
 *
 * Fail-closed by design:
 *   - an unreviewed L4 heuristic hit throws unless the caller explicitly asks
 *     for a report (allowUnreviewed), so "looks secret" can never ship silently;
 *   - verifyStripped re-reads the OUTPUT and reports any strip-target field that
 *     is not the sentinel, so a regex miss fails the run instead of leaking.
 *
 * Secret VALUES never appear in the result: findings carry table, field and
 * record name only. ES6 only.
 */

import { decodeHtmlEntities } from "../table";
import type { SecretRules } from "./secretRules";

/** One field whose value was replaced with the sentinel. */
export interface SecretField {
  /** Table of the record the field belongs to. */
  table: string;
  /** Field (element) that was stripped. */
  field: string;
  /** The record's update name, e.g. "sys_properties_5878…" — never its value. */
  record: string;
  /** The sentinel written in its place. */
  sentinel: string;
  /** Which rule fired, as "<layer>:<rule id>". */
  reason: string;
  /** True when the secret sat inside a JSON blob rather than at field level. */
  inJson?: boolean;
  /** For a JSON hit, the dotted key path inside the blob. */
  jsonPath?: string;
}

/** A field that merely LOOKS secret and needs a human decision. */
export interface ReviewFinding {
  table: string;
  field: string;
  record: string;
  /** Why it was flagged — the matched name fragment, never the value. */
  matched: string;
  /** True when the match was on a JSON key. */
  inJson?: boolean;
  jsonPath?: string;
}

/** Result of a strip pass. */
export interface StripSecretsResult {
  /** The rewritten document. */
  xml: string;
  /** Every field replaced with the sentinel. */
  secretFields: Array<SecretField>;
  /** L4 hits awaiting adjudication. Non-empty means the run is blocked. */
  reviewFindings: Array<ReviewFinding>;
  /** How many `<payload>` records were walked. */
  recordsScanned: number;
}

/** Options for stripSecrets. */
export interface StripSecretsOptions {
  /**
   * Return L4 findings instead of throwing. For dry-runs and reports only —
   * a live export must never set this, or a "looks secret" field ships.
   */
  allowUnreviewed?: boolean;
}

var PAYLOAD_RE = /<payload>([\s\S]*?)<\/payload>/g;
var CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/;
var RECORD_TABLE_RE = /<record_update[^>]*\stable="([^"]+)"/;

/** Escape a string for use inside a regular expression. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Encode text for an XML element body (the inverse of decodeHtmlEntities). */
export function encodeXmlEntities(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Encode text for a body INSIDE the decoded record payload. Only the three
 * markup characters are escaped here: quotes and apostrophes are legal raw text
 * at this level, and the whole payload is encoded once more on the way out, so
 * escaping them here would double-encode every quote in a JSON blob.
 */
export function encodeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Read a field's text out of a decoded record payload. Returns null when the
 * element is absent, "" when it is present but empty or self-closing.
 */
export function readField(recordXml: string, field: string): string | null {
  var f = escapeRegExp(field);
  var selfClosing = new RegExp("<" + f + "\\s*/>");
  if (selfClosing.test(recordXml)) {
    return "";
  }
  var m = recordXml.match(new RegExp("<" + f + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + f + ">"));
  if (!m) {
    return null;
  }
  return decodeHtmlEntities(m[1]);
}

/**
 * Resolve the record's table. Prefers the `table` attribute on record_update;
 * falls back to the first element inside it, which is the record element.
 */
export function readRecordTable(recordXml: string): string {
  var attr = recordXml.match(RECORD_TABLE_RE);
  if (attr) {
    return attr[1];
  }
  var inner = recordXml.match(/<record_update[^>]*>\s*<([A-Za-z0-9_]+)/);
  return inner ? inner[1] : "";
}

function whenMatches(recordXml: string, rule: SecretRules["fieldRules"][0]): boolean {
  if (!rule.when) {
    return true;
  }
  var actual = readField(recordXml, rule.when.field);
  if (actual === null) {
    return false;
  }
  if (rule.when.equals !== undefined) {
    return actual === rule.when.equals;
  }
  if (rule.when.in !== undefined) {
    return rule.when.in.indexOf(actual) !== -1;
  }
  return false;
}

/** Fields to strip for one record, each with the rule that decided it. */
export function plannedStrips(
  recordXml: string,
  table: string,
  rules: SecretRules,
): Array<{ field: string; reason: string }> {
  var planned: Array<{ field: string; reason: string }> = [];
  var seen: Record<string, boolean> = {};
  var typeFields = rules.typeFields[table] || [];
  for (var i = 0; i < typeFields.length; i += 1) {
    if (!isExempt(rules, table, typeFields[i]) && !seen[typeFields[i]]) {
      seen[typeFields[i]] = true;
      planned.push({ field: typeFields[i], reason: "L1:password-type" });
    }
  }
  for (var r = 0; r < rules.fieldRules.length; r += 1) {
    var rule = rules.fieldRules[r];
    if (rule.table !== table || seen[rule.field]) {
      continue;
    }
    if (isExempt(rules, table, rule.field)) {
      continue;
    }
    if (whenMatches(recordXml, rule)) {
      seen[rule.field] = true;
      planned.push({ field: rule.field, reason: "L2:" + rule.id });
    }
  }
  return planned;
}

function isExempt(rules: SecretRules, table: string, field: string): boolean {
  for (var i = 0; i < rules.notSecret.length; i += 1) {
    if (rules.notSecret[i].table === table && rules.notSecret[i].field === field) {
      return true;
    }
  }
  return false;
}

/**
 * Replace one field's body with the sentinel. A self-closing or empty element
 * is normalised to the sentinel too: a credential record with no value set
 * still gets the placeholder, so the install runbook step is consistent.
 * Returns the rewritten XML and whether the element was present at all.
 */
export function stripField(
  recordXml: string,
  field: string,
  sentinel: string,
): { xml: string; stripped: boolean } {
  var f = escapeRegExp(field);
  var selfClosing = new RegExp("<" + f + "\\s*/>", "g");
  if (selfClosing.test(recordXml)) {
    return {
      xml: recordXml.replace(selfClosing, "<" + field + ">" + sentinel + "</" + field + ">"),
      stripped: true,
    };
  }
  var paired = new RegExp("(<" + f + "(?:\\s[^>]*)?>)([\\s\\S]*?)(</" + f + ">)", "g");
  var hit = false;
  var out = recordXml.replace(paired, function (_all, open: string, _body: string, close: string) {
    hit = true;
    return open + sentinel + close;
  });
  return { xml: out, stripped: hit };
}

function looksLikeJson(value: string): boolean {
  var t = value.replace(/^\s+/, "");
  return t.indexOf("{") === 0 || t.indexOf("[") === 0;
}

/**
 * Walk a parsed JSON value, replacing any key in `keys` with the sentinel and
 * collecting the paths touched. Keys are matched case-insensitively, since
 * payload blobs are not consistent about casing.
 */
export function stripJsonValue(
  value: unknown,
  keys: Array<string>,
  sentinel: string,
  path: string,
  hits: Array<string>,
): unknown {
  if (Array.isArray(value)) {
    var arr: Array<unknown> = [];
    for (var i = 0; i < value.length; i += 1) {
      arr.push(stripJsonValue(value[i], keys, sentinel, path + "[" + i + "]", hits));
    }
    return arr;
  }
  if (typeof value === "object" && value !== null) {
    var src = value as Record<string, unknown>;
    var out: Record<string, unknown> = {};
    var names = Object.keys(src);
    for (var n = 0; n < names.length; n += 1) {
      var name = names[n];
      var here = path === "" ? name : path + "." + name;
      if (matchesKey(name, keys)) {
        out[name] = sentinel;
        hits.push(here);
      } else {
        out[name] = stripJsonValue(src[name], keys, sentinel, here, hits);
      }
    }
    return out;
  }
  return value;
}

function matchesKey(name: string, keys: Array<string>): boolean {
  var lower = name.toLowerCase();
  for (var i = 0; i < keys.length; i += 1) {
    if (lower === keys[i].toLowerCase()) {
      return true;
    }
  }
  return false;
}

/** Element names present in a record payload, in document order. */
export function recordFieldNames(recordXml: string): Array<string> {
  var body = recordXml.match(/<record_update[^>]*>([\s\S]*)<\/record_update>/);
  var scope = body ? body[1] : recordXml;
  var inner = scope.match(/<[A-Za-z0-9_]+(?:\s[^>]*)?>([\s\S]*)<\/[A-Za-z0-9_]+>/);
  var fieldScope = inner ? inner[1] : scope;
  var out: Array<string> = [];
  var re = /<([A-Za-z0-9_]+)(?:\s[^>]*)?(?:\/>|>)/g;
  var m = re.exec(fieldScope);
  while (m) {
    if (out.indexOf(m[1]) === -1) {
      out.push(m[1]);
    }
    m = re.exec(fieldScope);
  }
  return out;
}

function decodePayload(raw: string): { text: string; cdata: boolean } {
  var cdata = raw.match(CDATA_RE);
  if (cdata) {
    return { text: cdata[1], cdata: true };
  }
  return { text: decodeHtmlEntities(raw), cdata: false };
}

function encodePayload(text: string, cdata: boolean): string {
  return cdata ? "<![CDATA[" + text + "]]>" : encodeXmlEntities(text);
}

/**
 * Strip every secret value in an `<unload>` document.
 *
 * Throws when an L4 heuristic hit is unadjudicated (unless allowUnreviewed),
 * and when the post-strip verification finds a secret that survived.
 */
export function stripSecrets(
  xml: string,
  rules: SecretRules,
  options: StripSecretsOptions = {},
): StripSecretsResult {
  if (typeof xml !== "string" || xml === "") {
    throw new Error("strip-secrets: nothing to strip — the export document is empty");
  }
  var secretFields: Array<SecretField> = [];
  var reviewFindings: Array<ReviewFinding> = [];
  var scanned = 0;
  var heuristic = new RegExp(rules.heuristic.pattern, rules.heuristic.flags);

  var out = xml.replace(PAYLOAD_RE, function (_all: string, rawPayload: string) {
    scanned += 1;
    var decoded = decodePayload(rawPayload);
    var recordXml = decoded.text;
    var table = readRecordTable(recordXml);
    if (table === "") {
      // A payload we cannot attribute to a table cannot be rule-checked, and a
      // silent pass is exactly the failure this module exists to prevent.
      throw new Error(
        "strip-secrets: a payload has no resolvable record table — refusing to write a " +
          "document that was not fully checked",
      );
    }
    var recordName = readField(recordXml, "sys_id") || table;

    var planned = plannedStrips(recordXml, table, rules);
    for (var p = 0; p < planned.length; p += 1) {
      var res = stripField(recordXml, planned[p].field, rules.sentinel);
      if (res.stripped) {
        recordXml = res.xml;
        secretFields.push({
          table: table,
          field: planned[p].field,
          record: recordName,
          sentinel: rules.sentinel,
          reason: planned[p].reason,
        });
      }
    }

    var names = recordFieldNames(recordXml);
    for (var n = 0; n < names.length; n += 1) {
      var field = names[n];
      if (wasStripped(secretFields, table, recordName, field)) {
        continue;
      }
      var body = readField(recordXml, field);
      if (body === null || body === "") {
        continue;
      }
      if (looksLikeJson(body)) {
        var jsonResult = stripJsonBlob(body, rules, heuristic, table, field, recordName);
        if (jsonResult) {
          recordXml = replaceFieldBody(recordXml, field, jsonResult.text);
          for (var s = 0; s < jsonResult.secrets.length; s += 1) {
            secretFields.push(jsonResult.secrets[s]);
          }
          for (var rv = 0; rv < jsonResult.reviews.length; rv += 1) {
            reviewFindings.push(jsonResult.reviews[rv]);
          }
          continue;
        }
      }
      var match = field.match(heuristic);
      if (match && !isExempt(rules, table, field)) {
        reviewFindings.push({
          table: table,
          field: field,
          record: recordName,
          matched: match[0],
        });
      }
    }

    return "<payload>" + encodePayload(recordXml, decoded.cdata) + "</payload>";
  });

  if (reviewFindings.length > 0 && options.allowUnreviewed !== true) {
    throw new Error(
      "strip-secrets: " +
        reviewFindings.length +
        " field(s) look secret but are not covered by a rule: " +
        describeFindings(reviewFindings) +
        ". Add each one to the rules file as a strip rule or as notSecret with a reason, " +
        "then re-run. Nothing was written.",
    );
  }

  var survivors = verifyStripped(out, rules);
  if (survivors.length > 0) {
    throw new Error(
      "strip-secrets: verification failed — " +
        survivors.length +
        " secret field(s) still carry a value after stripping (" +
        survivors.join(", ") +
        "). Nothing was written.",
    );
  }

  return {
    xml: out,
    secretFields: secretFields,
    reviewFindings: reviewFindings,
    recordsScanned: scanned,
  };
}

function wasStripped(
  secretFields: Array<SecretField>,
  table: string,
  record: string,
  field: string,
): boolean {
  for (var i = 0; i < secretFields.length; i += 1) {
    var s = secretFields[i];
    if (s.table === table && s.record === record && s.field === field) {
      return true;
    }
  }
  return false;
}

function stripJsonBlob(
  body: string,
  rules: SecretRules,
  heuristic: RegExp,
  table: string,
  field: string,
  record: string,
): { text: string; secrets: Array<SecretField>; reviews: Array<ReviewFinding> } | null {
  var parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return null;
  }
  var hits: Array<string> = [];
  var stripped = stripJsonValue(parsed, rules.jsonKeys, rules.sentinel, "", hits);
  var secrets: Array<SecretField> = [];
  for (var i = 0; i < hits.length; i += 1) {
    secrets.push({
      table: table,
      field: field,
      record: record,
      sentinel: rules.sentinel,
      reason: "L3:json-key",
      inJson: true,
      jsonPath: hits[i],
    });
  }
  var reviews: Array<ReviewFinding> = [];
  var keys = collectJsonKeys(stripped, "");
  for (var k = 0; k < keys.length; k += 1) {
    if (hits.indexOf(keys[k].path) !== -1) {
      continue;
    }
    var match = keys[k].name.match(heuristic);
    if (match) {
      reviews.push({
        table: table,
        field: field,
        record: record,
        matched: match[0],
        inJson: true,
        jsonPath: keys[k].path,
      });
    }
  }
  return { text: JSON.stringify(stripped), secrets: secrets, reviews: reviews };
}

function collectJsonKeys(value: unknown, path: string): Array<{ name: string; path: string }> {
  var out: Array<{ name: string; path: string }> = [];
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i += 1) {
      out = out.concat(collectJsonKeys(value[i], path + "[" + i + "]"));
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    var src = value as Record<string, unknown>;
    var names = Object.keys(src);
    for (var n = 0; n < names.length; n += 1) {
      var here = path === "" ? names[n] : path + "." + names[n];
      out.push({ name: names[n], path: here });
      out = out.concat(collectJsonKeys(src[names[n]], here));
    }
  }
  return out;
}

function replaceFieldBody(recordXml: string, field: string, body: string): string {
  var f = escapeRegExp(field);
  var paired = new RegExp("(<" + f + "(?:\\s[^>]*)?>)([\\s\\S]*?)(</" + f + ">)");
  return recordXml.replace(paired, function (_all, open: string, _old: string, close: string) {
    return open + encodeXmlText(body) + close;
  });
}

function describeFindings(findings: Array<ReviewFinding>): string {
  var parts: Array<string> = [];
  var limit = findings.length < 5 ? findings.length : 5;
  for (var i = 0; i < limit; i += 1) {
    parts.push(findings[i].table + "." + findings[i].field);
  }
  if (findings.length > limit) {
    parts.push("+" + (findings.length - limit) + " more");
  }
  return parts.join(", ");
}

/**
 * Re-read a stripped document and list every strip-target field that still
 * carries something other than the sentinel. The safety net for a regex that
 * did not match what it should have: the caller must write nothing when this
 * returns a non-empty list.
 */
export function verifyStripped(xml: string, rules: SecretRules): Array<string> {
  var problems: Array<string> = [];
  var re = new RegExp(PAYLOAD_RE.source, "g");
  var m = re.exec(xml);
  while (m) {
    var decoded = decodePayload(m[1]);
    var recordXml = decoded.text;
    var table = readRecordTable(recordXml);
    if (table !== "") {
      var planned = plannedStrips(recordXml, table, rules);
      for (var p = 0; p < planned.length; p += 1) {
        var value = readField(recordXml, planned[p].field);
        if (value !== null && value !== rules.sentinel) {
          problems.push(table + "." + planned[p].field);
        }
      }
    }
    m = re.exec(xml);
  }
  return problems;
}
