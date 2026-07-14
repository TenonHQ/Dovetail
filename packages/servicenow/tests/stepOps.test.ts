import {
  applyStepOps,
  findStep,
  formatStepPill,
  hasStepOps,
  summarizeSteps,
  verifySteps
} from "../src/flowDesigner/stepOps";
import type { StepRecord } from "../src/flowDesigner/stepOps";

var PARSE_CID = "c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
var HANDLE_CID = "c2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

var SCRIPT = "(function execute(inputs, outputs) {\n  outputs.body = inputs.responseBody;\n})(inputs, outputs);";

/**
 * A two-step graph shaped like the live payload: some fields bare, some wrapped
 * as { value: x }, and IO entries carrying more keys than we ever set — which is
 * exactly why new entries must be mirrored rather than hand-authored.
 */
function graph(): Array<StepRecord> {
  return [
    {
      cid: PARSE_CID,
      label: "Parse Response",
      action: "orig",
      inputs: [{ name: "script", value: SCRIPT }],
      extended_inputs: [
        {
          name: "responseBody",
          label: "Response Body",
          type: "string",
          type_label: "String",
          order: 100,
          mandatory: true,
          sys_id: "sibling_in_sysid",
          value: "{{step[c0].payload}}",
          // The keys we never touch — these must survive verbatim on a mirrored entry.
          attributes: "edge_encryption_enabled=true",
          reference: ""
        }
      ],
      extended_outputs: [
        {
          name: "body",
          label: "Body",
          type: { value: "string" }, // wrapped — the shape must be preserved
          type_label: "String",
          order: 100,
          mandatory: false,
          sys_id: "sibling_out_sysid",
          value: "",
          attributes: "edge_encryption_enabled=true"
        }
      ]
    },
    {
      cid: HANDLE_CID,
      label: "Handle Error",
      action: "orig",
      inputs: [{ name: "script", value: "(function execute(inputs, outputs) { outputs.done = true; })(inputs, outputs);" }],
      extended_inputs: [
        {
          name: "errorMessage",
          label: "Error Message",
          type: "string",
          type_label: "String",
          order: 100,
          mandatory: false,
          sys_id: "sibling_err_sysid",
          value: "",
          attributes: "edge_encryption_enabled=true"
        }
      ],
      extended_outputs: []
    }
  ];
}

describe("stepOps — step lookup", function () {
  it("finds a step by cid and by label", function () {
    var steps = graph();
    expect(findStep(steps, PARSE_CID).label).toBe("Parse Response");
    expect(findStep(steps, "Handle Error").cid).toBe(HANDLE_CID);
  });

  it("throws listing the available steps when the ref is unknown", function () {
    expect(function () { findStep(graph(), "Nope"); })
      .toThrow(/step not found: 'Nope'.*Parse Response.*Handle Error/s);
  });
});

describe("stepOps — the data-pill format", function () {
  // Invariant 1: {{step[<cid>].<output>}}, NOT {{<cid>.<output>}}. A wrong pill
  // publishes fine and silently resolves to undefined at runtime.
  it("is {{step[cid].output}}", function () {
    expect(formatStepPill(PARSE_CID, "isRetryable")).toBe("{{step[" + PARSE_CID + "].isRetryable}}");
  });
});

