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

export interface PromptCycleLintReport {
  score: number;
  missing: string[];
  antipatterns?: string[];
  ceremony?: string[];
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
}

export var ALLOWED_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  DRAFT: ["APPROVED", "EXITED"],
  APPROVED: ["EXITED"],
  EXITED: []
};
