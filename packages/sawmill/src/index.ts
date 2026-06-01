/**
 * @tenonhq/dovetail-sawmill
 *
 * ServiceNow update set promotion client for Dovetail.
 * Wraps the Dovetail Promote Scripted REST API (POST /api/cadso/dovetail_promote/promote).
 */

export { createSawmillApi, SawmillApiError } from "./client";
export type { SawmillApi } from "./client";
export type {
  SawmillApiConfig,
  PromoteRequest,
  PromoteResponse,
  PreviewError,
} from "./types";
export * from "./formatter";
