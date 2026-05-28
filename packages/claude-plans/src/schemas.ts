/**
 * Zod input schemas for the 6 MCP tools. Schemas live in their own file so
 * registry.ts stays focused on wiring.
 */

import { z } from "zod";

var planStatus = z.enum(["DRAFT", "APPROVED", "EXITED"]);
var artifactKind = z.enum(["markdown", "mermaid", "prompt-cycle"]);

var structuredPlanSchema = z.object({
  sections: z.array(z.any())
});

export var linkRelation = z.enum([
  "built-from",
  "improves",
  "supersedes",
  "depends-on",
  "see-also"
]);

export var planLinkSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  artifact_slug: z.string().min(1).max(64).optional(),
  relation: linkRelation,
  note: z.string().max(280).optional()
});

export var pushPlanSchema = z.object({
  slug: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(200),
  content_md: z.string().default(""),
  content_html: z.string().optional(),
  content_structured: structuredPlanSchema.optional(),
  status: planStatus.optional(),
  session_id: z.string().nullable().optional(),
  pr_number: z.number().int().positive().optional(),
  pr_url: z.string().url().optional(),
  pr_title: z.string().max(200).optional(),
  linked_artifacts: z.array(planLinkSchema).max(10).optional(),
  categories: z.array(z.string().min(1).max(40)).max(12).optional()
});

var lintReportSchema = z.object({
  score: z.number().int().min(0).max(100),
  missing: z.array(z.string()).default([]),
  antipatterns: z.array(z.string()).default([]).optional(),
  ceremony: z.array(z.string()).default([]).optional()
});

var openQuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(z.string()).default([]),
  answer: z.string().default("")
});

export var promptCyclePayloadSchema = z.object({
  schema_version: z.literal(1),
  original_draft: z.string(),
  lint_before: lintReportSchema,
  open_questions: z.array(openQuestionSchema).default([]),
  rewritten_prompt: z.string(),
  lint_after: lintReportSchema,
  source_plan_slug: z.string().min(1).max(64).optional()
});

export var deletePlanSchema = z.object({
  slug: z.string().min(1).max(64)
});

export var updatePlanStatusSchema = z.object({
  slug: z.string().min(1).max(64),
  to: planStatus
});

export var getPlanSchema = z.object({
  slug: z.string().min(1).max(64)
});

export var listRecentPlansSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
  status: planStatus.optional()
});

export var pushArtifactSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  slug: z.string().min(1).max(64).optional(),
  kind: artifactKind,
  title: z.string().min(1).max(200),
  content: z.string().min(1)
});

export var pushDiagramSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  slug: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(200),
  mermaid_source: z.string().min(1)
});

export var pushPromptSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  slug: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  source_draft: z.string().optional(),
  score_before: z.number().int().min(0).max(100).optional(),
  score_after: z.number().int().min(0).max(100).optional()
});

export var getHandoffBundleSchema = z.object({
  slug: z.string().min(1).max(64),
  follow_links: z.boolean().optional().default(false),
  include_artifact_kinds: z
    .array(z.enum(["markdown", "mermaid", "prompt-cycle"]))
    .optional()
});

export var QUESTION_ID_PATTERN = /^q_[0-9a-f]{8}$/;

export var pushQuestionSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  question: z.string().min(1).max(2000),
  header: z.string().min(1).max(24).optional(),
  options: z.array(z.string().min(1).max(120)).max(8).optional(),
  stage: z.string().min(1).max(32).optional(),
  asked_by: z.string().min(1).max(64).optional()
});

export var recordAnswerSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  question_id: z.string().regex(QUESTION_ID_PATTERN, "question_id must match q_<8-hex>"),
  answer: z.string().min(1),
  answered_by: z.string().min(1).max(64).optional()
});

export var getAnswersSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  answered: z.boolean().optional(),
  stage: z.string().min(1).max(32).optional()
});

export var pushLintEventSchema = z.object({
  score: z.number().int().min(0).max(100),
  missing: z.array(z.string()).default([]),
  antipatterns: z.array(z.string()).optional(),
  ceremony: z.array(z.string()).optional(),
  threshold: z.number().int().min(0).max(100).optional(),
  prompt_excerpt: z.string().max(2000).optional(),
  source: z.string().min(1).max(40).optional(),
  session_id: z.string().min(1).max(128).nullable().optional(),
  plan_slug: z.string().min(1).max(64).optional()
});

export var getLintEventsSchema = z.object({
  session_id: z.string().min(1).max(128).optional(),
  plan_slug: z.string().min(1).max(64).optional(),
  limit: z.number().int().positive().max(1000).optional()
});

// ---- v2 stage state machine (Phase C) ------------------------------------

export var PIPELINE_STAGES = [
  "research",
  "pre-stage-improve",
  "planning",
  "post-plan-improve",
  "test-first",
  "code",
  "per-step-review",
  "architectural-review",
  "test-reality",
  "documentation"
] as const;

export var pipelineStageSchema = z.enum(PIPELINE_STAGES);

export var setStageSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  to: pipelineStageSchema,
  by: z.string().min(1).max(64).optional(),
  source: z.enum(["code", "dashboard"]).optional()
});

export var pullPlanSchema = z.object({
  plan_slug: z.string().min(1).max(64)
});

export var DISPATCH_TOKEN_PATTERN = /^tok_[0-9a-f]{24}$/;

export var dispatchStageSchema = z.object({
  plan_slug: z.string().min(1).max(64),
  target_stage: pipelineStageSchema,
  confirm: z.boolean().optional(),
  token: z.string().regex(DISPATCH_TOKEN_PATTERN, "token must match tok_<24-hex>").optional(),
  by: z.string().min(1).max(64).optional()
});
