/**
 * Human-readable summaries of layout-tooling results — used by the dove-sn CLI
 * and by Claude skills when surfacing outcomes back to the user.
 */

import type { LayoutResult, CreateViewResult } from "../types";

/**
 * One-page summary of a setFormLayout / setListLayout / setRelatedLists result.
 * `kind` is a short label such as "form layout" or "list layout".
 */
export function formatLayoutResult(kind: string, result: LayoutResult): string {
  var lines: Array<string> = [];
  var viewLabel = result.view === "" ? "Default view" : result.view;
  lines.push(
    "ServiceNow " + kind + " — " + result.table + " [" + viewLabel + "]"
    + (result.dryRun ? "  (DRY RUN — nothing written)" : "")
  );
  lines.push("");
  lines.push("Update set: " + result.updateSet.name + " (" + result.updateSet.sysId + ")");
  lines.push("");

  var counts: Record<string, number> = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  lines.push("Records:");
  result.records.forEach(function (row) {
    counts[row.action] = (counts[row.action] || 0) + 1;
    lines.push(
      "  [" + row.action.padEnd(9) + "] " + row.table.padEnd(22) + " " + row.label
      + (row.sysId ? "  (" + row.sysId + ")" : "")
    );
  });
  lines.push("");
  lines.push(
    "Summary: " + counts.created + " created, " + counts.updated + " updated, "
    + counts.deleted + " deleted, " + counts.unchanged + " unchanged."
  );
  return lines.join("\n");
}

/** One-page summary of a createView result. */
export function formatCreateViewResult(result: CreateViewResult): string {
  var lines: Array<string> = [];
  lines.push(
    "ServiceNow view — " + result.view.name
    + (result.dryRun ? "  (DRY RUN — nothing written)" : "")
  );
  lines.push("");
  lines.push("Update set: " + result.updateSet.name + " (" + result.updateSet.sysId + ")");
  lines.push(
    "View: " + result.view.name + " / \"" + result.view.title + "\"  ["
    + result.view.action + "]" + (result.view.sysId ? "  (" + result.view.sysId + ")" : "")
  );
  return lines.join("\n");
}
