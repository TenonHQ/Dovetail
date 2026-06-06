/**
 * Maps thrown errors from upstream Dovetail packages into MCP tool-result
 * shapes. Upstream packages already produce remediation-friendly messages
 * (e.g. handleAuthError in dovetail-google-auth) — preserve them verbatim.
 */

export interface ToolError {
  message: string;
  retryable: boolean;
}

export function mapToolError(err: unknown): ToolError {
  var message = err instanceof Error ? err.message : String(err);
  var retryable = isRetryable(message);
  return { message: message, retryable: retryable };
}

function isRetryable(message: string): boolean {
  var m = message.toLowerCase();
  if (m.indexOf("rate limit") !== -1) return true;
  if (m.indexOf("429") !== -1) return true;
  if (m.indexOf("network") !== -1) return true;
  if (m.indexOf("etimedout") !== -1) return true;
  if (m.indexOf("econnreset") !== -1) return true;
  if (m.indexOf("retries exhausted") !== -1) return true;
  return false;
}
