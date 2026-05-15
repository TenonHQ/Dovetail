/**
 * Shared data shapes for plans and artifacts.
 * Persisted to disk as JSON under ~/.dovetail/claude-plans/.
 */

export type PlanStatus = "DRAFT" | "APPROVED" | "EXITED";

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
}

export type ArtifactKind = "markdown" | "mermaid";

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

export interface PlanWithArtifacts {
  plan: ClaudePlan;
  artifacts: ClaudeArtifact[];
}

export var ALLOWED_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  DRAFT: ["APPROVED", "EXITED"],
  APPROVED: ["EXITED"],
  EXITED: []
};
