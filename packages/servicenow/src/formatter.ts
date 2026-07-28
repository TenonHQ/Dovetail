import type { AddChoicesResult } from "./types";

/**
 * Human-readable one-page summary of an addChoicesToField result.
 * Used by the CLI and by Claude skills when surfacing outcomes back to the user.
 */
export function formatAddChoicesResult(
  table: string,
  column: string,
  result: AddChoicesResult
): string {
  var lines: Array<string> = [];
  lines.push("ServiceNow choice values — " + table + "." + column);
  lines.push("");
  lines.push("Update set: " + result.updateSet.name + " (" + result.updateSet.sysId + ")");
  lines.push("Dictionary: " + result.dictionary.sysId + " [scope " + result.dictionary.scope + "]");
  if (result.dictionary.choiceWas !== result.dictionary.choiceNow) {
    lines.push(
      "  sys_dictionary.choice: " + result.dictionary.choiceWas + " -> " + result.dictionary.choiceNow
    );
  } else {
    lines.push("  sys_dictionary.choice: " + result.dictionary.choiceNow + " (unchanged)");
  }
  lines.push("");

  var created = 0;
  var updated = 0;
  var unchanged = 0;
  lines.push("Choices:");
  result.choices.forEach(function (row) {
    if (row.action === "created") created += 1;
    else if (row.action === "updated") updated += 1;
    else unchanged += 1;
    lines.push(
      "  [" + row.action.padEnd(9) + "] " + row.value + " -> " + row.label +
      "  (" + row.sysId + ")"
    );
  });
  lines.push("");
  lines.push(
    "Summary: " + created + " created, " + updated + " updated, " + unchanged + " unchanged."
  );
  return lines.join("\n");
}
