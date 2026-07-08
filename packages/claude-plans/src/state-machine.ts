/**
 * Pipeline stage state machine — single source of truth for legal
 * transitions and conflict resolution. Consumed by setStage (Phase C),
 * pullPlan read-time normalization (Phase C), and dispatch_stage's
 * pre-spawn re-check (Phase D).
 *
 * Design contract: docs/v2-design.md §3 + §4. The transition table
 * matches §3.2; the conflict rule matches §4.2 (dashboard-wins with
 * 30-second grace).
 */

import { PipelineStage, StageTransition, StageTransitionSource } from "./types";

/**
 * Legal next-stage set per current stage. The synthetic "__START__"
 * key encodes the initial transitions allowed when plan.stage is null.
 * Self-loops are deliberate where allowed (re-research, re-plan,
 * re-doc); they are observable in stage_history and let the dashboard
 * surface a "re-ran this stage" indicator.
 */
export var LEGAL_TRANSITIONS: Record<string, PipelineStage[]> = {
  __START__: ["research", "planning"],
  research: ["pre-stage-improve", "planning", "research"],
  "pre-stage-improve": ["planning", "research"],
  planning: ["post-plan-improve", "test-first", "research", "planning"],
  "post-plan-improve": ["test-first", "planning"],
  "test-first": ["code", "planning"],
  code: ["per-step-review", "test-first"],
  "per-step-review": ["code", "architectural-review"],
  "architectural-review": ["per-step-review", "test-reality", "documentation"],
  "test-reality": ["documentation", "code"],
  documentation: ["documentation"],
};

export class IllegalTransitionError extends Error {
  public code: string;
  public from: PipelineStage | null;
  public to: PipelineStage;
  public legal: PipelineStage[];
  constructor(
    from: PipelineStage | null,
    to: PipelineStage,
    legal: PipelineStage[],
  ) {
    super(
      "illegal stage transition " +
        (from || "<start>") +
        " -> " +
        to +
        "; legal next: " +
        (legal.length > 0 ? legal.join(", ") : "<none>"),
    );
    this.name = "IllegalTransitionError";
    this.code = "ILLEGAL_TRANSITION";
    this.from = from;
    this.to = to;
    this.legal = legal;
  }
}

export class ConflictRejectedError extends Error {
  public code: string;
  public winning: StageTransition;
  constructor(winning: StageTransition) {
    super(
      "code-sourced transition rejected; last dashboard-sourced move " +
        "to " +
        winning.to +
        " at " +
        winning.at +
        " is within the grace window",
    );
    this.name = "ConflictRejectedError";
    this.code = "CONFLICT_REJECTED";
    this.winning = winning;
  }
}

/**
 * Return the set of legal next stages from `from` (null = start state).
 * Pure — useful for the dashboard's Stage Map highlight.
 */
export function legalNextStages(from: PipelineStage | null): PipelineStage[] {
  return LEGAL_TRANSITIONS[from || "__START__"] || [];
}

/**
 * Throws IllegalTransitionError when `to` is not reachable from `from`.
 * Returns silently on success.
 */
export function assertTransition(
  from: PipelineStage | null,
  to: PipelineStage,
): void {
  var legal = legalNextStages(from);
  if (legal.indexOf(to) === -1) {
    throw new IllegalTransitionError(from, to, legal);
  }
}

export interface ConflictResolution {
  /** Operator-tunable grace window for the dashboard-wins rule. */
  graceMs?: number;
  /** Override "now" — useful for deterministic tests. */
  nowMs?: number;
}

/**
 * Resolve a write conflict between a code-sourced and dashboard-sourced
 * transition. The rule (design doc §4.2): dashboard writes always
 * accept; code writes are rejected if the last recorded transition was
 * dashboard-sourced and fell within `graceMs` of now.
 *
 * Returns silently when the incoming write is accepted; throws
 * ConflictRejectedError when rejected.
 */
export function checkConflict(
  history: StageTransition[],
  incomingSource: StageTransitionSource,
  options: ConflictResolution = {},
): void {
  if (incomingSource === "dashboard") return; // dashboard always wins
  if (history.length === 0) return;
  var last = history[history.length - 1];
  if (last.source !== "dashboard") return;
  var graceMs =
    typeof options.graceMs === "number" ? options.graceMs : conflictGraceMs();
  var now = typeof options.nowMs === "number" ? options.nowMs : Date.now();
  if (now - Date.parse(last.at) < graceMs) {
    throw new ConflictRejectedError(last);
  }
}

