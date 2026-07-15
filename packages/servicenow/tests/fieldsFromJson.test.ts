import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  coerceFieldsFromJson,
  readFieldsFromJsonFile,
} from "../src/fieldsFromJson";

// A value the inline `--fields "k=v,k2=v2"` parser cannot carry: newlines, commas,
// equals signs, quotes, leading indentation. This is the exact shape --from-json exists
// to support (e.g. a sys_script_include body).
var SCRIPT_VALUE =
  "var records = {};\n" +
  "for (var i = 0; i < list.length; i += 1) {\n" +
  '  records[list[i].name] = { sys_id: list[i].id, label: "a, b = c" };\n' +
  "}\n";

describe("coerceFieldsFromJson", function () {
  it("returns a flat string map unchanged", function () {
    expect(coerceFieldsFromJson({ order: "20", label: "Send size" })).toEqual({
      order: "20",
      label: "Send size",
    });
  });

  it("preserves a large multiline value byte-for-byte", function () {
    var out = coerceFieldsFromJson({ script: SCRIPT_VALUE });
    expect(out.script).toBe(SCRIPT_VALUE);
  });

  it("stringifies numbers and booleans (matching the inline/wire form)", function () {
    expect(coerceFieldsFromJson({ order: 35, active: true })).toEqual({
      order: "35",
      active: "true",
    });
  });

  it("skips null and undefined values", function () {
    expect(coerceFieldsFromJson({ a: "keep", b: null, c: undefined })).toEqual({
      a: "keep",
    });
  });

  it("rejects a nested-object field value", function () {
    expect(function () {
      coerceFieldsFromJson({ script: { file: "x.js" } });
    }).toThrow(/must be a string, number, or boolean/);
  });

  it("rejects an array field value", function () {
    expect(function () {
      coerceFieldsFromJson({ tags: ["a", "b"] });
    }).toThrow(/must be a string, number, or boolean/);
  });

  it("rejects a top-level array", function () {
    expect(function () {
      coerceFieldsFromJson([{ script: "x" }]);
    }).toThrow(/must contain a JSON object/);
  });

  it("rejects top-level null", function () {
    expect(function () {
      coerceFieldsFromJson(null);
    }).toThrow(/must contain a JSON object/);
  });

  it("rejects a top-level scalar", function () {
    expect(function () {
      coerceFieldsFromJson("script=foo");
    }).toThrow(/must contain a JSON object/);
  });
});

describe("readFieldsFromJsonFile", function () {
  var dir: string;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dove-ff-"));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads and validates a field map from disk, preserving a script body", function () {
    var file = path.join(dir, "fields.json");
    fs.writeFileSync(file, JSON.stringify({ script: SCRIPT_VALUE }), "utf8");
    var out = readFieldsFromJsonFile(file);
    expect(out.script).toBe(SCRIPT_VALUE);
  });

  it("throws a clean error when the file is missing", function () {
    expect(function () {
      readFieldsFromJsonFile(path.join(dir, "nope.json"));
    }).toThrow(/--from-json: cannot read/);
  });

  it("throws a clean error on malformed JSON", function () {
    var file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{ not: valid", "utf8");
    expect(function () {
      readFieldsFromJsonFile(file);
    }).toThrow(/is not valid JSON/);
  });
});
