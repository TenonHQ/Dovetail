import {
  LEGAL_TRANSITIONS,
  IllegalTransitionError,
  ConflictRejectedError,
  assertTransition,
  checkConflict,
  legalNextStages,
} from "../state-machine";
import { PipelineStage, StageTransition } from "../types";

describe("LEGAL_TRANSITIONS coverage", function () {
  it("includes the synthetic __START__ key", function () {
    expect(LEGAL_TRANSITIONS.__START__).toBeDefined();
    expect(LEGAL_TRANSITIONS.__START__).toEqual(
      expect.arrayContaining(["research", "planning"]),
    );
  });

  it("has an entry for every pipeline stage", function () {
    var STAGES: PipelineStage[] = [
      "research",
      "pre-stage-improve",
      "planning",
      "post-plan-improve",
      "test-first",
      "code",
      "per-step-review",
      "architectural-review",
      "test-reality",
      "documentation",
    ];
    STAGES.forEach(function (s) {
      expect(LEGAL_TRANSITIONS[s]).toBeDefined();
    });
  });
});

describe("assertTransition — legal paths from each stage", function () {
  // Data-driven: every entry in LEGAL_TRANSITIONS should pass assertTransition.
  Object.keys(LEGAL_TRANSITIONS).forEach(function (from) {
    var legal = LEGAL_TRANSITIONS[from];
    legal.forEach(function (to) {
      it("accepts " + from + " -> " + to, function () {
        var fromValue = from === "__START__" ? null : (from as PipelineStage);
        expect(function () {
          assertTransition(fromValue, to);
        }).not.toThrow();
      });
    });
  });
});

describe("assertTransition — illegal paths raise IllegalTransitionError", function () {
  // Skip-forward attempts that should be rejected. Listed once per
  // illegal arrow rather than enumerating the full negative cross
  // product, which is huge.
  var illegal: Array<[PipelineStage | null, PipelineStage]> = [
    [null, "test-first"], // can't start at test-first
    [null, "documentation"], // can't start at documentation
    ["research", "code"], // skip planning + test-first
    ["research", "documentation"], // far skip
    ["planning", "code"], // skip test-first
    ["planning", "documentation"], // skip everything
    ["test-first", "documentation"], // skip code + reviews
    ["code", "documentation"], // skip reviews
    ["per-step-review", "documentation"], // skip architectural-review
    ["per-step-review", "test-reality"], // can only reach via architectural-review
    ["test-reality", "research"], // can't roll back to start
    ["documentation", "research"], // terminal stage can't reverse
  ];

  illegal.forEach(function (pair) {
    it("rejects " + (pair[0] || "<start>") + " -> " + pair[1], function () {
      expect(function () {
        assertTransition(pair[0], pair[1]);
      }).toThrow(IllegalTransitionError);
    });
  });

  it("attaches the legal-next list to the error for actionable messaging", function () {
    var threw: IllegalTransitionError | null = null;
    try {
      assertTransition("research", "test-first");
    } catch (e) {
      threw = e as any;
    }
    expect(threw).not.toBeNull();
    expect((threw as any).legal).toEqual(LEGAL_TRANSITIONS.research);
    expect((threw as Error).message).toMatch(/legal next/);
  });
});

describe("checkConflict — dashboard-wins with 30s grace", function () {
  function makeTransition(
    source: "code" | "dashboard",
    atMs: number,
  ): StageTransition {
    return {
      from: null,
      to: "research",
      at: new Date(atMs).toISOString(),
      by: "test",
      source: source,
    };
  }

  it("accepts a dashboard-sourced write unconditionally (no history)", function () {
    expect(function () {
      checkConflict([], "dashboard");
    }).not.toThrow();
  });

  it("accepts a dashboard-sourced write even right after a dashboard transition", function () {
    var now = 1_000_000;
    var history = [makeTransition("dashboard", now - 1000)];
    expect(function () {
      checkConflict(history, "dashboard", { nowMs: now });
    }).not.toThrow();
  });

  it("accepts a code-sourced write when history is empty", function () {
    expect(function () {
      checkConflict([], "code");
    }).not.toThrow();
  });

  it("accepts a code-sourced write after a code-sourced transition", function () {
    var now = 1_000_000;
    var history = [makeTransition("code", now - 1000)];
    expect(function () {
      checkConflict(history, "code", { nowMs: now });
    }).not.toThrow();
  });

  it("REJECTS a code-sourced write within 30s of a dashboard transition", function () {
    var now = 1_000_000;
    var history = [makeTransition("dashboard", now - 5_000)]; // 5s ago
    expect(function () {
      checkConflict(history, "code", { nowMs: now });
    }).toThrow(ConflictRejectedError);
  });

  it("accepts a code-sourced write past the 30s grace window", function () {
    var now = 1_000_000;
    var history = [makeTransition("dashboard", now - 31_000)]; // 31s ago
    expect(function () {
      checkConflict(history, "code", { nowMs: now });
    }).not.toThrow();
  });

  it("respects a custom grace window override", function () {
    var now = 1_000_000;
    var history = [makeTransition("dashboard", now - 1_000)]; // 1s ago
    // Grace = 500ms — incoming code write should accept.
    expect(function () {
      checkConflict(history, "code", { nowMs: now, graceMs: 500 });
    }).not.toThrow();
  });
});

describe("legalNextStages", function () {
  it("returns the start set for null", function () {
    expect(legalNextStages(null)).toEqual(["research", "planning"]);
  });
  it("returns the entry for a known stage", function () {
    expect(legalNextStages("code")).toEqual(["per-step-review", "test-first"]);
  });
});
