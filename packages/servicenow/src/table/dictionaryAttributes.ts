/**
 * sys_dictionary.attributes — the comma-separated `key=value` string that carries a
 * column's dictionary attributes (`readonly_clickthrough=true,ref_auto_completer=...`).
 *
 * One parser/merger shared by add-column, create-table, set-column and the audit, so
 * every verb agrees on what "the column carries attribute X" means.
 *
 * Rules:
 *   - Entries are separated by `,`; each splits on its FIRST `=` (a value may contain
 *     `=` — e.g. a ref_qual fragment). A bare `key` (no `=`) is kept as-is.
 *   - A MERGE never drops an existing key: requested keys overwrite in place or append.
 *     Writing the attribute string wholesale would silently clobber whatever the column
 *     already carried (ref_auto_completer, ref_ac_columns, ...).
 *   - Comparisons are order-insensitive — ServiceNow stores the string as written, but
 *     "does the column carry X" must not depend on where X sits in it.
 *
 * TEAM RULE (2026-10-08): every reference column carries `readonly_clickthrough=true`.
 * `resolveColumnAttributes` applies it by default to NEW reference columns; a caller
 * opts out with `optOut` or by setting readonly_clickthrough explicitly.
 *
 * ES6 only, no optional chaining, no `any`.
 */

/** One parsed attribute. `value` is null for a bare key (no `=`). */
export interface DictionaryAttribute {
  key: string;
  value: string | null;
}

/** What a caller may pass: the raw `k=v,k2=v2` string, or a key -> value map. */
export type AttributeInput = string | Record<string, string | boolean>;

/** The attribute every new reference column carries by default (team rule 2026-10-08). */
export var READONLY_CLICKTHROUGH = "readonly_clickthrough";
export var REFERENCE_DEFAULT_ATTRIBUTES: Array<DictionaryAttribute> = [
  { key: READONLY_CLICKTHROUGH, value: "true" },
];

var ATTRIBUTE_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * Parse a stored attribute string leniently — it came from the instance, so it is
 * reported as found, not validated. Empty entries are skipped; a duplicate key keeps
 * its first position and its last value.
 */
export function parseAttributes(raw: string): Array<DictionaryAttribute> {
  var out: Array<DictionaryAttribute> = [];
  var text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return out;
  var parts = text.split(",");
  for (var i = 0; i < parts.length; i += 1) {
    var piece = parts[i].trim();
    if (!piece) continue;
    var eq = piece.indexOf("=");
    var key = eq === -1 ? piece : piece.slice(0, eq).trim();
    var value = eq === -1 ? null : piece.slice(eq + 1).trim();
    if (!key) continue;
    upsert(out, { key: key, value: value });
  }
  return out;
}

/** Serialize back to the stored form. */
export function serializeAttributes(attrs: Array<DictionaryAttribute>): string {
  return attrs
    .map(function (a) {
      return a.value === null ? a.key : a.key + "=" + a.value;
    })
    .join(",");
}

/**
 * Validate + normalize what a CALLER asked for. Strict — unlike parseAttributes, this
 * is untrusted input headed for a schema write: keys must be identifiers, and a value
 * may not contain `,` (it is the separator, so it would silently split into a second,
 * unintended attribute). Throws `attributes: ...` on anything malformed or empty.
 */
