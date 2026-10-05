import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import {
  coerceFieldsFromJson,
  readFieldsFromJsonFile,
  parseFieldsInline,
  wantsStdin,
  readFieldsFromStdin,
  resolveRecordFields,
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

describe("parseFieldsInline", function () {
  it("splits comma-separated key=value pairs and trims", function () {
    expect(parseFieldsInline(" name = a , order=35,,bogus")).toEqual({ name: "a", order: "35" });
  });

  it("returns an empty map for empty or non-string input", function () {
    expect(parseFieldsInline("")).toEqual({});
    expect(parseFieldsInline(undefined as unknown as string)).toEqual({});
  });
});

describe("wantsStdin", function () {
  it("is true only for an explicit --from-stdin or --from-json -", function () {
    expect(wantsStdin({ "from-stdin": "true" })).toBe(true);
    expect(wantsStdin({ "from-json": "-" })).toBe(true);
    expect(wantsStdin({ "from-json": "./fields.json" })).toBe(false);
    expect(wantsStdin({ fields: "a=b" })).toBe(false);
    expect(wantsStdin({})).toBe(false);
  });
});

// An open, idle, NON-TTY stdin that is never written to and never ends — the shape an
// agent harness hands a background child. If anything awaits it, the test times out.
type FakeStdin = PassThrough & { isTTY?: boolean };

function idleStdin(): FakeStdin {
  var s: FakeStdin = new PassThrough();
  s.isTTY = false;
  return s;
}

function withinMs<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>(function (resolve, reject) {
    var t = setTimeout(function () {
      reject(new Error("did not settle within " + ms + "ms — something awaited stdin"));
    }, ms);
    p.then(
      function (v) { clearTimeout(t); resolve(v); },
      function (e) { clearTimeout(t); reject(e); },
    );
  });
}

describe("resolveRecordFields — stdin is read only when asked (#299)", function () {
  var dir: string;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dove-rf-"));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves inline --fields promptly without dereferencing or listening on stdin", async function () {
    var stdin = idleStdin();
    var getStdin = jest.fn(function () { return stdin; });
    var out = await withinMs(resolveRecordFields({ fields: "name=a,order=35" }, getStdin), 500);
    expect(out).toEqual({ name: "a", order: "35" });
    expect(getStdin).not.toHaveBeenCalled();
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("end")).toBe(0);
  });

  it("resolves to an empty map immediately when no field source is given (caller emits usage)", async function () {
    var stdin = idleStdin();
    var getStdin = jest.fn(function () { return stdin; });
    var out = await withinMs(resolveRecordFields({ table: "x_t", scope: "x_s" }, getStdin), 500);
    expect(out).toEqual({});
    expect(getStdin).not.toHaveBeenCalled();
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("reads --from-json <path> from disk and still never touches stdin", async function () {
    var file = path.join(dir, "fields.json");
    fs.writeFileSync(file, JSON.stringify({ script: SCRIPT_VALUE, order: 7 }), "utf8");
    var stdin = idleStdin();
    var getStdin = jest.fn(function () { return stdin; });
    var out = await withinMs(
      resolveRecordFields({ fields: "order=1,name=a", "from-json": file }, getStdin),
      500,
    );
    expect(out).toEqual({ name: "a", order: "7", script: SCRIPT_VALUE });
    expect(getStdin).not.toHaveBeenCalled();
  });

  it("--from-stdin reads the JSON object from stdin and overrides inline keys", async function () {
    var stdin = idleStdin();
    var pending = resolveRecordFields(
      { fields: "order=1,name=a", "from-stdin": "true" },
      function () { return stdin; },
    );
    stdin.end(JSON.stringify({ script: SCRIPT_VALUE, order: 35 }));
    var out = await withinMs(pending, 2000);
    expect(out).toEqual({ name: "a", order: "35", script: SCRIPT_VALUE });
  });

  it("--from-json - is the stdin sentinel", async function () {
    var stdin = idleStdin();
    var pending = resolveRecordFields({ "from-json": "-" }, function () { return stdin; });
    stdin.end('{"description":"contact @tenon"}');
    var out = await withinMs(pending, 2000);
    expect(out).toEqual({ description: "contact @tenon" });
  });

  it("refuses --from-stdin together with --from-json <path>", async function () {
    var stdin = idleStdin();
    var getStdin = jest.fn(function () { return stdin; });
    await expect(
      withinMs(resolveRecordFields({ "from-stdin": "true", "from-json": "./x.json" }, getStdin), 500),
    ).rejects.toThrow(/not both/);
    expect(getStdin).not.toHaveBeenCalled();
  });

  it("--from-stdin refuses a TTY stdin with an actionable message", async function () {
    var stdin = idleStdin();
    stdin.isTTY = true;
    await expect(
      withinMs(resolveRecordFields({ "from-stdin": "true" }, function () { return stdin; }), 500),
    ).rejects.toThrow(/stdin is a terminal/);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("--from-stdin rejects an empty stream cleanly", async function () {
    var stdin = idleStdin();
    var pending = resolveRecordFields({ "from-stdin": "true" }, function () { return stdin; });
    stdin.end("");
    await expect(withinMs(pending, 2000)).rejects.toThrow(/stdin was empty/);
  });

  it("--from-stdin rejects malformed JSON cleanly", async function () {
    var stdin = idleStdin();
    var pending = readFieldsFromStdin(stdin);
    stdin.end("{ not: valid");
    await expect(withinMs(pending, 2000)).rejects.toThrow(/not valid JSON/);
  });

  it("--from-stdin rejects a non-scalar value via the shared coercion", async function () {
    var stdin = idleStdin();
    var pending = readFieldsFromStdin(stdin);
    stdin.end(JSON.stringify({ tags: ["a"] }));
    await expect(withinMs(pending, 2000)).rejects.toThrow(/must be a string, number, or boolean/);
  });
});
