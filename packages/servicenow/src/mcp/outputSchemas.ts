/**
 * Output schemas for the read-only Flow Designer tools — declared as
 * `outputSchema` on the descriptor so registerKitTool returns typed
 * `structuredContent`.
 *
 * SAFETY: the MCP SDK validates structuredContent against this schema at call
 * time and throws on mismatch (it reconstructs z.object(shape) in strip mode, so
 * extra keys pass — only a declared field with the wrong type fails). Every
 * declared field is therefore OPTIONAL and loosely typed; shapes mirror
 * ReadFlowResult / ReadActionTypeResult and are exercised in outputSchemas.test.ts.
 */

import { z } from "zod";

// readFlow → ReadFlowResult
export var flowViewOutput = z.object({
  sysId: z.string().optional(),
  name: z.string().optional(),
  internalName: z.string().optional(),
  type: z.string().optional(),
  scopeSysId: z.string().optional(),
  published: z.boolean().optional(),
  userCanRead: z.boolean().optional(),
  status: z.string().optional(),
  steps: z.array(z.unknown()).optional(),
  variables: z.array(z.unknown()).optional(),
  counts: z
    .object({
      action: z.number().optional(),
      logic: z.number().optional(),
      total: z.number().optional()
    })
    .passthrough()
    .optional()
}).passthrough();

// readActionType → ReadActionTypeResult
export var actionViewOutput = z.object({
  sysId: z.string().optional(),
  name: z.string().optional(),
  internalName: z.string().optional(),
  description: z.string().optional(),
  inputs: z.array(z.unknown()).optional(),
  outputs: z.array(z.unknown()).optional(),
  counts: z
    .object({
      inputs: z.number().optional(),
      outputs: z.number().optional()
    })
    .passthrough()
    .optional()
}).passthrough();
