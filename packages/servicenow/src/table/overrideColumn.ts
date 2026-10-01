/**
 * The INHERITED-column path for `set-column`.
 *
 * WHY THIS EXISTS. set-column originally refused every inherited column outright and told
 * the caller to go change the parent instead, warning in the same breath that doing so
 * "changes the column for EVERY table that extends" it. That advice was wrong, and
 * actively dangerous: it is the destructive option, and ServiceNow has shipped the
 * correct one for years. A child table narrows an inherited column for ITSELF via
 * sys_dictionary_override (mandatory / default / read-only) or sys_documentation (label),
 * touching neither the parent nor any sibling.
 *
 * The refusal was never verified against an instance — the irony being that the verb's
 * own thesis is "do not trust a response you have not read back". Everything below was
 * established live on tenonworkshed, 2026-07-16, by querying real rows:
 *
 *   - sys_dictionary_override carries a VALUE column and a paired `<attr>_override`
 *     boolean, for mandatory / read_only / default_value (plus calculation, dependent,
 *     reference_qual, attributes — outside this verb's five). The boolean is what
 *     ACTIVATES the override: a value written without its flag is inert.
 *
 *   - There is NO max_length override and NO label override on that table. max_length is
 *     physical on the defining table's column, so it genuinely cannot be narrowed per
 *     child — that one refusal was right, for a reason the old message never gave.
 *
 *   - LABEL is not an override at all; it is a sys_documentation row keyed on the CHILD
 *     table. Proof in the platform itself: `problem.short_description` reads "Problem
 *     statement" while `task.short_description` — the row that actually defines the
 *     column — still reads "Short description". sys_dictionary has no row for
 *     problem.short_description whatsoever. OOB ServiceNow does exactly what set-column
 *     said was impossible.
 *
 *   - `base_table` is the table that DEFINES the column, NOT the immediate parent.
 *     Verified against a deep chain: cmdb_ci_endpoint_sharepoint_service extends
 *     cmdb_ci_endpoint_inclusion, yet its override rows carry base_table=cmdb_ci.
 *
 *   - SCOPE FOLLOWS THE CHILD, not the parent. x_cadso_work_project's overrides of
 *     task's columns sit in the x_cadso scope while task is global; problem_task's sit
 *     in global. Resolving scope from the parent's dictionary row — the obvious move,
 *     and what choices.ts does for its own case — would land a scoped child's override
 *     in `global`. That is the exact wrong-scope failure Craftsman's CLAUDE.md calls out.
 *
 * CAPTURE NAMES ARE NOT ANALOGOUS, and this is a trap worth stating plainly. Three
 * record types, three different sys_update_xml naming conventions:
 *
 *     sys_dictionary            sys_dictionary_<table>_<element>
 *     sys_dictionary_override   sys_dictionary_override_<SYS_ID>        <- keyed by sys_id
 *     sys_documentation         sys_documentation_<table>_<element>_<language>
 *
 * Deriving the override's name by analogy with the other two produces a query that
 * matches nothing, so a perfectly-captured change would report itself as uncaptured. Both
 * names below were read off real update rows, not inferred.
 *
 * ES6 only, no optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";
import { encodeQueryValue } from "../choices";
// TYPE-only: erased at compile time, so it cannot form a runtime cycle with setColumn.ts,
// which imports values from this module.
import type { AttributeChange } from "./setColumn";

/** The language a label override is written for. ServiceNow keys sys_documentation by
 *  language, and the capture name embeds it, so it is explicit rather than implied. */
export var LABEL_LANGUAGE = "en";

export interface OverridableAttribute {
  /** The sys_dictionary_override column that holds the value. */
  field: string;
  /** The boolean that ACTIVATES it. A value written without its flag is inert — the
   *  child silently keeps inheriting, which would read as a successful no-op. */
  flag: string;
}

/**
 * The inherited attributes a child can narrow for itself, keyed by the sys_dictionary
 * column set-column diffs on. Anything absent is NOT overridable per-child:
 *   - column_label -> sys_documentation instead (see applyLabelOverride)
 *   - max_length   -> physical on the defining table; no override exists at all
 */
export var OVERRIDABLE: Record<string, OverridableAttribute> = {
  mandatory: { field: "mandatory", flag: "mandatory_override" },
  default_value: { field: "default_value", flag: "default_value_override" },
  read_only: { field: "read_only", flag: "read_only_override" },
};

