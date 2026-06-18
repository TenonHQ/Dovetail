import {
  LEGAL_TRANSITIONS,
  legalNextStages,
  legalNextStagesIn,
  pipelineDefinition,
  PIPELINES,
  GRAIN_TRANSITIONS,
  GRAIN_STAGES
} from "../state-machine";

describe("named pipelines — additive, default byte-identical", function () {
  it("PIPELINES.default is the canonical LEGAL_TRANSITIONS (same reference, untouched)", function () {
    expect(PIPELINES.default).toBe(LEGAL_TRANSITIONS);
  });

  it("the default transition graph is byte-identical via pipelineDefinition", function () {
    expect(pipelineDefinition("default")).toBe(LEGAL_TRANSITIONS);
    expect(JSON.stringify(pipelineDefinition())).toEqual(JSON.stringify(LEGAL_TRANSITIONS));
  });

  it("legalNextStagesIn('default', ...) matches legalNextStages for sample stages", function () {
    expect(legalNextStagesIn("default", null)).toEqual(legalNextStages(null));
    expect(legalNextStagesIn("default", "research")).toEqual(legalNextStages("research"));
    expect(legalNextStagesIn("default", "documentation")).toEqual(legalNextStages("documentation"));
  });

  it("registers the grain pipeline with the discrete 8.1-8.7 substeps + gates", function () {
    expect(PIPELINES.grain).toBe(GRAIN_TRANSITIONS);
    expect(GRAIN_STAGES).toContain("8.1-test-agent");
    expect(GRAIN_STAGES).toContain("8.7-doc-changelog");
    expect(GRAIN_STAGES).toContain("gate-1-review");
    expect(legalNextStagesIn("grain", null)).toEqual(["01-meta-prompt"]);
    expect(legalNextStagesIn("grain", "8.4-story-qa")).toEqual(["8.5-code-review", "gate-2-blocked"]);
  });

  it("throws on an unknown pipeline", function () {
    expect(function () {
      pipelineDefinition("nope");
    }).toThrow(/unknown pipeline/);
  });
});
