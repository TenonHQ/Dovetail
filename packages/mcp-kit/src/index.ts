/**
 * @tenonhq/dovetail-mcp-kit
 *
 * Shared MCP tool-registration kit for Dovetail's MCP servers. Provides the
 * annotation presets, the unified actionable+retryable error contract, the
 * JSONL telemetry primitive, and the registerTool plumbing (incl. optional
 * outputSchema → structuredContent) that dovetail-mcp, dovetail-servicenow, and
 * dovetail-claude-plans all build their registries on.
 */

export type { ToolAnnotations } from "./annotations";
export {
  READ_ONLY,
  WRITE_ADDITIVE_IDEMPOTENT,
  WRITE_CREATE,
  WRITE_OVERWRITE,
  WRITE_EXECUTE
} from "./annotations";

export type { KitToolDescriptor } from "./descriptor";

export type { ToolError } from "./errors";
export { mapToolError } from "./errors";

export { redactArgs } from "./redact";

export type { TelemetryEvent } from "./telemetry";
export {
  withTelemetry,
  recordEvent,
  getTelemetryPath,
  isTelemetryDisabled,
  _resetForTests,
  _flushForTests
} from "./telemetry";

export type { RegisterOptions } from "./register";
export { registerKitTool, registerKitTools } from "./register";
