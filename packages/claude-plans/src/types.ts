/**
 * Shared data shapes for plans and artifacts.
 * Persisted to disk as JSON under ~/.dovetail/claude-plans/.
 */

export type PlanStatus = "DRAFT" | "APPROVED" | "EXITED";

export type LinkRelation =
  | "built-from"
  | "improves"
  | "supersedes"
  | "depends-on"
  | "see-also";

export interface LinkedArtifact {
  plan_slug: string;
  artifact_slug?: string;
  relation: LinkRelation;
  note?: string;
}

/**
 * Storage schema version stamped on every plan record written by v2+.
 * Records loaded without this field are treated as v1 and normalized in
 * memory by migrateV1OnLoad(); the upgrade is materialized on the next
 * write. Phases C and D will add stage/dispatch fields under the same
 * schema_version=2 marker — once a record is v2 it stays v2.
 */
export type ClaudePlanSchemaVersion = 1 | 2;

export var CURRENT_SCHEMA_VERSION: ClaudePlanSchemaVersion = 2;

export interface ClaudePlan {
  slug: string;
  title: string;
  status: PlanStatus;
  content_md: string;
  content_html?: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
  session_id: string | null;
  pr_number?: number;
  pr_url?: string;
  pr_title?: string;
  linked_artifacts?: LinkedArtifact[];
  questions?: PlanQuestion[];
  categories?: string[];
  /**
   * Absent or 1 on legacy records. migrateV1OnLoad() normalizes reads to
   * include this field at value 2; the next write persists it to disk.
   */
  schema_version?: ClaudePlanSchemaVersion;
  /**
   * v2 pipeline state. Null on plans that haven't been moved through a
   * stage yet. See state-machine.ts for the legal transition table.
   */
  stage?: PipelineStage | null;
  /**
   * Append-only history of stage moves on this plan. Empty when the plan
   * was never staged. Phase D dispatch reads the latest entry to decide
   * conflict resolution.
   */
  stage_history?: StageTransition[];
  /**
   * Current outstanding idempotency token issued by the most recent
   * set_stage call. Consumed (exactly once) by dispatch_stage. Cleared
   * to null when a new transition rotates it.
   */
  dispatch_token?: DispatchToken | null;
  /**
   * Append-only log of dispatch_stage calls (both dry-run and live).
   * Filled in Phase D — kept optional here so the Phase C migration
   * doesn't force a non-empty array on every read.
   */
  dispatch_log?: DispatchEvent[];
}

/**
 * v2 pipeline stages from claude-plans/docs/v2-design.md §3.1. The
 * brief's 13-agent pipeline collapses to these 10 surface states for
 * the dashboard. Stages "test-first" and "test-reality" require the
 * net-new agents from PR #160 — dispatch_stage raises
 * MissingAgentError when targeting them before those agents land.
 */
export type PipelineStage =
  | "research"
  | "pre-stage-improve"
  | "planning"
  | "post-plan-improve"
  | "test-first"
  | "code"
  | "per-step-review"
  | "architectural-review"
  | "test-reality"
  | "documentation";

export type StageTransitionSource = "code" | "dashboard";

export interface StageTransition {
  from: PipelineStage | null;
  to: PipelineStage;
  at: string;
  by: string;
  source: StageTransitionSource;
}

export interface DispatchToken {
  /** Format: tok_<24-hex> (12 bytes of crypto.randomBytes). */
  token: string;
  issued_for_stage: PipelineStage;
  issued_at: string;
  expires_at: string;
  /** Set when dispatch_stage consumes it. Absent until then. */
  consumed_at?: string;
}

/**
 * Dispatch event recorded for both dry-run and live calls. Phase C only
 * defines the shape; Phase D appends to dispatch_log.
 */
export interface DispatchEvent {
  at: string;
  target_stage: PipelineStage;
  mode: "dry-run" | "live";
  by: string;
  command?: string;
  cwd?: string;
  outcome: "ok" | "missing-agent" | "stale-token" | "no-token" | "spawn-error";
  pid?: number;
  error?: string;
}

export interface PlanQuestion {
  id: string;
  question: string;
  header?: string;
  options?: string[];
  stage?: string;
  asked_by?: string;
  asked_at: string;
  answer?: string;
  answered_by?: string;
  answered_at?: string;
}

export type ArtifactKind = "markdown" | "mermaid" | "prompt-cycle";

export { StructuredPlan, StructuredSection } from "./renderer";

export interface ClaudeArtifact {
  slug: string;
  plan_slug: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface ClaudePrompt {
  slug: string;
  plan_slug: string;
  title: string;
  content: string;
  source_draft?: string;
  score_before?: number;
  score_after?: number;
  created_at: string;
  updated_at: string;
}

export interface PromptCycleLintReport {
  score: number;
  missing: string[];
  antipatterns?: string[];
  ceremony?: string[];
}

/**
 * A single prompt-lint observation. Unlike plans/artifacts/prompts, lint events
 * are NOT owned by a plan — most are emitted by the UserPromptSubmit hook for
 * arbitrary prompts with no plan context. They live in a global store
 * (<root>/_lint-events/) and surface on the dashboard's standalone Prompt Lints
 * page. plan_slug and session_id are optional associations, not requirements.
 */
export interface PromptLintEvent {
  id: string; // le_<8-hex>
  timestamp: string; // ISO 8601 — when the lint was observed
  score: number; // 0-100 Turn-0 checklist score
  threshold?: number; // the cutoff that triggered recording (e.g. 50)
  missing: string[]; // missing checklist tags, e.g. ["<done>","<target>"]
  antipatterns?: string[];
  ceremony?: string[];
  prompt_excerpt?: string; // truncated prompt text for context
  source?: string; // emitter, e.g. "hook" | "manual"
  session_id?: string | null; // Claude Code session, when known
  plan_slug?: string; // optional plan association
  created_at: string;
  updated_at: string;
}

export interface PromptCycleOpenQuestion {
  question: string;
  header?: string;
  options: string[];
  answer: string;
}

export interface PromptCyclePayload {
  schema_version: 1;
  original_draft: string;
  lint_before: PromptCycleLintReport;
  open_questions: PromptCycleOpenQuestion[];
  rewritten_prompt: string;
  lint_after: PromptCycleLintReport;
  source_plan_slug?: string;
}

export interface PlanWithArtifacts {
  plan: ClaudePlan;
  artifacts: ClaudeArtifact[];
  prompts: ClaudePrompt[];
}

export var ALLOWED_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  DRAFT: ["APPROVED", "EXITED"],
  APPROVED: ["EXITED"],
  EXITED: []
};
