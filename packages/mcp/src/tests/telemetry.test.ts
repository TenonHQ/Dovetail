import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  recordEvent,
  withTelemetry,
  getTelemetryPath,
  isTelemetryDisabled,
  _resetForTests,
  _flushForTests
} from "../telemetry";

var SAVED = {
  path: process.env.SINC_MCP_TELEMETRY_PATH,
  disable: process.env.SINC_MCP_TELEMETRY_DISABLE,
  max: process.env.SINC_MCP_TELEMETRY_MAX_ENTRIES,
  interval: process.env.SINC_MCP_TELEMETRY_TRIM_INTERVAL
};

function makeTmpPath(): string {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "sinc-mcp-"));
  return path.join(dir, "telemetry.jsonl");
}

describe("telemetry", function () {
  beforeEach(function () {
    delete process.env.SINC_MCP_TELEMETRY_DISABLE;
    _resetForTests();
  });

  afterEach(function () {
    if (SAVED.path === undefined) delete process.env.SINC_MCP_TELEMETRY_PATH;
    else process.env.SINC_MCP_TELEMETRY_PATH = SAVED.path;
    if (SAVED.disable === undefined) delete process.env.SINC_MCP_TELEMETRY_DISABLE;
    else process.env.SINC_MCP_TELEMETRY_DISABLE = SAVED.disable;
    if (SAVED.max === undefined) delete process.env.SINC_MCP_TELEMETRY_MAX_ENTRIES;
    else process.env.SINC_MCP_TELEMETRY_MAX_ENTRIES = SAVED.max;
    if (SAVED.interval === undefined) delete process.env.SINC_MCP_TELEMETRY_TRIM_INTERVAL;
    else process.env.SINC_MCP_TELEMETRY_TRIM_INTERVAL = SAVED.interval;
  });

  it("getTelemetryPath defaults to ~/.dovetail-mcp/telemetry.jsonl", function () {
    delete process.env.SINC_MCP_TELEMETRY_PATH;
    var p = getTelemetryPath();
    expect(p.endsWith(path.join(".dovetail-mcp", "telemetry.jsonl"))).toBe(true);
  });

  it("getTelemetryPath honors SINC_MCP_TELEMETRY_PATH override", function () {
    process.env.SINC_MCP_TELEMETRY_PATH = "/tmp/custom.jsonl";
    expect(getTelemetryPath()).toBe("/tmp/custom.jsonl");
  });

  it("isTelemetryDisabled reads SINC_MCP_TELEMETRY_DISABLE", function () {
    process.env.SINC_MCP_TELEMETRY_DISABLE = "1";
    expect(isTelemetryDisabled()).toBe(true);
    process.env.SINC_MCP_TELEMETRY_DISABLE = "true";
    expect(isTelemetryDisabled()).toBe(true);
    process.env.SINC_MCP_TELEMETRY_DISABLE = "0";
    expect(isTelemetryDisabled()).toBe(false);
  });

  it("appends a JSONL line per recordEvent call with redacted args", async function () {
    var tmp = makeTmpPath();
    process.env.SINC_MCP_TELEMETRY_PATH = tmp;
    recordEvent({
      ts: "2026-05-08T00:00:00.000Z",
      tool: "gmail_search",
      args: { query: "from:alice", token: "secret" },
      durationMs: 42,
      success: true
    });
    recordEvent({
      ts: "2026-05-08T00:00:01.000Z",
      tool: "clickup_get_task",
      args: { taskId: "abc" },
      durationMs: 10,
      success: false,
      error: "404"
    });
    await _flushForTests();
    var contents = fs.readFileSync(tmp, "utf8").trim().split("\n");
    expect(contents.length).toBe(2);
    var first = JSON.parse(contents[0]);
    expect(first.tool).toBe("gmail_search");
    expect(first.args.query).toBe("from:alice");
    expect(first.args.token).toBe("[REDACTED]");
    var second = JSON.parse(contents[1]);
    expect(second.success).toBe(false);
    expect(second.error).toBe("404");
  });

  it("creates the telemetry file with mode 0600", async function () {
    var tmp = makeTmpPath();
    process.env.SINC_MCP_TELEMETRY_PATH = tmp;
    recordEvent({
      ts: "2026-05-08T00:00:00.000Z",
      tool: "tool",
      args: {},
      durationMs: 1,
      success: true
    });
    await _flushForTests();
    var stat = fs.statSync(tmp);
    expect((stat.mode & 0o777)).toBe(0o600);
  });

  it("respects SINC_MCP_TELEMETRY_DISABLE — no file is written", async function () {
    var tmp = makeTmpPath();
    process.env.SINC_MCP_TELEMETRY_PATH = tmp;
    process.env.SINC_MCP_TELEMETRY_DISABLE = "1";
    recordEvent({
      ts: "2026-05-08T00:00:00.000Z",
      tool: "tool",
      args: {},
      durationMs: 1,
      success: true
    });
    await _flushForTests();
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("withTelemetry records success duration", async function () {
    var tmp = makeTmpPath();
    process.env.SINC_MCP_TELEMETRY_PATH = tmp;
    var result = await withTelemetry("tool_a", { x: 1 }, async function () {
      return "ok";
    });
    expect(result).toBe("ok");
    await _flushForTests();
    var line = JSON.parse(fs.readFileSync(tmp, "utf8").trim());
    expect(line.tool).toBe("tool_a");
    expect(line.success).toBe(true);
    expect(typeof line.durationMs).toBe("number");
  });

  it("ring-buffers the file to the configured max entries", async function () {
    var tmp = makeTmpPath();
    process.env.SINC_MCP_TELEMETRY_PATH = tmp;
    process.env.SINC_MCP_TELEMETRY_MAX_ENTRIES = "10";
    process.env.SINC_MCP_TELEMETRY_TRIM_INTERVAL = "20";
    for (var i = 0; i < 100; i++) {
      recordEvent({
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        tool: "tool",
        args: { i: i },
        durationMs: 1,
        success: true
      });
    }
    await _flushForTests();
    var lines = fs.readFileSync(tmp, "utf8").trim().split("\n");
    // After 100 appends with interval=20 and max=10, trim fires 5 times and
    // the file ends up at exactly the cap.
    expect(lines.length).toBe(10);
    // The retained lines must be the most recent ones (suffix of the stream).
    var last = JSON.parse(lines[lines.length - 1]);
    expect(last.args.i).toBe(99);
    var firstRetained = JSON.parse(lines[0]);
    expect(firstRetained.args.i).toBe(90);
  });

  it("preserves mode 0600 across a trim", async function () {
    var tmp = makeTmpPath();
    process.env.SINC_MCP_TELEMETRY_PATH = tmp;
    process.env.SINC_MCP_TELEMETRY_MAX_ENTRIES = "5";
    process.env.SINC_MCP_TELEMETRY_TRIM_INTERVAL = "10";
    for (var i = 0; i < 30; i++) {
      recordEvent({
        ts: "2026-01-01T00:00:00.000Z",
        tool: "t",
        args: {},
        durationMs: 1,
        success: true
      });
    }
    await _flushForTests();
    var stat = fs.statSync(tmp);
    expect((stat.mode & 0o777)).toBe(0o600);
  });

  it("disables trimming when max entries is 0", async function () {
    var tmp = makeTmpPath();
    process.env.SINC_MCP_TELEMETRY_PATH = tmp;
    process.env.SINC_MCP_TELEMETRY_MAX_ENTRIES = "0";
    process.env.SINC_MCP_TELEMETRY_TRIM_INTERVAL = "5";
    for (var i = 0; i < 20; i++) {
      recordEvent({
        ts: "2026-01-01T00:00:00.000Z",
        tool: "t",
        args: {},
        durationMs: 1,
        success: true
      });
    }
    await _flushForTests();
    var lines = fs.readFileSync(tmp, "utf8").trim().split("\n");
    expect(lines.length).toBe(20);
  });

  it("withTelemetry records error and rethrows", async function () {
    var tmp = makeTmpPath();
    process.env.SINC_MCP_TELEMETRY_PATH = tmp;
    var caught: Error | null = null;
    try {
      await withTelemetry("tool_b", {}, async function () {
        throw new Error("boom");
      });
    } catch (e: any) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    await _flushForTests();
    var line = JSON.parse(fs.readFileSync(tmp, "utf8").trim());
    expect(line.success).toBe(false);
    expect(line.error).toBe("boom");
  });
});
