/**
 * dove-sn reference-attr-audit — READ-ONLY. List the reference columns under a table-name
 * prefix that do NOT carry a required dictionary attribute (default
 * `readonly_clickthrough=true`, the team rule since 2026-10-08).
 *
 * It only reports. A backfill is a separate, deliberate decision: run
 * `set-column --attributes` per column into an update set.
 *
 * sys_dictionary is paged (the Table API caps a page at 1000 rows) with a stable
 * ORDERBYsys_id, so offset paging neither skips nor repeats a row.
 *
 * ES6 only, no optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";
import { encodeQueryValue } from "../choices";
import {
  AttributeInput,
  missingAttributes,
  normalizeAttributeInput,
  serializeAttributes,
} from "./dictionaryAttributes";

/** A table-name prefix — spliced into the encoded query, so nothing but an identifier. */
var PREFIX = /^[a-z][a-z0-9_]*$/;
var PAGE_SIZE = 1000;
/** Hard stop so a runaway query can never page forever. */
var MAX_PAGES = 100;

export interface ReferenceAttrAuditParams {
  client: ServiceNowClient;
  /** Table-name prefix, e.g. "x_cadso_". */
  scopePrefix: string;
  /** The attribute(s) each reference column must carry. Default readonly_clickthrough=true. */
  attribute?: AttributeInput;
}

export interface ReferenceAttrAuditRow {
  table: string;
  element: string;
  columnSysId: string;
  /** sys_scope sys_id of the dictionary row. */
  scope: string;
  /** reference target table. */
  reference: string;
  /** sys_dictionary.attributes as stored. */
  attributes: string;
}

export interface ReferenceAttrAuditResult {
  scopePrefix: string;
  /** The attribute string audited for. */
  attribute: string;
  /** Active reference columns scanned. */
  total: number;
  compliant: number;
  missing: Array<ReferenceAttrAuditRow>;
  /** True when MAX_PAGES was hit — the scan is incomplete. */
  truncated: boolean;
}

export async function referenceAttrAudit(
  params: ReferenceAttrAuditParams,
): Promise<ReferenceAttrAuditResult> {
  if (!params || !params.client) {
    throw new Error("reference-attr-audit: client is required.");
  }
  var prefix =
    typeof params.scopePrefix === "string" ? params.scopePrefix.trim() : "";
  if (!PREFIX.test(prefix)) {
    throw new Error(
      "reference-attr-audit: --scope-prefix '" +
        String(params.scopePrefix) +
        "' must be a table-name prefix (lowercase letters, digits, '_'), e.g. x_cadso_.",
    );
  }
  var required;
  try {
    required = normalizeAttributeInput(
      params.attribute === undefined
        ? "readonly_clickthrough=true"
        : params.attribute,
    );
  } catch (e) {
    throw new Error(
      "reference-attr-audit: " + (e instanceof Error ? e.message : String(e)),
    );
  }

  var query =
    "internal_type=reference^nameSTARTSWITH" +
    encodeQueryValue(prefix) +
    "^active=true^ORDERBYsys_id";
  var fields = [
    "sys_id",
    "name",
    "element",
    "sys_scope",
    "reference",
    "attributes",
  ];
  var total = 0;
  var missing: Array<ReferenceAttrAuditRow> = [];
  var truncated = false;
  for (var page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    var rows = await params.client.table.query<Record<string, unknown>>(
      "sys_dictionary",
      query,
      {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        fields: fields,
      },
    );
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      // The collection row (empty element) is the table itself, never a column.
      var element = fieldToString(row.element);
      if (!element) continue;
      total += 1;
      var attributes = fieldToString(row.attributes);
      if (missingAttributes(attributes, required).length > 0) {
        missing.push({
          table: fieldToString(row.name),
          element: element,
          columnSysId: fieldToString(row.sys_id),
          scope: fieldToString(row.sys_scope),
          reference: fieldToString(row.reference),
          attributes: attributes,
        });
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return {
    scopePrefix: prefix,
    attribute: serializeAttributes(required),
    total: total,
    compliant: total - missing.length,
    missing: missing,
    truncated: truncated,
  };
}
