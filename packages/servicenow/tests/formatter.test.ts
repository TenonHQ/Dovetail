import { formatAddChoicesResult, formatRemoveChoicesResult } from "../src/formatter";
import type {
  AddChoicesResult,
  ChoiceActionResult,
  ChoiceRemovalResult,
  RemoveChoicesResult,
} from "../src/types";

var FIELD = {
  table: "x_cadso_core_event",
  column: "state",
  language: "en",
  scope: "scope_core",
  dictionarySysId: "dict1",
};

function resultWith(
  choices: Array<ChoiceRemovalResult>,
  dryRun?: boolean,
): RemoveChoicesResult {
  return {
    field: FIELD,
    updateSet: { sysId: "us1", name: "Work" },
    dryRun: dryRun === true,
    choices: choices,
  };
}

function addResultWith(
  choices: Array<ChoiceActionResult>,
  dryRun?: boolean,
  dictionary?: AddChoicesResult["dictionary"],
): AddChoicesResult {
  return {
    field: FIELD,
    dictionary: dictionary || { choiceWas: 3, choiceNow: 3 },
    updateSet: { sysId: "us1", name: "Work" },
    dryRun: dryRun === true,
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

  it("renders the shared field envelope — scope and dictionary sys_id on the header", function () {
    var out = formatRemoveChoicesResult("x_cadso_core_event", "state", resultWith([]));

    expect(out).toContain("x_cadso_core_event.state [en]");
    expect(out).toContain("Dictionary: dict1 [scope scope_core]");
    expect(out).not.toContain("DRY RUN");
  });

  it("dry run: every planned row says [would deactivate] and the output never says deactivated", function () {
    var out = formatRemoveChoicesResult(
      "x_cadso_core_event",
      "state",
      resultWith(
        [
          { value: "live", sysId: "a1", sysIds: ["a1", "a2"], action: "would-deactivate" },
          { value: "off", sysId: "b1", sysIds: ["b1"], action: "unchanged" },
        ],
        true,
      ),
    );

    expect(out).toContain("(DRY RUN — nothing written)");
    expect(out).toContain("[would deactivate] live");
    expect(out).toContain("2 duplicate rows, all would be inactive");
    expect(out).toContain("Summary (dry run): 1 would be deactivated, 1 unchanged, 0 missing. Nothing written.");
    // The live-path tag must be absent in every form — a dry run that prints
    // "[deactivated]" is the #296 failure shape with a different verb.
    expect(out).not.toMatch(/\[deactivated/);
    expect(out).not.toContain("all now inactive");
  });

  it("a case-only miss is reported distinctly from a genuine miss, with the stored spelling", function () {
    var out = formatRemoveChoicesResult(
      "x_cadso_core_event",
      "state",
      resultWith([
        { value: "DELIVERED", sysId: "", sysIds: [], action: "missing", nearMatches: ["delivered"] },
        { value: "gone", sysId: "", sysIds: [], action: "missing" },
      ]),
    );

    expect(out).toContain(
      '] DELIVERED — no exact match; did you mean "delivered"? (choice values are case-sensitive)',
    );
    // The genuinely-missing row carries no hint text at all.
    expect(out).toMatch(/\] gone\n/);
    expect(out).not.toMatch(/gone — no exact match/);
    // Both still count as missing — the hint changes the message, not the outcome.
    expect(out).toContain("Summary: 0 deactivated, 0 unchanged, 2 missing.");
  });

  it("offers every differently-cased spelling when the field holds more than one", function () {
    var out = formatRemoveChoicesResult(
      "x_cadso_core_event",
      "state",
      resultWith([
        {
          value: "DELIVERED",
          sysId: "",
          sysIds: [],
          action: "missing",
          nearMatches: ["delivered", "Delivered"],
        },
      ]),
    );

    expect(out).toContain('did you mean "delivered" or "Delivered"?');
  });
});

describe("formatAddChoicesResult", function () {
  it("renders the shared field envelope and the dictionary transition", function () {
    var out = formatAddChoicesResult(
      "x_cadso_core_event",
      "state",
      addResultWith(
        [{ value: "a", label: "A", sysId: "c1", sysIds: ["c1"], action: "created" }],
        false,
        { choiceWas: 0, choiceNow: 3 },
      ),
    );

    expect(out).toContain("x_cadso_core_event.state [en]");
    expect(out).toContain("Dictionary: dict1 [scope scope_core]");
    expect(out).toContain("sys_dictionary.choice: 0 -> 3");
    expect(out).not.toContain("would change");
    expect(out).toContain("] a -> A  (c1)");
    expect(out).toContain("Summary: 1 created, 0 updated, 0 unchanged.");
    expect(out).not.toContain("DRY RUN");
  });

  it("dry run: rows say [would create] / [would update] and the output never says created", function () {
    var out = formatAddChoicesResult(
      "x_cadso_core_event",
      "state",
      addResultWith(
        [
          { value: "new", label: "New", sysId: "", sysIds: [], action: "would-create" },
          { value: "old", label: "Old", sysId: "c1", sysIds: ["c1"], action: "would-update" },
          { value: "same", label: "Same", sysId: "c2", sysIds: ["c2"], action: "unchanged" },
        ],
        true,
        { choiceWas: 0, choiceNow: 3 },
      ),
    );

    expect(out).toContain("(DRY RUN — nothing written)");
    expect(out).toContain("sys_dictionary.choice: 0 -> 3 (would change)");
    expect(out).toContain("[would create");
    expect(out).toContain("] new -> New");
    expect(out).toContain("[would update");
    expect(out).toContain("] old -> Old  (c1)");
    expect(out).toContain(
      "Summary (dry run): 1 would be created, 1 would be updated, 1 unchanged. Nothing written.",
    );
    // The literal #296 failure: a dry run printing "[created]".
    expect(out).not.toMatch(/\[created/);
    expect(out).not.toMatch(/\[updated/);
  });

  it("omits the sys_id parenthetical for a planned create — there is no row yet", function () {
    var out = formatAddChoicesResult(
      "x_cadso_core_event",
      "state",
      addResultWith(
        [{ value: "new", label: "New", sysId: "", sysIds: [], action: "would-create" }],
        true,
      ),
    );

    expect(out).toMatch(/\] new -> New\n/);
    expect(out).not.toContain("()");
  });
});
