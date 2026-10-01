/**
 * Secret-field rules for update-set exports.
 *
 * An exported `<unload>` carries the field VALUES of every captured record, so
 * a scoped-app export can ship the source instance's own credentials to whoever
 * imports it. Ground truth (tenonworkstudio, 2026-09-15): completed update sets
 * on that instance hold filled-in values for the `password2` properties
 * `x_cadso_automate.email_builder_cs` / `page_builder_cs` / `editor_cid`, the
 * `password` property `template_catalog_token`, and `oauth_entity.client_secret`
 * on three OAuth entities — several of them in sets that shipped to a customer.
 *
 * The rule set is deliberately ENUMERABLE rather than a name heuristic, in four
 * layers, checked in order:
 *
 *   L1 type       — a field whose sys_dictionary internal_type is password or
 *                   password2, restricted to tables an update set can actually
 *                   capture (the table's collection row carries
 *                   update_synch=true). Credential tables such as
 *                   discovery_credentials and its children are NOT capturable,
 *                   so they never reach an unload and are out of scope.
 *   L2 conditional/explicit — a field that is secret only for some records
 *                   (sys_properties.value when the property's type is a password
 *                   type) or that is secret despite a non-secret column type
 *                   (x_cadso_core.google_translate_api_key is a plain string).
 *   L3 JSON       — a secret nested inside a JSON blob field, stripped in place.
 *   L4 heuristic  — a field or JSON key that merely LOOKS secret. Never stripped
 *                   silently and never assumed safe: it is reported so a human
 *                   adjudicates it once, into notSecret or explicit.
 *
 * Pure module — no I/O beyond reading an override file. ES6 only.
 */

import * as fs from "fs";

/** Value written in place of every stripped secret. */
export var SENTINEL = "__SET_DURING_INSTALL__";

/** sys_dictionary internal_types that mark a column as secret-bearing. */
export var SECRET_INTERNAL_TYPES: ReadonlyArray<string> = [
  "password",
  "password2",
];

/** A rule that applies to one field, optionally only when a sibling field matches. */
export interface FieldRule {
  /** Stable id, surfaced as the strip reason so a reviewer can trace it. */
  id: string;
  /** Table the record belongs to. */
  table: string;
  /** Element to replace with the sentinel. */
  field: string;
  /** Optional guard on a sibling field of the same record. */
  when?: {
    field: string;
    equals?: string;
    in?: Array<string>;
  };
  /** Why this field is secret — shown in review output and the MANIFEST. */
  reason: string;
}

/** A field a human has reviewed and declared NOT secret. */
export interface NotSecretRule {
  table: string;
  field: string;
  reason: string;
}

/** The full, versioned rule set. */
export interface SecretRules {
  version: number;
  sentinel: string;
  /** L1: table → secret-bearing fields, restricted to capturable tables. */
  typeFields: Record<string, Array<string>>;
  /** L2: conditional + explicit rules. */
  fieldRules: Array<FieldRule>;
  /** L2: reviewed false positives. */
  notSecret: Array<NotSecretRule>;
  /** L3: JSON object keys treated as secret inside a blob field. */
  jsonKeys: Array<string>;
  /** L4: the "looks secret" pattern that triggers review. */
  heuristic: { pattern: string; flags: string };
}

/**
 * L1 baseline, generated 2026-09-15 from tenonworkstudio: every password /
 * password2 field on a table whose collection row carries update_synch=true.
 * 79 tables carry such fields; only these 18 can appear in an update set.
 *
 * This is a FALLBACK. When a client is available the verb refreshes L1 from the
 * live dictionary (see secretFieldsFromDictionary) so a new plugin's tables are
 * covered without a Dovetail release.
 */
