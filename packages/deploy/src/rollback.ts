/**
 * Backout reporting. In the direct-promotion model there is no PR to gate on,
 * so the safety contract is: on a preview-block or a commit failure, DO NOT
 * advance the ClickUp status — surface the reason on the task instead.
 *
 * sawmill retrieve + preview are non-destructive; a failed COMMIT may be
 * partial and sawmill never auto-retries it, so the operator must verify the
 * target before re-triggering.
 */

import type { PreviewError, ResolvedUpdateSet } from "./types";

export interface FailureReportParams {
  status: string;
  updateSet: ResolvedUpdateSet;
  reason: "preview-blocked" | "failed";
  previewErrors?: PreviewError[];
  error?: string;
}

export function formatFailureReport(params: FailureReportParams): string {
  var lines: string[] = [];
  lines.push(
    "⛔ Promotion halted (" +
      params.status +
      ") — ClickUp status NOT advanced.",
  );
  lines.push("Update set: " + params.updateSet.name);

  if (params.reason === "preview-blocked") {
    lines.push("Preview errors:");
    (params.previewErrors || []).forEach(function (e) {
      lines.push(
        "• [" +
          e.type +
          "] " +
          e.message +
          (e.targetName ? " (" + e.targetName + ")" : ""),
      );
    });
    lines.push(
      "Retrieve + preview are non-destructive; nothing was committed. Resolve the errors and re-trigger.",
    );
  } else {
    lines.push("Error: " + (params.error || "unknown"));
    lines.push(
      "A failed commit may be partial — verify the target before re-triggering (sawmill never auto-retries a commit).",
    );
  }

  return lines.join("\n");
}
