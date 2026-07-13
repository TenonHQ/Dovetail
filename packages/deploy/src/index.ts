/**
 * @tenonhq/dovetail-deploy
 *
 * ClickUp-status-driven ServiceNow update-set promotion orchestrator.
 * Transport-agnostic via ports (SnReader, Promoter, Commenter); adapt the real
 * @tenonhq/dovetail-{servicenow,sawmill,clickup} clients at the call site.
 */

export * from "./types";

export { validatePromotionLadder } from "./config";
export type { ValidationIssue, ValidatePromotionLadderParams } from "./config";

export {
  resolveUpdateSets,
  buildUpdateSetQuery,
  nameMatchesTaskId,
} from "./resolveUpdateSets";
export type {
  ResolveOutcome,
  ResolveUpdateSetsParams,
} from "./resolveUpdateSets";

export { promoteForStatus } from "./promoteForStatus";
export type {
  PromoteForStatusParams,
  PromoteForStatusResult,
  PromoteOutcome,
} from "./promoteForStatus";

export { resolveDevInstance, toSubdomain } from "./resolveDevInstance";
export type {
  ResolveDevInstanceParams,
  ResolveDevInstanceResult,
} from "./resolveDevInstance";

export { formatFailureReport } from "./rollback";
export type { FailureReportParams } from "./rollback";
