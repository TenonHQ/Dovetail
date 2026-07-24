import {
  resolveExecutionContext,
  isCiEnvironment,
  evaluateWriteGate,
  assertWriteAllowed,
} from "../src/executionContext";
import type { WriteGateInput } from "../src/executionContext";

describe("resolveExecutionContext", function () {
  it("defaults to local when there is no CI signal and no override (fail closed)", function () {
    expect(resolveExecutionContext({ env: {} })).toBe("local");
  });

  it("detects automation from GITHUB_ACTIONS", function () {
    expect(resolveExecutionContext({ env: { GITHUB_ACTIONS: "true" } })).toBe(
      "automation",
    );
  });

  it("detects automation from the generic CI marker (true or 1)", function () {
    expect(resolveExecutionContext({ env: { CI: "true" } })).toBe("automation");
    expect(resolveExecutionContext({ env: { CI: "1" } })).toBe("automation");
  });

  it("does NOT treat CI=false as automation", function () {
    expect(resolveExecutionContext({ env: { CI: "false" } })).toBe("local");
  });

  it("explicit override beats auto-detect — local wins even inside CI", function () {
    expect(
      resolveExecutionContext({
        override: "local",
        env: { GITHUB_ACTIONS: "true" },
      }),
    ).toBe("local");
  });

  it("explicit override beats auto-detect — automation wins outside CI", function () {
    expect(resolveExecutionContext({ override: "automation", env: {} })).toBe(
      "automation",
    );
  });

  it("normalises override case and whitespace", function () {
    expect(
      resolveExecutionContext({ override: "  Automation ", env: {} }),
    ).toBe("automation");
  });

  it("rejects an unrecognised override rather than silently defaulting", function () {
    expect(function () {
      resolveExecutionContext({ override: "prod", env: {} });
    }).toThrow(/must be 'local' or 'automation'/);
  });
});

describe("isCiEnvironment", function () {
  it("is true for a CI signal and false otherwise", function () {
    expect(isCiEnvironment({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCiEnvironment({ CI: "true" })).toBe(true);
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ CI: "false" })).toBe(false);
  });
});

describe("evaluateWriteGate — local", function () {
  it("refuses a local write with no confirmation (two-phase)", function () {
    var d = evaluateWriteGate({ context: "local", destructive: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/two-phase/);
  });

  it("allows a local write once confirmed", function () {
    var d = evaluateWriteGate({
      context: "local",
      destructive: false,
      confirmed: true,
    });
    expect(d.allowed).toBe(true);
  });

  it("allows a local DESTRUCTIVE write on confirm alone — no merge signal needed locally", function () {
    var d = evaluateWriteGate({
      context: "local",
      destructive: true,
      confirmed: true,
    });
    expect(d.allowed).toBe(true);
  });
});

describe("evaluateWriteGate — automation", function () {
  it("allows a non-destructive automation write without confirm or merge signal", function () {
    var d = evaluateWriteGate({ context: "automation", destructive: false });
    expect(d.allowed).toBe(true);
  });

  it("refuses a destructive automation write with no merge signal (fail closed)", function () {
    var d = evaluateWriteGate({ context: "automation", destructive: true });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/merged-PR signal/);
  });

  it("refuses when the merge signal has no ref", function () {
    var d = evaluateWriteGate({
      context: "automation",
      destructive: true,
      mergeSignal: { mergeRef: "", changePresent: true },
    });
    expect(d.allowed).toBe(false);
  });

  it("refuses when the change is not present in the merged diff", function () {
    var d = evaluateWriteGate({
      context: "automation",
      destructive: true,
      mergeSignal: { mergeRef: "abc123", changePresent: false },
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/not present in the merged diff/);
  });

  it("allows a destructive automation write with a valid, change-present merge signal", function () {
    var d = evaluateWriteGate({
      context: "automation",
      destructive: true,
      mergeSignal: { mergeRef: "abc123", changePresent: true },
    });
    expect(d.allowed).toBe(true);
  });
});

describe("assertWriteAllowed", function () {
  var refused: WriteGateInput = { context: "local", destructive: true };
  var allowed: WriteGateInput = {
    context: "local",
    destructive: true,
    confirmed: true,
  };

  it("throws on a refused write", function () {
    expect(function () {
      assertWriteAllowed(refused);
    }).toThrow(/two-phase/);
  });

  it("does not throw on an allowed write", function () {
    expect(function () {
      assertWriteAllowed(allowed);
    }).not.toThrow();
  });
});
