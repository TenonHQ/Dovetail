import type { AddChoicesResult, RemoveChoicesResult } from "./types";

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

/**
 * Human-readable one-page summary of a removeChoicesFromField result.
 * Soft-delete semantics: "deactivated" set inactive=true; "unchanged" was already
 * inactive; "missing" was not found on the field.
 */
export function formatRemoveChoicesResult(
  table: string,
  column: string,
  result: RemoveChoicesResult,
): string {
  var lines: Array<string> = [];
  lines.push(
    "ServiceNow choice soft-delete — " +
      table +
      "." +
      column +
      " [" +
      result.field.language +
      "]",
  );
  lines.push("");
  lines.push(
    "Update set: " +
      result.updateSet.name +
      " (" +
      result.updateSet.sysId +
      ")",
  );
  lines.push("Dictionary: " + result.field.dictionarySysId);
  lines.push("");

  var deactivated = 0;
  var unchanged = 0;
  var missing = 0;
  lines.push("Choices:");
  result.choices.forEach(function (row) {
    if (row.action === "deactivated") deactivated += 1;
    else if (row.action === "unchanged") unchanged += 1;
    else missing += 1;
    // A value with more than one row is worth saying out loud — the field carries
    // duplicates. The wording has to follow the action: on "unchanged" nothing was
    // written, so claiming they were deactivated would contradict the summary below.
    // "all now inactive" rather than "all deactivated": on a mixed set — one duplicate
    // already inactive, one live — only the live row is written, so claiming both were
    // deactivated overstates it. End state is what the reader needs, and it is true in
    // both cases.
    var note = "";
    if (row.sysIds.length > 1) {
      note =
        row.action === "deactivated"
          ? "  [" + row.sysIds.length + " duplicate rows, all now inactive]"
          : "  [" + row.sysIds.length + " duplicate rows, all already inactive]";
    }
    lines.push(
      "  [" +
        row.action.padEnd(11) +
        "] " +
        row.value +
        (row.sysId ? "  (" + row.sysId + ")" : "") +
        note,
    );
  });
  lines.push("");
  lines.push(
    "Summary: " +
      deactivated +
      " deactivated, " +
      unchanged +
      " unchanged, " +
      missing +
      " missing.",
  );
  return lines.join("\n");
}
