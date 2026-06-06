/**
 * JSONL telemetry — one append per tool call to ~/.dovetail-mcp/telemetry.jsonl
 * (mode 0600, dir 0700). Disable with SINC_MCP_TELEMETRY_DISABLE=1; override
 * the path with SINC_MCP_TELEMETRY_PATH.
 *
 * Fire-and-forget — handler latency must not depend on disk I/O, and a write
 * failure must never surface to the MCP client.
 *
 * Ring-buffered: file is trimmed to the most recent N entries (default 1000)
 * every TRIM_CHECK_INTERVAL appends. Worst-case file size is
 * MAX_ENTRIES + TRIM_CHECK_INTERVAL lines. Override the cap with
 * SINC_MCP_TELEMETRY_MAX_ENTRIES; 0 or negative disables trimming.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { redactArgs } from "./redact";

export interface TelemetryEvent {
  ts: string;
  tool: string;
  args: unknown;
  durationMs: number;
  success: boolean;
  error?: string;
}

var DEFAULT_MAX_ENTRIES = 1000;
var TRIM_CHECK_INTERVAL = 50;

var dirEnsured = false;
var writeQueue: Promise<void> = Promise.resolve();
var appendsSinceTrim = 0;

function getMaxEntries(): number {
  var raw = process.env.SINC_MCP_TELEMETRY_MAX_ENTRIES;
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX_ENTRIES;
  }
  var n = parseInt(raw, 10);
  if (isNaN(n)) {
    return DEFAULT_MAX_ENTRIES;
  }
  return n;
}

function getTrimInterval(): number {
  var raw = process.env.SINC_MCP_TELEMETRY_TRIM_INTERVAL;
  if (raw === undefined || raw === "") {
    return TRIM_CHECK_INTERVAL;
  }
  var n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) {
    return TRIM_CHECK_INTERVAL;
  }
  return n;
}

function maybeTrim(filePath: string): void {
  appendsSinceTrim++;
  if (appendsSinceTrim < getTrimInterval()) {
    return;
  }
  appendsSinceTrim = 0;
  var max = getMaxEntries();
  if (max <= 0) {
    return;
  }
  try {
    var content = fs.readFileSync(filePath, "utf8");
    var lines = content.split("\n").filter(function (l) {
      return l.length > 0;
    });
    if (lines.length <= max) {
      return;
    }
    var trimmed = lines.slice(lines.length - max).join("\n") + "\n";
    var tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, trimmed, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {
    // Best-effort: trimming is opportunistic. If it fails the file may grow
    // by up to one TRIM_CHECK_INTERVAL beyond the cap before the next attempt.
  }
}

export function getTelemetryPath(): string {
  if (process.env.SINC_MCP_TELEMETRY_PATH) {
    return process.env.SINC_MCP_TELEMETRY_PATH;
  }
  return path.join(os.homedir(), ".dovetail-mcp", "telemetry.jsonl");
}

export function isTelemetryDisabled(): boolean {
  var v = process.env.SINC_MCP_TELEMETRY_DISABLE;
  return v === "1" || v === "true";
}

function ensureFile(filePath: string): void {
  if (dirEnsured) {
    return;
  }
  var dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Directory may exist with different perms; appendFile will fail
    // separately if that's the real problem.
  }
  if (!fs.existsSync(filePath)) {
    try {
      fs.writeFileSync(filePath, "", { mode: 0o600 });
    } catch {
      // Swallowed — telemetry must not break callers.
    }
  } else {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort: if we can't chmod we can still append.
    }
  }
  dirEnsured = true;
}

export function recordEvent(event: Omit<TelemetryEvent, "args"> & { args: unknown }): void {
  if (isTelemetryDisabled()) {
    return;
  }
  var safe: TelemetryEvent = {
    ts: event.ts,
    tool: event.tool,
    args: redactArgs(event.args),
    durationMs: event.durationMs,
    success: event.success,
    error: event.error
  };
  var line = JSON.stringify(safe) + "\n";
  var filePath = getTelemetryPath();
  writeQueue = writeQueue.then(function () {
    return new Promise<void>(function (resolve) {
      try {
        ensureFile(filePath);
      } catch {
        resolve();
        return;
      }
      fs.appendFile(filePath, line, function () {
        maybeTrim(filePath);
        resolve();
      });
    });
  });
}

export async function withTelemetry<T>(
  tool: string,
  args: unknown,
  fn: () => Promise<T>
): Promise<T> {
  var started = Date.now();
  var ts = new Date().toISOString();
  try {
    var result = await fn();
    recordEvent({
      ts: ts,
      tool: tool,
      args: args,
      durationMs: Date.now() - started,
      success: true
    });
    return result;
  } catch (err) {
    var msg = err instanceof Error ? err.message : String(err);
    recordEvent({
      ts: ts,
      tool: tool,
      args: args,
      durationMs: Date.now() - started,
      success: false,
      error: msg
    });
    throw err;
  }
}

/**
 * Reset internal state. Test-only; not exported from index.ts.
 */
export function _resetForTests(): void {
  dirEnsured = false;
  writeQueue = Promise.resolve();
  appendsSinceTrim = 0;
}

/**
 * Flush all pending writes. Test-only.
 */
export function _flushForTests(): Promise<void> {
  return writeQueue;
}
