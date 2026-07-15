import * as fs from "fs";
import * as path from "path";

/**
 * `--from-json` field-map loader for the record-write verbs (set-field, create-record).
 *
 * The inline `--fields "k=v,k2=v2"` form splits on commas and trims each piece — so it
 * cannot carry a value that contains a comma, a newline, an `=`, or leading/trailing
 * whitespace. That rules out every large field: a script body, an HTML/XML/CSS field, a
 * JSON blob. `--from-json <path>` closes that gap: the file is a flat JSON object of
 * `field → value`, and JSON quoting carries any character faithfully.
 *
 * Values may be string | number | boolean. Numbers/booleans are stringified — matching
 * the inline parser and the wire format, where ServiceNow scalar fields are strings.
 * `null`/`undefined` values are skipped. Nested objects and arrays are rejected: a scalar
 * field cannot take one, and silently JSON-encoding it would write garbage into the record.
 */
export function coerceFieldsFromJson(parsed: unknown): Record<string, string> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "--from-json must contain a JSON object of field → value pairs",
    );
  }
  var obj = parsed as Record<string, unknown>;
  var out: Record<string, string> = {};
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    var value = obj[key];
    if (value === null || value === undefined) continue;
    var valueType = typeof value;
    if (valueType === "string") {
      out[key] = value as string;
    } else if (valueType === "number" || valueType === "boolean") {
      out[key] = String(value);
    } else {
      throw new Error(
        "--from-json field '" +
          key +
          "' must be a string, number, or boolean (got " +
          valueType +
          ")",
      );
    }
  }
  return out;
}

/**
 * Read + parse a `--from-json` file into a validated field map. The path is resolved
 * against the process cwd, matching the other `--from-json` consumers in the CLI.
 * Throws a clean, prefixed message on a missing file or malformed JSON so the caller can
 * surface it as a bad-args error rather than an uncaught stack trace.
 */
export function readFieldsFromJsonFile(
  filePath: string,
): Record<string, string> {
  var raw: string;
  try {
    raw = fs.readFileSync(path.resolve(filePath), "utf8");
  } catch (err) {
    var readMsg = err instanceof Error ? err.message : String(err);
    throw new Error("--from-json: cannot read '" + filePath + "': " + readMsg);
  }
  var parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    var parseMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      "--from-json: '" + filePath + "' is not valid JSON: " + parseMsg,
    );
  }
  return coerceFieldsFromJson(parsed);
}
