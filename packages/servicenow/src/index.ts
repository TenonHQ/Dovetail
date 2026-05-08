/**
 * @tenonhq/dovetail-servicenow
 *
 * ServiceNow helpers that route writes through the Dovetail "Claude" Scripted
 * REST API so every change lands in the target update set and scope.
 */

export { createClient } from "./client";
export type { ServiceNowClient, TableQueryOptions } from "./client";

export { addChoicesToField } from "./choices";

export { formatAddChoicesResult } from "./formatter";

export { sincPlugin } from "./plugin";

export type {
  ServiceNowClientConfig,
  ChoiceValue,
  ChoiceType,
  AddChoicesParams,
  AddChoicesResult,
  ChoiceActionResult,
  DictionaryRecord,
  UpdateSetRecord
} from "./types";