describe("stepOps — applyStepOps", function () {
  it("patches several steps' scripts in one pass, addressing by cid and by label", function () {
    var steps = graph();
    var res = applyStepOps(steps, {
      patchStepScripts: [
        { step: PARSE_CID, patchScript: { find: "outputs.body", replace: "outputs.parsed" } },
        { step: "Handle Error", setScript: "(function execute(inputs, outputs) { outputs.done = false; })(inputs, outputs);" }
      ]
    });
    var parsed = res.steps[0].inputs as Array<Record<string, unknown>>;
    var handled = res.steps[1].inputs as Array<Record<string, unknown>>;
    expect(parsed[0].value).toContain("outputs.parsed");
    expect(handled[0].value).toContain("outputs.done = false");
    expect(res.changes.length).toBe(2);
    expect(res.touchedCids).toEqual([PARSE_CID, HANDLE_CID]);
  });

  it("never mutates the input graph", function () {
    var steps = graph();
    applyStepOps(steps, { patchStepScripts: [{ step: PARSE_CID, setScript: "replaced" }] });
    var inputs = steps[0].inputs as Array<Record<string, unknown>>;
    expect(inputs[0].value).toBe(SCRIPT);
  });

  it("mirrors the sibling entry shape when adding a step output — preserving wrapped fields and untouched keys", function () {
    var res = applyStepOps(graph(), {
      addStepOutputs: [{ step: "Parse Response", name: "isRetryable", label: "Is Retryable", type: "boolean" }]
    });
    var outputs = res.steps[0].extended_outputs as Array<Record<string, unknown>>;
    expect(outputs.length).toBe(2);
    var added = outputs[1];
    expect(added.name).toBe("isRetryable");
    expect(added.label).toBe("Is Retryable");
    // `type` was wrapped on the sibling — the new entry must stay wrapped.
    expect(added.type).toEqual({ value: "boolean" });
    expect(added.type_label).toBe("Boolean");
    expect(added.order).toBe(101);
    // Identity must NOT be inherited from the sibling.
    expect(added.sys_id).toBe("");
    // Keys we don't own carry over verbatim — the whole point of mirroring.
    expect(added.attributes).toBe("edge_encryption_enabled=true");
  });

  it("wires a step input to another step's output with a correctly-formatted pill", function () {
    var res = applyStepOps(graph(), {
      addStepOutputs: [{ step: "Parse Response", name: "isRetryable", type: "boolean" }],
      addStepInputs: [{
        step: "Handle Error",
        name: "isRetryable",
        type: "boolean",
        pillFrom: { step: "Parse Response", output: "isRetryable" }
      }]
    });
    var inputs = res.steps[1].extended_inputs as Array<Record<string, unknown>>;
    expect(inputs.length).toBe(2);
    expect(inputs[1].name).toBe("isRetryable");
    expect(inputs[1].value).toBe("{{step[" + PARSE_CID + "].isRetryable}}");
    // The output was added in the SAME call — order-independence holds.
    expect(res.warnings.join(" ")).not.toContain("resolve to undefined");
  });

  it("warns when a pill points at an output that does not exist", function () {
    var res = applyStepOps(graph(), {
      addStepInputs: [{
        step: "Handle Error",
        name: "ghost",
        pillFrom: { step: "Parse Response", output: "notAThing" }
      }]
    });
    expect(res.warnings.join(" ")).toContain("resolve to undefined");
  });

  it("refuses to guess an entry shape when there is no sibling to mirror", function () {
    // Handle Error has an empty extended_outputs list.
    expect(function () {
      applyStepOps(graph(), { addStepOutputs: [{ step: "Handle Error", name: "whatever" }] });
    }).toThrow(/no existing extended_outputs entry to mirror/);
  });

  it("is idempotent — an already-present name is skipped, not duplicated", function () {
    var res = applyStepOps(graph(), {
      addStepOutputs: [{ step: "Parse Response", name: "body", type: "string" }]
    });
    var outputs = res.steps[0].extended_outputs as Array<Record<string, unknown>>;
    expect(outputs.length).toBe(1);
    expect(res.changes.length).toBe(0);
    expect(res.warnings.join(" ")).toContain("already present");
  });

  it("rejects a name that would break the payload", function () {
    expect(function () {
      applyStepOps(graph(), { addStepOutputs: [{ step: "Parse Response", name: "bad}}name" }] });
    }).toThrow(/invalid output name/);
  });

  it("warns instead of throwing when a script patch finds nothing", function () {
    var res = applyStepOps(graph(), {
      patchStepScripts: [{ step: PARSE_CID, patchScript: { find: "absent", replace: "x" } }]
    });
    expect(res.changes.length).toBe(0);
    expect(res.touchedCids).toEqual([]);
    expect(res.warnings.join(" ")).toContain("not present");
  });
});

