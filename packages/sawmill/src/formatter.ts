/**
 * Formatters for @tenonhq/dovetail-sawmill.
 * Human-readable rendering of promote results and preview errors.
 */
import { PromoteResponse, PreviewError } from "./types";

/**
 * @description Formats a Sawmill promote result as a terse multi-line summary —
 * commit state, remote update set sys_id, elapsed time, and preview errors.
 * @param result - The promote response returned by the Sawmill client.
 * @returns Plain-text summary string.
 */
export function formatPromoteResult(result: PromoteResponse): string {
  var lines: string[] = [];

  var isCommitted = result.committed === true;
  lines.push(
    "Sawmill promote: " +
      (isCommitted ? "committed" : "previewed (not committed)"),
  );

  var sysId =
    result.remoteUpdateSetSysId !== undefined &&
    result.remoteUpdateSetSysId !== ""
      ? result.remoteUpdateSetSysId
      : "(unknown)";
  lines.push("Remote update set: " + sysId);

  lines.push("Elapsed: " + formatElapsed(result.elapsedMs));

  var errors =
    result.previewErrors !== undefined && result.previewErrors !== null
      ? result.previewErrors
      : [];
  if (errors.length === 0) {
    lines.push("Preview errors: none");
  } else {
    lines.push("Preview errors: " + errors.length);
    lines.push(formatPreviewErrors(errors));
  }

  return lines.join("\n");
}

/**
 * @description Formats a list of preview errors as a readable, indented list.
 * Each line shows the error type, message, and target when present.
 * @param errors - The preview errors to render.
 * @returns Plain-text list, or "No preview errors" for an empty array.
 */
export function formatPreviewErrors(errors: PreviewError[]): string {
  if (!errors || errors.length === 0) {
    return "No preview errors";
  }

  var lines: string[] = [];
  for (var i = 0; i < errors.length; i++) {
    var err = errors[i];
    var type = err.type !== undefined && err.type !== "" ? err.type : "unknown";
    var message =
      err.message !== undefined && err.message !== ""
        ? err.message
        : "(no message)";
    var line = "  - [" + type + "] " + message;

    var target = formatTarget(err);
    if (target !== "") {
      line = line + " (" + target + ")";
    }

    lines.push(line);
  }

  return lines.join("\n");
}

// --- Helpers ---

function formatElapsed(elapsedMs: number): string {
  if (typeof elapsedMs !== "number" || isNaN(elapsedMs) || elapsedMs < 0) {
    return "unknown";
  }
  var seconds = elapsedMs / 1000;
  // One decimal place; trim a trailing ".0" for whole-second values.
  var rounded = Math.round(seconds * 10) / 10;
  var text = rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
  return text + "s";
}

function formatTarget(err: PreviewError): string {
  var parts: string[] = [];

  if (err.targetTable !== undefined && err.targetTable !== "") {
    parts.push("table: " + err.targetTable);
  }
  if (err.targetName !== undefined && err.targetName !== "") {
    parts.push("name: " + err.targetName);
  }
  if (err.sysId !== undefined && err.sysId !== "") {
    parts.push("sys_id: " + err.sysId);
  }

  return parts.join(", ");
}