function conflictGraceMs(): number {
  var env = process.env.DOVE_CLAUDE_PLANS_DASHBOARD_GRACE_MS;
  if (env) {
    var parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 30_000;
}

// ---------------------------------------------------------------------------
// Named pipelines (additive — story B5 / grain).
//
// The default pipeline above is UNTOUCHED: LEGAL_TRANSITIONS and
// legalNextStages keep their exact behavior, so every existing consumer is
// byte-identical (proved in named-pipeline.test.ts). grain registers its own
// taxonomy — the 8 stages, the discrete 8.1-8.7 execution substeps, and the
// three gates — as a SEPARATE named pipeline the dashboard renders, keyed by
// pipelineId (default = "default"). Fork routes (park / reject / downscope) are
// reachable from any stage and render as branches, not forward transitions.
// ---------------------------------------------------------------------------

/** A named pipeline's transition table (string stages, like LEGAL_TRANSITIONS). */
export type PipelineTransitions = Record<string, string[]>;

/** grain's stage taxonomy, in flow order (for the per-run pipeline panel). */
export var GRAIN_STAGES: string[] = [
  "01-meta-prompt", "02-super", "03-grill-me", "04-improve-prompt",
  "05-dry-fit", "06-prd", "07-slice", "gate-1-review",
  "08-execution", "8.1-test-agent", "8.2-code-agent", "8.3-supervised-ralph",
  "8.4-story-qa", "8.5-code-review", "gate-3-merge", "8.6-e2e-verify",
  "8.7-doc-changelog", "gate-2-blocked"
];

/**
 * grain's legal transitions: the front-half chain, Gate 1, then the discrete
 * per-story stage-8 loop (8.1 -> 8.7) with Gate 3 (merge) and the Gate-2
 * blocked branch off story-qa. 8.7 loops back to 8.1 for the next story.
 */
export var GRAIN_TRANSITIONS: PipelineTransitions = {
  __START__: ["01-meta-prompt"],
  "01-meta-prompt": ["02-super"],
  "02-super": ["03-grill-me"],
  "03-grill-me": ["04-improve-prompt"],
  "04-improve-prompt": ["05-dry-fit"],
  "05-dry-fit": ["06-prd"],
  "06-prd": ["07-slice"],
  "07-slice": ["gate-1-review"],
  "gate-1-review": ["08-execution"],
  "08-execution": ["8.1-test-agent"],
  "8.1-test-agent": ["8.2-code-agent"],
  "8.2-code-agent": ["8.3-supervised-ralph"],
  "8.3-supervised-ralph": ["8.4-story-qa"],
  "8.4-story-qa": ["8.5-code-review", "gate-2-blocked"],
  "8.5-code-review": ["gate-3-merge"],
  "gate-3-merge": ["8.6-e2e-verify"],
  "8.6-e2e-verify": ["8.7-doc-changelog"],
  "8.7-doc-changelog": ["8.1-test-agent"],
  "gate-2-blocked": []
};

/** Pipeline registry: pipelineId -> transitions. "default" is the canonical 10-stage machine. */
export var PIPELINES: Record<string, PipelineTransitions> = {
  default: LEGAL_TRANSITIONS,
  grain: GRAIN_TRANSITIONS
};

/** Resolve a pipeline's transition table by id (defaults to "default"). Throws on unknown. */
export function pipelineDefinition(pipelineId: string = "default"): PipelineTransitions {
  var defn = PIPELINES[pipelineId];
  if (!defn) {
    throw new Error(
      'unknown pipeline "' + pipelineId + '"; known: ' + Object.keys(PIPELINES).join(", ")
    );
  }
  return defn;
}

/**
 * Legal next stages within a NAMED pipeline. For pipelineId "default" this is
 * identical to legalNextStages() over LEGAL_TRANSITIONS. Pure — feeds the
 * dashboard's per-run pipeline panel.
 */
export function legalNextStagesIn(pipelineId: string, from: string | null): string[] {
  var defn = pipelineDefinition(pipelineId);
  return defn[from || "__START__"] || [];
}