/**
 * Why max_length — alone among set-column's five attributes — cannot be narrowed on a
 * child, and what that means for the caller.
 *
 * Deliberately max_length-specific rather than a general "attribute X is not
 * overridable" helper: of the five, the other four ARE overridable, so a generic branch
 * would be unreachable code speculating about a case that does not exist. If a sixth
 * attribute is ever added to WRITABLE, this needs revisiting — which a dead generic
 * branch would have quietly hidden.
 *
 * Unlike the old blanket refusal this one is true, and it says WHY rather than
 * recommending the destructive alternative as though it were routine.
 */
export function explainMaxLengthNotOverridable(
  table: string,
  column: string,
  definedOn: string,
): string {
  return (
    "set-column: refusing to change max_length of '" +
    column +
    "' on '" +
    table +
    "' — the column is INHERITED from '" +
    definedOn +
    "'. max_length is PHYSICAL: it is " +
    "the real database column on '" +
    definedOn +
    "', and sys_dictionary_override has no " +
    "max_length field, so it cannot be narrowed for '" +
    table +
    "' alone. Changing it " +
    "at the source (set-column --table " +
    definedOn +
    " --column " +
    column +
    ") resizes " +
    "the column for EVERY table that extends '" +
    definedOn +
    "', so that is a deliberate " +
    "decision and is not made on your behalf. The other attributes (label, mandatory, " +
    "default, read-only) CAN be set on '" +
    table +
    "' alone and are applied as overrides."
  );
}

/** The scope the override belongs to — resolved from the CHILD table, never the parent.
 *  A scoped child overriding a global parent's column must land in the child's scope. */
export async function resolveTableScope(
  client: ServiceNowClient,
  table: string,
): Promise<string> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_db_object",
    "name=" + encodeQueryValue(table),
    { limit: 1, fields: ["sys_scope"] },
  );
  if (rows.length === 0) return "";
  var scopeSysId = fieldToString(rows[0].sys_scope);
  if (!scopeSysId) return "";
  // "global" is already the namespace; sys_scope has no row to resolve it against.
  if (scopeSysId === "global") return "global";
  var scopeRows = await client.table.query<Record<string, unknown>>(
    "sys_scope",
    "sys_id=" + encodeQueryValue(scopeSysId),
    { limit: 1, fields: ["scope", "name"] },
  );
  if (scopeRows.length === 0) return "";
  return fieldToString(scopeRows[0].scope) || fieldToString(scopeRows[0].name);
}

/** The child's existing override row for this column, or null. */
export async function findOverrideRow(
  client: ServiceNowClient,
  table: string,
  column: string,
): Promise<Record<string, unknown> | null> {
  var fields = ["sys_id", "name", "element", "base_table"];
  var keys = Object.keys(OVERRIDABLE);
  for (var i = 0; i < keys.length; i += 1) {
    fields.push(OVERRIDABLE[keys[i]].field);
    fields.push(OVERRIDABLE[keys[i]].flag);
  }
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_dictionary_override",
    "name=" + encodeQueryValue(table) + "^element=" + encodeQueryValue(column),
    { limit: 1, fields: fields },
  );
  return rows.length > 0 ? rows[0] : null;
}

/** The child's existing label row for this column, or null. */
export async function findLabelRow(
  client: ServiceNowClient,
  table: string,
  column: string,
): Promise<Record<string, unknown> | null> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_documentation",
    "name=" +
      encodeQueryValue(table) +
      "^element=" +
      encodeQueryValue(column) +
      "^language=" +
      encodeQueryValue(LABEL_LANGUAGE),
    { limit: 1, fields: ["sys_id", "label", "language"] },
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * The value this child ACTUALLY sees for an attribute today.
 *
 * An override's value only counts when its flag is on. A row carrying mandatory=true with
 * mandatory_override=false is inert — the child still inherits — so reading the value
 * alone would diff against a number the platform is ignoring, and report `unchanged` for
 * a column that behaves the opposite way.
 */
export function effectiveValue(
  field: string,
  overrideRow: Record<string, unknown> | null,
  parentRow: Record<string, unknown>,
  labelRow: Record<string, unknown> | null,
): string {
  // The label is not an override; it is the child's own sys_documentation row. When the
  // child has none it simply shows the defining table's label, which sys_dictionary
  // already surfaces as column_label on the parent row.
  if (field === "column_label") {
    if (labelRow) return fieldToString(labelRow.label);
    return fieldToString(parentRow.column_label);
  }
  var spec = OVERRIDABLE[field];
  if (spec && overrideRow) {
    var flag = fieldToString(overrideRow[spec.flag]);
    if (flag === "true") return fieldToString(overrideRow[spec.field]);
  }
  return fieldToString(parentRow[field]);
}

