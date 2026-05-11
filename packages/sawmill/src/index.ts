/**
 * @tenonhq/dovetail-sawmill
 *
 * ServiceNow update set promotion client for Dovetail.
 * Wraps the Sawmill Scripted REST API (POST /api/cadso/sawmill/promote).
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
