/**
 * Output schemas for the high-value read/upsert tools — declared as
 * `outputSchema` on the descriptor so registerKitTool returns typed
 * `structuredContent` alongside the legacy JSON-in-text block.
 *
 * SAFETY: the MCP SDK validates the handler's structuredContent against this
 * schema at call time and THROWS on mismatch (it skips validation only on the
 * error path). The SDK reconstructs `z.object(shape)` in strip mode, so extra
 * keys always pass — the only failure mode is a declared field with the wrong
 * type. Therefore every declared field is OPTIONAL and loosely typed, and each
 * schema is exercised against a real handler return in outputSchemas.test.ts.
 */

import { z } from "zod";

export var pushPlanOutput = z.object({
  slug: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  content_hash: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  url: z.string().optional(),
  feature_score: z
    .object({
      score: z.number().optional(),
      missing: z.array(z.string()).optional(),
      hint: z.string().optional()
    })
    .passthrough()
    .optional()
}).passthrough();

export var pullPlanOutput = z.object({
  plan: z.unknown().optional(),
  artifacts: z.array(z.unknown()).optional(),
  prompts: z.array(z.unknown()).optional(),
  questions: z.array(z.unknown()).optional(),
  stage: z.unknown().optional(),
  stage_history: z.array(z.unknown()).optional(),
  dispatch_log: z.array(z.unknown()).optional()
}).passthrough();

export var getHandoffBundleOutput = z.object({
  slug: z.string().optional(),
  markdown: z.string().optional(),
  ready_to_paste_prompt: z.union([z.string(), z.null()]).optional()
}).passthrough();

export var listRecentPlansOutput = z.object({
  plans: z.array(z.unknown()).optional()
}).passthrough();

export var getAnswersOutput = z.object({
  plan_slug: z.string().optional(),
  questions: z.array(z.unknown()).optional()
}).passthrough();
