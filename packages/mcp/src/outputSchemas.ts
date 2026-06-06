/**
 * Output schemas for high-value read tools — declared as `outputSchema` on the
 * descriptor so registerKitTool returns typed `structuredContent`.
 *
 * SAFETY: the MCP SDK validates structuredContent against this schema at call
 * time and throws on mismatch (it reconstructs z.object(shape) in strip mode, so
 * extra keys pass — only a declared field with the wrong type fails). Every
 * declared field is therefore OPTIONAL and loosely typed; shapes are mirrored
 * from TeamSyncJson and the servicenow_query_table return and exercised in
 * outputSchemas.test.ts.
 */

import { z } from "zod";

// buildTeamSyncJson → TeamSyncJson
export var clickupGetTeamSyncOutput = z.object({
  syncTime: z.string().optional(),
  total: z.number().optional(),
  totalLists: z.number().optional(),
  stages: z.array(z.unknown()).optional(),
  unmappedStatuses: z.record(z.unknown()).optional(),
  unassigned: z.array(z.unknown()).optional()
}).passthrough();

// servicenowQueryTable → { table, count, records }
export var servicenowQueryTableOutput = z.object({
  table: z.string().optional(),
  count: z.number().optional(),
  records: z.array(z.unknown()).optional()
}).passthrough();
