import type {
  AddChoicesResult,
  ChoiceActionResult,
  ChoiceFieldRef,
  ChoiceRemovalResult,
  RemoveChoicesResult,
} from "./types";

/**
 * The per-row tag shown in square brackets. Dry-run actions are spelled out as a verb
 * phrase ("would create") so a planned row can never be misread as a landed one — the
 * live and planned tags share no word.
 */
var ACTION_LABELS: Record<
  ChoiceActionResult["action"] | ChoiceRemovalResult["action"],
  string
> = {
  created: "created",
  updated: "updated",
  unchanged: "unchanged",
  "would-create": "would create",
  "would-update": "would update",
  deactivated: "deactivated",
  missing: "missing",
  "would-deactivate": "would deactivate",
};

/** Widest label, so every bracketed tag lines up. */
var ACTION_PAD = Object.keys(ACTION_LABELS).reduce(function (max, key) {
  var len = ACTION_LABELS[key as keyof typeof ACTION_LABELS].length;
  return len > max ? len : max;
}, 0);

function tag(action: keyof typeof ACTION_LABELS): string {
  return "[" + ACTION_LABELS[action].padEnd(ACTION_PAD) + "]";
}

/** The header lines both verbs share — same envelope, same rendering. */
function fieldHeader(
  title: string,
  field: ChoiceFieldRef,
  updateSet: { sysId: string; name: string },
  dryRun: boolean,
): Array<string> {
  var lines: Array<string> = [];
  lines.push(
    title +
      " — " +
      field.table +
      "." +
      field.column +
      " [" +
      field.language +
      "]" +
      (dryRun ? "  (DRY RUN — nothing written)" : ""),
  );
  lines.push("");
  lines.push("Update set: " + updateSet.name + " (" + updateSet.sysId + ")");
  lines.push(
    "Dictionary: " +
      field.dictionarySysId +
      (field.scope ? " [scope " + field.scope + "]" : ""),
  );
  return lines;
}

/**
 * Human-readable one-page summary of an addChoicesToField result.
 * Used by the CLI and by Claude skills when surfacing outcomes back to the user.
 */
export function formatAddChoicesResult(
  table: string,
  column: string,
  result: AddChoicesResult,
): string {
  var lines = fieldHeader(
    "ServiceNow choice values",
    result.field,
    result.updateSet,
    result.dryRun,
  );
  if (result.dictionary.choiceWas !== result.dictionary.choiceNow) {
    lines.push(
      "  sys_dictionary.choice: " +
        result.dictionary.choiceWas +
        " -> " +
        result.dictionary.choiceNow +
        (result.dryRun ? " (would change)" : ""),
    );
  } else {
    lines.push(
      "  sys_dictionary.choice: " + result.dictionary.choiceNow + " (unchanged)",
    );
  }
  lines.push("");

  var created = 0;
  var updated = 0;
  var unchanged = 0;
  lines.push("Choices:");
  result.choices.forEach(function (row) {
    if (row.action === "created" || row.action === "would-create") created += 1;
    else if (row.action === "updated" || row.action === "would-update") updated += 1;
    else unchanged += 1;
    lines.push(
      "  " +
        tag(row.action) +
        " " +
        row.value +
        " -> " +
        row.label +
        (row.sysId ? "  (" + row.sysId + ")" : ""),
    );
  });
  lines.push("");
  lines.push(
    result.dryRun
      ? "Summary (dry run): " +
          created +
          " would be created, " +
          updated +
          " would be updated, " +
          unchanged +
          " unchanged. Nothing written."
      : "Summary: " +
          created +
          " created, " +
          updated +
          " updated, " +
          unchanged +
          " unchanged.",
  );
  return lines.join("\n");
}

/**
 * Human-readable one-page summary of a removeChoicesFromField result.
 * Soft-delete semantics: "deactivated" set inactive=true; "unchanged" was already
 * inactive; "missing" was not found on the field (with a case-only near-match hint
 * when one exists); "would-deactivate" is the dry-run form of "deactivated".
 */
export function formatRemoveChoicesResult(
  table: string,
  column: string,
  result: RemoveChoicesResult,
): string {
  var lines = fieldHeader(
    "ServiceNow choice soft-delete",
    result.field,
    result.updateSet,
    result.dryRun,
  );
  lines.push("");

  var deactivated = 0;
  var unchanged = 0;
  var missing = 0;
  lines.push("Choices:");
  result.choices.forEach(function (row) {
    if (row.action === "deactivated" || row.action === "would-deactivate")
      deactivated += 1;
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
      if (row.action === "deactivated") {
        note = "  [" + row.sysIds.length + " duplicate rows, all now inactive]";
      } else if (row.action === "would-deactivate") {
        note =
          "  [" + row.sysIds.length + " duplicate rows, all would be inactive]";
      } else {
        note =
          "  [" + row.sysIds.length + " duplicate rows, all already inactive]";
      }
    }
    // Case-only near match: the strict lookup found nothing, but the field holds the
    // same spelling in a different case. Say so, and say WHY it did not match.
    if (row.action === "missing" && row.nearMatches && row.nearMatches.length > 0) {
      note =
        " — no exact match; did you mean " +
        row.nearMatches
          .map(function (v) {
            return JSON.stringify(v);
          })
          .join(" or ") +
        "? (choice values are case-sensitive)";
    }
    lines.push(
      "  " +
        tag(row.action) +
        " " +
        row.value +
        (row.sysId ? "  (" + row.sysId + ")" : "") +
        note,
    );
  });
  lines.push("");
  lines.push(
    result.dryRun
      ? "Summary (dry run): " +
          deactivated +
          " would be deactivated, " +
          unchanged +
          " unchanged, " +
          missing +
          " missing. Nothing written."
      : "Summary: " +
          deactivated +
          " deactivated, " +
          unchanged +
          " unchanged, " +
          missing +
          " missing.",
  );
  return lines.join("\n");
}
