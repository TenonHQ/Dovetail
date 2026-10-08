/**
 * Shared update-set read for the cross-scope writers (add-column --cross-scope and
 * design-access). Both must refuse an update set that is not open: a record written
 * into a Complete/Ignored set lands on the instance but is captured nowhere, so it can
 * never be promoted. ES6 only, no optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { encodeQueryValue } from "../choices";
import { fieldToString } from "../setField";

export interface UpdateSetInfo {
  /** False when no sys_update_set row matches the sys_id. */
  found: boolean;
  sysId: string;
  name: string;
  /** Owning application (sys_scope sys_id). */
  applicationSysId: string;
  /** Raw state value, e.g. "in progress", "complete", "ignore". */
  state: string;
}

/** Read an update set's name, owning application and state by sys_id. */
export async function readUpdateSet(
  client: ServiceNowClient,
  updateSetSysId: string,
): Promise<UpdateSetInfo> {
  var id = String(updateSetSysId || "").trim();
  if (!id) {
    return {
      found: false,
      sysId: "",
      name: "",
      applicationSysId: "",
      state: "",
    };
  }
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_set",
    "sys_id=" + encodeQueryValue(id),
    { limit: 1, fields: ["sys_id", "name", "application", "state"] },
  );
  if (rows.length === 0) {
    return {
      found: false,
      sysId: id,
      name: "",
      applicationSysId: "",
      state: "",
    };
  }
  return {
    found: true,
    sysId: fieldToString(rows[0].sys_id) || id,
    name: fieldToString(rows[0].name),
    applicationSysId: fieldToString(rows[0].application),
    state: fieldToString(rows[0].state),
  };
}

/** True only for an open set ("in progress"; "in_progress" tolerated). Empty is NOT open. */
export function isUpdateSetOpen(state: string): boolean {
  return state === "in progress" || state === "in_progress";
}

/** The refusal message for a set that is not open, prefixed with the caller's verb. */
export function closedUpdateSetMessage(
  prefix: string,
  info: UpdateSetInfo,
): string {
  return (
    prefix +
    ": update set '" +
    (info.name || info.sysId) +
    "' is '" +
    (info.state || "(empty)") +
    "', not 'in progress'. A record written into a closed set is captured nowhere " +
    "and can never be promoted. Re-open it, or use an open set."
  );
}