/** One attribute's before -> after.
 *
 * This is setColumn's AttributeChange, imported as a TYPE. setColumn imports values from
 * here, so a value-import back would close a runtime cycle — but `import type` is erased
 * at compile time and cannot. Re-declaring the shape would be a second source of truth
 * for the same three fields, which is worse than the cycle it does not prevent. */
export type InheritedChange = AttributeChange;

/**
 * What would actually change for this child, comparing against the value it sees TODAY
 * (its override if one is active, otherwise the inherited value).
 *
 * Note what is deliberately NOT treated as a change: a requested value that already
 * matches the INHERITED one. Writing an override there would pin the child to a value it
 * already has, decoupling it from the parent as an invisible side effect of a request
 * that asked for no such thing. Reporting `unchanged` — and saying the column still
 * tracks the parent — is the honest answer.
 */
export function diffInherited(
  writes: Record<string, string>,
  overrideRow: Record<string, unknown> | null,
  parentRow: Record<string, unknown>,
  labelRow: Record<string, unknown> | null,
): Array<InheritedChange> {
  var changes: Array<InheritedChange> = [];
  var fields = Object.keys(writes);
  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    var from = effectiveValue(field, overrideRow, parentRow, labelRow);
    if (from !== writes[field]) {
      changes.push({ attribute: field, from: from, to: writes[field] });
    }
  }
  return changes;
}

export interface InheritedWriteParams {
  client: ServiceNowClient;
  table: string;
  column: string;
  /** The table that DEFINES the column — what base_table must be set to. */
  definedOn: string;
  changes: Array<InheritedChange>;
  overrideRow: Record<string, unknown> | null;
  labelRow: Record<string, unknown> | null;
  updateSetSysId: string;
}

export interface InheritedWriteResult {
  /** sys_id of the override row touched, "" when no override attribute changed. */
  overrideSysId: string;
  /** sys_id of the label row touched, "" when the label did not change. */
  labelSysId: string;
  /** True only when every written value was READ BACK from the instance and matched. */
  verified: boolean;
  mismatched: Array<string>;
  /** True when every record written was found in the named update set. */
  captured: boolean;
}

/** Update-set capture name for an override row — keyed by SYS_ID, unlike sys_dictionary.
 *  Read off real update rows on tenonworkshed; deriving it by analogy yields a query that
 *  matches nothing and reports a captured change as uncaptured. */
export function overrideUpdateName(overrideSysId: string): string {
  return "sys_dictionary_override_" + overrideSysId;
}

/** Update-set capture name for a label row: sys_documentation_<table>_<element>_<lang>. */
export function labelUpdateName(table: string, column: string): string {
  return "sys_documentation_" + table + "_" + column + "_" + LABEL_LANGUAGE;
}

async function isCaptured(
  client: ServiceNowClient,
  updateSetSysId: string,
  name: string,
): Promise<boolean> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_xml",
    "update_set=" +
      encodeQueryValue(updateSetSysId) +
      "^name=" +
      encodeQueryValue(name),
    { limit: 1, fields: ["sys_id"] },
  );
  return rows.length > 0;
}

/**
 * Write the child's overrides, then READ THEM BACK. The whole verb exists because
 * ServiceNow returns 200 for writes it silently discards, and that reasoning does not
 * stop applying just because the target table changed.
 */