export function normalizeAttributeInput(
  input: AttributeInput,
): Array<DictionaryAttribute> {
  var entries: Array<DictionaryAttribute> = [];
  if (typeof input === "string") {
    if (!input.trim()) {
      throw new Error(
        "attributes: an empty attribute string sets nothing — pass at least one key=value.",
      );
    }
    var parts = input.split(",");
    for (var i = 0; i < parts.length; i += 1) {
      var piece = parts[i].trim();
      if (!piece) {
        throw new Error(
          "attributes: '" + input + "' has an empty entry (stray comma).",
        );
      }
      var eq = piece.indexOf("=");
      entries.push({
        key: eq === -1 ? piece : piece.slice(0, eq).trim(),
        value: eq === -1 ? null : piece.slice(eq + 1).trim(),
      });
    }
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    var keys = Object.keys(input);
    for (var k = 0; k < keys.length; k += 1) {
      var v = input[keys[k]];
      if (typeof v !== "string" && typeof v !== "boolean") {
        throw new Error(
          "attributes: value for '" +
            keys[k] +
            "' must be a string or boolean.",
        );
      }
      entries.push({
        key: keys[k],
        value: typeof v === "boolean" ? (v ? "true" : "false") : v.trim(),
      });
    }
  } else {
    throw new Error(
      "attributes: expected a 'key=value,key2=value2' string or a key -> value object.",
    );
  }
  if (entries.length === 0) {
    throw new Error("attributes: at least one attribute is required.");
  }
  var out: Array<DictionaryAttribute> = [];
  for (var j = 0; j < entries.length; j += 1) {
    var e = entries[j];
    if (!ATTRIBUTE_KEY.test(e.key)) {
      throw new Error(
        "attributes: '" +
          e.key +
          "' is not a valid attribute name (letters, digits, '_' and '.'; must not start with a digit).",
      );
    }
    if (e.value !== null && e.value.indexOf(",") !== -1) {
      throw new Error(
        "attributes: the value for '" +
          e.key +
          "' contains ',' — that is the attribute separator, so it would split into a second attribute.",
      );
    }
    upsert(out, e);
  }
  return out;
}

/**
 * Merge `requested` into the `existing` stored string. Existing keys keep their
 * position (and are overwritten in place when requested); new keys are appended.
 * Nothing already on the column is ever dropped.
 */
export function mergeAttributes(
  existing: string,
  requested: Array<DictionaryAttribute>,
): string {
  var merged = parseAttributes(existing);
  for (var i = 0; i < requested.length; i += 1) {
    upsert(merged, requested[i]);
  }
  return serializeAttributes(merged);
}

/**
 * The requested attributes `actual` does NOT carry with the requested value, rendered
 * as `key=value` (or the bare key). Empty = every requested attribute is present.
 */
export function missingAttributes(
  actual: string,
  required: Array<DictionaryAttribute>,
): Array<string> {
  var have = parseAttributes(actual);
  var missing: Array<string> = [];
  for (var i = 0; i < required.length; i += 1) {
    var want = required[i];
    var found = find(have, want.key);
    if (!found || found.value !== want.value) {
      missing.push(
        want.value === null ? want.key : want.key + "=" + want.value,
      );
    }
  }
  return missing;
}

/**
 * The attribute set a NEW column must carry: what the caller asked for, plus the
 * reference default — unless the column is not a reference, the caller opted out, or
 * the caller set readonly_clickthrough themselves (their value wins, e.g. `=false`).
 */
export function resolveColumnAttributes(
  internalType: string,
  requested?: AttributeInput,
  optOut?: boolean,
): Array<DictionaryAttribute> {
  var out: Array<DictionaryAttribute> =
    requested === undefined || requested === null
      ? []
      : normalizeAttributeInput(requested);
  if (
    internalType === "reference" &&
    optOut !== true &&
    !find(out, READONLY_CLICKTHROUGH)
  ) {
    for (var i = 0; i < REFERENCE_DEFAULT_ATTRIBUTES.length; i += 1) {
      out.push({
        key: REFERENCE_DEFAULT_ATTRIBUTES[i].key,
        value: REFERENCE_DEFAULT_ATTRIBUTES[i].value,
      });
    }
  }
  return out;
}

function find(
  list: Array<DictionaryAttribute>,
  key: string,
): DictionaryAttribute | undefined {
  for (var i = 0; i < list.length; i += 1) {
    if (list[i].key === key) return list[i];
  }
  return undefined;
}

function upsert(
  list: Array<DictionaryAttribute>,
  entry: DictionaryAttribute,
): void {
  var existing = find(list, entry.key);
  if (existing) {
    existing.value = entry.value;
  } else {
    list.push({ key: entry.key, value: entry.value });
  }
}
