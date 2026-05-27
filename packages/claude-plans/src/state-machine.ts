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
  documentation: ["documentation"]
};

export class IllegalTransitionError extends Error {
  public code: string;
  public from: PipelineStage | null;
  public to: PipelineStage;
  public legal: PipelineStage[];
  constructor(from: PipelineStage | null, to: PipelineStage, legal: PipelineStage[]) {
    super(
      "illegal stage transition " + (from || "<start>") + " -> " + to +
      "; legal next: " + (legal.length > 0 ? legal.join(", ") : "<none>")
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
      "to " + winning.to + " at " + winning.at + " is within the grace window"
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
export function assertTransition(from: PipelineStage | null, to: PipelineStage): void {
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
  options: ConflictResolution = {}
): void {
  if (incomingSource === "dashboard") return; // dashboard always wins
  if (history.length === 0) return;
  var last = history[history.length - 1];
  if (last.source !== "dashboard") return;
  var graceMs = typeof options.graceMs === "number" ? options.graceMs : conflictGraceMs();
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