describe("stepOps — verifySteps", function () {
  it("passes when the read-back matches what was sent", function () {
    var res = applyStepOps(graph(), {
      addStepOutputs: [{ step: "Parse Response", name: "isRetryable", type: "boolean" }]
    });
    var sent = summarizeSteps(res.steps);
    var verdict = verifySteps(sent, sent, res.touchedCids);
    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join(" ")).toContain("Parse Response' verified");
  });

  it("fails when the instance dropped an output we published", function () {
    var res = applyStepOps(graph(), {
      addStepOutputs: [{ step: "Parse Response", name: "isRetryable", type: "boolean" }]
    });
    var sent = summarizeSteps(res.steps);
    var readBack = summarizeSteps(graph()); // the instance still has the ORIGINAL graph
    var verdict = verifySteps(sent, readBack, res.touchedCids);
    expect(verdict.ok).toBe(false);
    expect(verdict.notes.join(" ")).toContain("extended_output 'isRetryable' absent on read-back");
  });

  it("fails when the script on the instance is not the one we sent", function () {
    var res = applyStepOps(graph(), {
      patchStepScripts: [{ step: PARSE_CID, setScript: "a much longer script than the original one, truly" }]
    });
    var verdict = verifySteps(summarizeSteps(res.steps), summarizeSteps(graph()), res.touchedCids);
    expect(verdict.ok).toBe(false);
    expect(verdict.notes.join(" ")).toContain("does not match what was sent");
  });

  it("fails on a DIFFERENT script of the SAME length — length is not identity", function () {
    var sent = applyStepOps(graph(), { patchStepScripts: [{ step: PARSE_CID, setScript: "outputs.a = 1;" }] });
    var landed = applyStepOps(graph(), { patchStepScripts: [{ step: PARSE_CID, setScript: "outputs.b = 2;" }] });
    var sentSummary = summarizeSteps(sent.steps);
    var landedSummary = summarizeSteps(landed.steps);

    expect(sentSummary[0].scriptChars).toBe(landedSummary[0].scriptChars); // same length...
    var verdict = verifySteps(sentSummary, landedSummary, sent.touchedCids);
    expect(verdict.ok).toBe(false); // ...but must NOT verify
  });

  it("fails when a pill landed MIS-WIRED — the entry is present but points at the wrong output", function () {
    // The whole point of the feature: a wrong pill publishes fine and silently
    // reads undefined at runtime. A name-only check would call this verified.
    var sent = applyStepOps(graph(), {
      addStepOutputs: [{ step: "Parse Response", name: "isRetryable", type: "boolean" }],
      addStepInputs: [{
        step: "Handle Error", name: "isRetryable", type: "boolean",
        pillFrom: { step: "Parse Response", output: "isRetryable" }
      }]
    });
    var landed = summarizeSteps(sent.steps);
    // Same entry name, wrong pill value — what a bad publish would look like.
    landed[1].extendedInputs[1].value = "{{step[" + PARSE_CID + "].body}}";

    var verdict = verifySteps(summarizeSteps(sent.steps), landed, sent.touchedCids);
    expect(verdict.ok).toBe(false);
    expect(verdict.notes.join(" ")).toContain("expected '{{step[" + PARSE_CID + "].isRetryable}}'");
  });

  it("fails when an IO entry landed with the wrong type", function () {
    var sent = applyStepOps(graph(), {
      addStepOutputs: [{ step: "Parse Response", name: "isRetryable", type: "boolean" }]
    });
    var landed = summarizeSteps(sent.steps);
    landed[0].extendedOutputs[1].type = "string";

    var verdict = verifySteps(summarizeSteps(sent.steps), landed, sent.touchedCids);
    expect(verdict.ok).toBe(false);
    expect(verdict.notes.join(" ")).toContain("has type 'string' on the instance, expected 'boolean'");
  });
});

describe("stepOps — hasStepOps", function () {
  it("distinguishes step ops from action-level ops", function () {
    expect(hasStepOps({})).toBe(false);
    expect(hasStepOps({ addStepOutputs: [] })).toBe(false);
    expect(hasStepOps({ addStepOutputs: [{ step: "a", name: "b" }] })).toBe(true);
  });
});