var BASELINE_TYPE_FIELDS: Record<string, Array<string>> = {
  jwt_keystore_aliases: ["signing_key_password"],
  jwt_verifier_map: ["shared_key"],
  ldap_server_config: ["password"],
  oauth_entity: ["client_secret"],
  sn_twilio_direct_twilio_config: ["auth_token"],
  sys_auth_profile_basic: ["password"],
  sys_auth_profile_oauth2: ["password"],
  sys_cs_collab_provider_application: ["signing_secret"],
  sys_data_source: ["jdbc_password", "scp_password"],
  sys_encryption_context: ["encryption_key"],
  sys_rest_message: ["basic_auth_password"],
  sys_rest_message_fn: ["basic_auth_password"],
  sys_sg_custom_map_provider: [
    "location_provider_app_secret",
    "map_provider_app_secret",
  ],
  sys_soap_message: ["basic_auth_password"],
  sys_soap_message_function: ["basic_auth_password", "key_store_password"],
  ws_security_username_profile_outbound: ["password"],
  ws_security_x509_profile_outbound: ["key_store_password"],
};

/**
 * sys_properties is the awkward one: the column type is always string, so
 * whether `value` is secret depends on the RECORD (its `type` field), and one
 * known property holds an API key in a plain string type.
 */
var BASELINE_FIELD_RULES: Array<FieldRule> = [
  {
    id: "sys_properties-password-type",
    table: "sys_properties",
    field: "value",
    when: { field: "type", in: ["password", "password2"] },
    reason: "system property declared with a password type",
  },
  {
    id: "google-translate-api-key",
    table: "sys_properties",
    field: "value",
    when: { field: "name", equals: "x_cadso_core.google_translate_api_key" },
    reason:
      "Google Translate API key held in a string-typed property, so the type rule alone misses it",
  },
];

var BASELINE_JSON_KEYS: Array<string> = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "client_secret",
  "clientsecret",
  "token",
  "access_token",
  "refresh_token",
  "auth_token",
  "api_key",
  "apikey",
  "private_key",
  "signing_key",
  "shared_key",
];

var BASELINE_HEURISTIC = {
  pattern:
    "(secret|token|passw(or)?d|api_?key|private_?key|passphrase|signing|bearer)",
  flags: "i",
};

/** The built-in rule set. Callers may override it with a JSON file. */
export function defaultSecretRules(): SecretRules {
  return {
    version: 1,
    sentinel: SENTINEL,
    typeFields: cloneFieldMap(BASELINE_TYPE_FIELDS),
    fieldRules: BASELINE_FIELD_RULES.slice(),
    notSecret: [],
    jsonKeys: BASELINE_JSON_KEYS.slice(),
    heuristic: {
      pattern: BASELINE_HEURISTIC.pattern,
      flags: BASELINE_HEURISTIC.flags,
    },
  };
}

function cloneFieldMap(
  src: Record<string, Array<string>>,
): Record<string, Array<string>> {
  var out: Record<string, Array<string>> = {};
  var tables = Object.keys(src);
  for (var i = 0; i < tables.length; i += 1) {
    out[tables[i]] = src[tables[i]].slice();
  }
  return out;
}

/** True when `v` is a non-null object (and not an array). */
function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown, label: string): Array<string> {
  if (!Array.isArray(v)) {
    throw new Error("secret-rules: " + label + " must be an array of strings");
  }
  var out: Array<string> = [];
  for (var i = 0; i < v.length; i += 1) {
    if (typeof v[i] !== "string" || v[i] === "") {
      throw new Error(
        "secret-rules: " + label + "[" + i + "] must be a non-empty string",
      );
    }
    out.push(v[i] as string);
  }
  return out;
}

/**
 * Merge an override object over a base rule set. Overrides ADD to the strip
 * layers (never silently drop one) — the only subtractive layer is notSecret,
 * which is how a reviewed false positive gets exempted, with its reason on the
 * record.
 */
