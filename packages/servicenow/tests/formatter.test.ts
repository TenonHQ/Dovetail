import { formatRemoveChoicesResult } from "../src/formatter";
import type { ChoiceRemovalResult, RemoveChoicesResult } from "../src/types";

function resultWith(choices: Array<ChoiceRemovalResult>): RemoveChoicesResult {
  return {
    field: {
      table: "x_cadso_core_event",
      column: "state",
      language: "en",
      dictionarySysId: "dict1",
    },
    updateSet: { sysId: "us1", name: "Work" },
    choices: choices,
  };
}

describe("formatRemoveChoicesResult", function () {
  it("reports the END STATE of duplicates, not an overstated write count", function () {
    var out = formatRemoveChoicesResult(
      "x_cadso_core_event",
      "state",
      resultWith([
        {
          value: "gone",
          sysId: "a1",
          sysIds: ["a1", "a2"],
          action: "deactivated",
        },
      ]),
    );

    // On a mixed set (one duplicate already inactive, one live) only the live row is
    // written, so "all deactivated" would overstate it. "all now inactive" holds either
    // way — and the formatter cannot tell the two apart from action + sysIds alone.
    expect(out).toContain("2 duplicate rows, all now inactive");
    expect(out).not.toContain("all deactivated");
    expect(out).toContain("Summary: 1 deactivated");
  });

  it("does not claim a deactivation on 'unchanged' — that would contradict the summary", function () {
    var out = formatRemoveChoicesResult(
      "x_cadso_core_event",
      "state",
      resultWith([
        {
          value: "already_off",
          sysId: "a1",
          sysIds: ["a1", "a2"],
          action: "unchanged",
        },
      ]),
    );

    // The summary reports 0 deactivated; the per-row note must agree with it.
    expect(out).toContain("Summary: 0 deactivated");
    expect(out).not.toContain("all deactivated");
    expect(out).toContain("2 duplicate rows, all already inactive");
  });

  it("adds no duplicate note for the ordinary single-row case", function () {
    var out = formatRemoveChoicesResult(
      "x_cadso_core_event",
      "state",
      resultWith([
        { value: "gone", sysId: "a1", sysIds: ["a1"], action: "deactivated" },
        { value: "nope", sysId: "", sysIds: [], action: "missing" },
      ]),
    );

    expect(out).not.toContain("duplicate rows");
    expect(out).toContain("Summary: 1 deactivated, 0 unchanged, 1 missing.");
  });
});