export async function applyInheritedWrites(
  params: InheritedWriteParams,
): Promise<InheritedWriteResult> {
  var client = params.client;
  var overrideChanges = params.changes.filter(function (c) {
    return Boolean(OVERRIDABLE[c.attribute]);
  });
  var labelChange = params.changes.filter(function (c) {
    return c.attribute === "column_label";
  })[0];

  // The sys_ids of any PRE-EXISTING rows — used only to TARGET an update, never reported.
  // A label-only call must not claim it touched the override row that happened to already
  // exist, and an override-only call must not claim it touched a pre-existing label row.
  var existingOverrideSysId = params.overrideRow
    ? fieldToString(params.overrideRow.sys_id)
    : "";
  var existingLabelSysId = params.labelRow
    ? fieldToString(params.labelRow.sys_id)
    : "";

  // What this call actually WROTE. Stays "" unless the matching branch runs, so a returned
  // sys_id names a row THIS call touched — honouring the InheritedWriteResult docstrings,
  // which promise "" when the attribute did not change.
  var overrideSysId = "";
  var labelSysId = "";

  // Scope follows the CHILD — taking it from the parent would drop a scoped child's
  // override into global. Resolved at most once and only when a record is actually
  // created: a mixed label+mandatory request needs the same answer twice, and an update
  // to existing rows needs it not at all.
  var scopeMemo: string | null = null;
  async function childScope(): Promise<string | undefined> {
    if (scopeMemo === null) {
      scopeMemo = await resolveTableScope(client, params.table);
    }
    return scopeMemo ? scopeMemo : undefined;
  }

  // --- sys_dictionary_override -------------------------------------------------------
  if (overrideChanges.length > 0) {
    var overrideFields: Record<string, string> = {};
    for (var i = 0; i < overrideChanges.length; i += 1) {
      var spec = OVERRIDABLE[overrideChanges[i].attribute];
      overrideFields[spec.field] = overrideChanges[i].to;
      // The flag is what makes the value count. Writing the value alone leaves the child
      // inheriting while the row claims otherwise.
      overrideFields[spec.flag] = "true";
    }
    if (existingOverrideSysId) {
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: params.updateSetSysId,
        table: "sys_dictionary_override",
        record_sys_id: existingOverrideSysId,
        fields: overrideFields,
      });
      overrideSysId = existingOverrideSysId;
    } else {
      overrideFields.name = params.table;
      overrideFields.element = params.column;
      // base_table is the DEFINING table, not the immediate parent (verified live).
      overrideFields.base_table = params.definedOn;
      var created = await client.claude.createRecord({
        table: "sys_dictionary_override",
        fields: overrideFields,
        scope: await childScope(),
        update_set_sys_id: params.updateSetSysId,
      });
      overrideSysId = fieldToString(created.sys_id);
    }
  }

  // --- sys_documentation (label) -----------------------------------------------------
  if (labelChange) {
    if (existingLabelSysId) {
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: params.updateSetSysId,
        table: "sys_documentation",
        record_sys_id: existingLabelSysId,
        fields: { label: labelChange.to },
      });
      labelSysId = existingLabelSysId;
    } else {
      var createdLabel = await client.claude.createRecord({
        table: "sys_documentation",
        fields: {
          name: params.table,
          element: params.column,
          label: labelChange.to,
          language: LABEL_LANGUAGE,
        },
        scope: await childScope(),
        update_set_sys_id: params.updateSetSysId,
      });
      labelSysId = fieldToString(createdLabel.sys_id);
    }
  }

  // --- read back ---------------------------------------------------------------------
  var mismatched: Array<string> = [];
  if (overrideChanges.length > 0) {
    var afterOverride = await findOverrideRow(
      client,
      params.table,
      params.column,
    );
    if (!afterOverride) {
      mismatched.push(
        "no sys_dictionary_override row for " +
          params.table +
          "." +
          params.column +
          " could be read back after the write",
      );
    } else {
      for (var j = 0; j < overrideChanges.length; j += 1) {
        var oSpec = OVERRIDABLE[overrideChanges[j].attribute];
        var got = fieldToString(afterOverride[oSpec.field]);
        var gotFlag = fieldToString(afterOverride[oSpec.flag]);
        if (got !== overrideChanges[j].to) {
          mismatched.push(
            overrideChanges[j].attribute +
              " reads back as '" +
              got +
              "', not '" +
              overrideChanges[j].to +
              "'",
          );
        } else if (gotFlag !== "true") {
          // The value landed but the override is not switched on, so the child still
          // inherits. Nothing visibly failed, and the column does not behave as asked.
          mismatched.push(
            oSpec.flag +
              " reads back as '" +
              gotFlag +
              "', so the " +
              overrideChanges[j].attribute +
              " override is INERT and " +
              params.table +
              " still inherits from " +
              params.definedOn,
          );
        }
      }
    }
  }
  if (labelChange) {
    var afterLabel = await findLabelRow(client, params.table, params.column);
    var gotLabel = afterLabel ? fieldToString(afterLabel.label) : "";
    if (gotLabel !== labelChange.to) {
      mismatched.push(
        "label reads back as '" + gotLabel + "', not '" + labelChange.to + "'",
      );
    }
  }

  // --- capture -----------------------------------------------------------------------
  var captured = true;
  if (overrideChanges.length > 0 && overrideSysId) {
    captured =
      captured &&
      (await isCaptured(
        client,
        params.updateSetSysId,
        overrideUpdateName(overrideSysId),
      ));
  }
  if (labelChange) {
    captured =
      captured &&
      (await isCaptured(
        client,
        params.updateSetSysId,
        labelUpdateName(params.table, params.column),
      ));
  }

  return {
    overrideSysId: overrideSysId,
    labelSysId: labelSysId,
    verified: mismatched.length === 0,
    mismatched: mismatched,
    captured: captured,
  };
}
