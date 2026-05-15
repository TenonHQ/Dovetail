/**
 * Zod input schemas for the 6 MCP tools. Schemas live in their own file so
 * registry.ts stays focused on wiring.
 */

import { z } from "zod";

var planStatus = z.enum(["DRAFT", "APPROVED", "EXITED"]);
var artifactKind = z.enum(["markdown", "mermaid"]);

export var pushPlanSchema = z.object({
  slug: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(200),
  content_md: z.string().default(""),
  content_html: z.string().optional(),
  status: planStatus.optional(),
  session_id: z.string().nullable().optional()
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
