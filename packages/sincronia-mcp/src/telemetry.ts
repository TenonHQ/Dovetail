/**
 * JSONL telemetry — one append per tool call to ~/.sincronia-mcp/telemetry.jsonl
 * (mode 0600, dir 0700). Disable with SINC_MCP_TELEMETRY_DISABLE=1; override
 * the path with SINC_MCP_TELEMETRY_PATH.
 *
 * Fire-and-forget — handler latency must not depend on disk I/O, and a write
 * failure must never surface to the MCP client.
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

var dirEnsured = false;
var writeQueue: Promise<void> = Promise.resolve();

export function getTelemetryPath(): string {
  if (process.env.SINC_MCP_TELEMETRY_PATH) {
    return process.env.SINC_MCP_TELEMETRY_PATH;
  }
  return path.join(os.homedir(), ".sincronia-mcp", "telemetry.jsonl");
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
}

/**
 * Flush all pending writes. Test-only.
 */
export function _flushForTests(): Promise<void> {
  return writeQueue;
}