export function mergeSecretRules(
  base: SecretRules,
  override: unknown,
): SecretRules {
  if (override === undefined || override === null) {
    return base;
  }
  if (!isRecordObject(override)) {
    throw new Error("secret-rules: override must be a JSON object");
  }
  var out = base;
  if (override.sentinel !== undefined) {
    if (typeof override.sentinel !== "string" || override.sentinel === "") {
      throw new Error("secret-rules: sentinel must be a non-empty string");
    }
    out.sentinel = override.sentinel;
  }
  if (override.typeFields !== undefined) {
    if (!isRecordObject(override.typeFields)) {
      throw new Error(
        "secret-rules: typeFields must be an object of table -> fields",
      );
    }
    var tables = Object.keys(override.typeFields);
    for (var i = 0; i < tables.length; i += 1) {
      var fields = asStringArray(
        (override.typeFields as Record<string, unknown>)[tables[i]],
        "typeFields." + tables[i],
      );
      out.typeFields[tables[i]] = mergeUnique(
        out.typeFields[tables[i]] || [],
        fields,
      );
    }
  }
  if (override.fieldRules !== undefined) {
    if (!Array.isArray(override.fieldRules)) {
      throw new Error("secret-rules: fieldRules must be an array");
    }
    for (var r = 0; r < override.fieldRules.length; r += 1) {
      out.fieldRules.push(parseFieldRule(override.fieldRules[r], r));
    }
  }
  if (override.notSecret !== undefined) {
    if (!Array.isArray(override.notSecret)) {
      throw new Error("secret-rules: notSecret must be an array");
    }
    for (var n = 0; n < override.notSecret.length; n += 1) {
      out.notSecret.push(parseNotSecret(override.notSecret[n], n));
    }
  }
  if (override.jsonKeys !== undefined) {
    out.jsonKeys = mergeUnique(
      out.jsonKeys,
      asStringArray(override.jsonKeys, "jsonKeys"),
    );
  }
  if (override.heuristic !== undefined) {
    if (
      !isRecordObject(override.heuristic) ||
      typeof override.heuristic.pattern !== "string"
    ) {
      throw new Error("secret-rules: heuristic must be { pattern, flags }");
    }
    out.heuristic = {
      pattern: override.heuristic.pattern,
      flags:
        typeof override.heuristic.flags === "string"
          ? override.heuristic.flags
          : "i",
    };
  }
  return out;
}

function mergeUnique(a: Array<string>, b: Array<string>): Array<string> {
  var out = a.slice();
  for (var i = 0; i < b.length; i += 1) {
    if (out.indexOf(b[i]) === -1) {
      out.push(b[i]);
    }
  }
  return out;
}

function parseFieldRule(raw: unknown, index: number): FieldRule {
  if (!isRecordObject(raw)) {
    throw new Error(
      "secret-rules: fieldRules[" + index + "] must be an object",
    );
  }
  if (typeof raw.table !== "string" || raw.table === "") {
    throw new Error(
      "secret-rules: fieldRules[" + index + "].table is required",
    );
  }
  if (typeof raw.field !== "string" || raw.field === "") {
    throw new Error(
      "secret-rules: fieldRules[" + index + "].field is required",
    );
  }
  if (typeof raw.reason !== "string" || raw.reason === "") {
    throw new Error(
      "secret-rules: fieldRules[" +
        index +
        "].reason is required — say why the field is secret",
    );
  }
  var rule: FieldRule = {
    id:
      typeof raw.id === "string" && raw.id !== "" ? raw.id : "custom-" + index,
    table: raw.table,
    field: raw.field,
    reason: raw.reason,
  };
  if (raw.when !== undefined) {
    if (!isRecordObject(raw.when) || typeof raw.when.field !== "string") {
      throw new Error(
        "secret-rules: fieldRules[" +
          index +
          "].when must be { field, equals|in }",
      );
    }
    var when: FieldRule["when"] = { field: raw.when.field };
    if (raw.when.equals !== undefined) {
      if (typeof raw.when.equals !== "string") {
        throw new Error(
          "secret-rules: fieldRules[" +
            index +
            "].when.equals must be a string",
        );
      }
      when.equals = raw.when.equals;
    }
    if (raw.when.in !== undefined) {
      when.in = asStringArray(raw.when.in, "fieldRules[" + index + "].when.in");
    }
    if (when.equals === undefined && when.in === undefined) {
      throw new Error(
        "secret-rules: fieldRules[" + index + "].when needs equals or in",
      );
    }
    rule.when = when;
  }
  return rule;
}

