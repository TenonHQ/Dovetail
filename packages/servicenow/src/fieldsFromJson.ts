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

/**
 * Parse inline `--fields "k=v, k2=v2"` into a field map. Splits on commas and trims, so it
 * cannot carry a value containing a comma, newline or `=` — use `--from-json` for those.
 */
export function parseFieldsInline(input: string): Record<string, string> {
  var out: Record<string, string> = {};
  if (!input || typeof input !== "string") return out;
  var parts = input.split(",");
  for (var i = 0; i < parts.length; i += 1) {
    var piece = parts[i].trim();
    if (!piece) continue;
    var eq = piece.indexOf("=");
    if (eq === -1) continue;
    var key = piece.slice(0, eq).trim();
    if (key) out[key] = piece.slice(eq + 1).trim();
  }
  return out;
}

/** `--from-json -` is the stdin sentinel, mirroring the Unix convention. */
export var STDIN_SENTINEL = "-";

/** The slice of a readable stdin the explicit reader needs — injectable for tests. */
export type StdinSource = NodeJS.ReadableStream & { isTTY?: boolean };

/**
 * True only when the caller EXPLICITLY asked for stdin: `--from-stdin`, or
 * `--from-json -`. Nothing else — not a missing flag, not a non-TTY stdin —
 * ever makes the record-write verbs read stdin (#299).
 */
export function wantsStdin(flags: Record<string, string>): boolean {
  if (!flags || typeof flags !== "object") return false;
  return flags["from-stdin"] === "true" || flags["from-json"] === STDIN_SENTINEL;
}

/** Drain a readable stream to a UTF-8 string. Resolves on `end`, rejects on `error`. */
export function readAllFromStream(stream: StdinSource): Promise<string> {
  return new Promise(function (resolve, reject) {
    var chunks: Array<string> = [];
    var settled = false;
    stream.setEncoding("utf8");
    stream.on("data", function (chunk: string | Buffer) {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    stream.on("end", function () {
      if (settled) return;
      settled = true;
      resolve(chunks.join(""));
    });
    stream.on("error", function (err: Error) {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Read a `{ field: value }` JSON object from stdin — ONLY ever called when the caller
 * passed `--from-stdin` / `--from-json -`. Refuses a TTY (nothing is piped in, so the
 * read would block on the keyboard) and an empty stream, with actionable messages.
 */
export async function readFieldsFromStdin(
  stream: StdinSource,
): Promise<Record<string, string>> {
  if (!stream) {
    throw new Error("--from-stdin: no stdin stream is available.");
  }
  if (stream.isTTY) {
    throw new Error(
      "--from-stdin: stdin is a terminal — pipe a JSON object in " +
        "(e.g. cat fields.json | dove-sn ... --from-stdin) or use --from-json <path>.",
    );
  }
  var raw = await readAllFromStream(stream);
  if (raw.trim().length === 0) {
    throw new Error(
      "--from-stdin: stdin was empty — expected a JSON object of field → value pairs.",
    );
  }
  var parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    var parseMsg = err instanceof Error ? err.message : String(err);
    throw new Error("--from-stdin: stdin is not valid JSON: " + parseMsg);
  }
  return coerceFieldsFromJson(parsed);
}

/**
 * Resolve the field map for the record-write verbs (set-field, create-record) from
 * their three sources: inline `--fields "k=v,k2=v2"`, `--from-json <path>`, and
 * `--from-stdin` (alias `--from-json -`). On a shared key the file / stdin value wins —
 * it is the explicit spec.
 *
 * stdin is read ONLY when explicitly requested. `getStdin` is a thunk so `process.stdin`
 * is not even dereferenced otherwise: an open-but-idle non-TTY pipe (an agent harness
 * launching dove-sn in the background) must never be awaited (#299). With no field
 * source at all this resolves immediately to an empty map, and the verb emits its usage
 * line — it never falls back to prompting or to reading stdin.
 *
 * Throws (with a `--from-json:` / `--from-stdin:` prefix) on an unreadable file,
 * malformed JSON, a non-scalar value, or when both a file and stdin are requested.
 */
export async function resolveRecordFields(
  flags: Record<string, string>,
  getStdin: () => StdinSource,
): Promise<Record<string, string>> {
  var safeFlags: Record<string, string> =
    flags && typeof flags === "object" ? flags : {};
  var inline = parseFieldsInline(safeFlags.fields || "");
  var fromJson = safeFlags["from-json"];
  if (wantsStdin(safeFlags)) {
    if (fromJson && fromJson !== STDIN_SENTINEL) {
      throw new Error(
        "pass either --from-json <path> or --from-stdin (--from-json -), not both.",
      );
    }
    if (typeof getStdin !== "function") {
      throw new Error("--from-stdin: no stdin provider was supplied.");
    }
    return Object.assign(inline, await readFieldsFromStdin(getStdin()));
  }
  if (fromJson) {
    return Object.assign(inline, readFieldsFromJsonFile(fromJson));
  }
  return inline;
}