function parseNotSecret(raw: unknown, index: number): NotSecretRule {
  if (!isRecordObject(raw)) {
    throw new Error("secret-rules: notSecret[" + index + "] must be an object");
  }
  if (typeof raw.table !== "string" || typeof raw.field !== "string") {
    throw new Error(
      "secret-rules: notSecret[" + index + "] needs table and field",
    );
  }
  if (typeof raw.reason !== "string" || raw.reason === "") {
    throw new Error(
      "secret-rules: notSecret[" +
        index +
        "] needs a reason — an exemption without a reason is not reviewable",
    );
  }
  return { table: raw.table, field: raw.field, reason: raw.reason };
}

/** Load the built-in rules, optionally merged with a JSON override file. */
export function loadSecretRules(rulesPath?: string): SecretRules {
  var rules = defaultSecretRules();
  if (!rulesPath) {
    return rules;
  }
  var raw = "";
  try {
    raw = fs.readFileSync(rulesPath, "utf8");
  } catch (e) {
    throw new Error("secret-rules: cannot read rules file " + rulesPath);
  }
  var parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("secret-rules: " + rulesPath + " is not valid JSON");
  }
  return mergeSecretRules(rules, parsed);
}

/** One sys_dictionary row, as returned by a table query for L1 refresh. */
export interface DictionaryRow {
  name: string;
  element: string;
  internal_type: string | { value?: string };
}

/** One sys_db_object-ish row saying whether a table is captured by update sets. */
export interface CapturableRow {
  name: string;
  attributes?: string;
}

function internalTypeOf(row: DictionaryRow): string {
  var t = row.internal_type;
  if (typeof t === "string") {
    return t;
  }
  if (t && typeof t.value === "string") {
    return t.value;
  }
  return "";
}

/**
 * Build the L1 map from live dictionary rows, keeping only fields on capturable
 * tables. `capturable` is the set of table names whose collection row carries
 * update_synch=true; a table missing from it is dropped, because a record of a
 * non-capturable table can never appear in an unload.
 *
 * Flow-variable tables (`var__m_*`) are dropped too: those rows are action
 * variable DEFINITIONS, not stored values.
 */
export function secretFieldsFromDictionary(
  rows: Array<DictionaryRow>,
  capturable: Array<string>,
): Record<string, Array<string>> {
  var allowed: Record<string, boolean> = {};
  for (var c = 0; c < capturable.length; c += 1) {
    allowed[capturable[c]] = true;
  }
  var out: Record<string, Array<string>> = {};
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (
      !row ||
      typeof row.name !== "string" ||
      typeof row.element !== "string"
    ) {
      continue;
    }
    if (row.element === "" || row.name.indexOf("var__") === 0) {
      continue;
    }
    if (SECRET_INTERNAL_TYPES.indexOf(internalTypeOf(row)) === -1) {
      continue;
    }
    if (!allowed[row.name]) {
      continue;
    }
    if (!out[row.name]) {
      out[row.name] = [];
    }
    if (out[row.name].indexOf(row.element) === -1) {
      out[row.name].push(row.element);
    }
  }
  return out;
}

/** True when the table's collection attributes mark it update-set capturable. */
export function isCapturable(row: CapturableRow): boolean {
  var attrs = row && typeof row.attributes === "string" ? row.attributes : "";
  return attrs.indexOf("update_synch=true") !== -1;
}
