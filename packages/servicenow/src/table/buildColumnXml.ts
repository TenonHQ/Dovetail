/**
 * Build the embedded list-edit column XML that rides inside the sys_db_object.do
 * table-save POST. This is the ONE place ServiceNow's Studio form encodes new
 * columns: a `<record_update table="sys_dictionary">` envelope with one
 * `<record operation="add">` per column. Ground truth: a real Studio table-create
 * HAR (`x_cadso_core_error`, tenonworkstudio, 2026-06-13) — see
 * CTO docs/servicenow-create-table-har-analysis.md.
 *
 * Pure + deterministic (callers pass the per-column sys_ids) so it is unit-tested
 * without a network. ES6 only, no optional chaining.
 */

/** A normalized column ready to render. `type` is the ServiceNow internal_type. */
export interface NormalizedColumn {
  /** Display label (Studio derives `element` from this server-side). */
  label: string;
  /** sys_dictionary.internal_type, e.g. "string_full_utf8", "choice", "integer". */
  type: string;
  /** max_length as a string; "" when the type carries none (e.g. glide_date_time). */
  maxLength: string;
  /** Reference target table for type "reference"; "" otherwise (rendered as NULL). */
  reference: string;
}

/**
 * The 14 per-record fields Studio submits, in the HAR's exact order. Most are
 * static (server fills them); only column_label, internal_type, reference and
 * max_length carry capability data.
 */
function renderRecord(col: NormalizedColumn, sysId: string): string {
  var hasMax = col.maxLength !== "";
  var ref = col.reference ? col.reference : "NULL";
  var parts: Array<string> = [];
  parts.push('<record sys_id="' + sysId + '" operation="add">');
  // column_label — the only field the user really types; element is derived from it.
  parts.push(
    field("column_label", {
      modified: true,
      dsp_set: true,
      value: "",
      display: col.label,
    }),
  );
  parts.push(field("element", { value: "" }));
  parts.push(
    field("internal_type", {
      modified: true,
      value_set: true,
      value: col.type,
    }),
  );
  parts.push(field("reference", { value: ref }));
  if (hasMax) {
    parts.push(
      field("max_length", {
        modified: true,
        dsp_set: true,
        value: "",
        display: col.maxLength,
      }),
    );
  } else {
    parts.push(field("max_length", { value: "" }));
  }
  parts.push(field("default_value", { value: "" }));
  parts.push(field("display", { value: "false" }));
  parts.push(field("sys_updated_on", { value: "" }));
  parts.push(field("sys_updated_by", { value: "" }));
  parts.push(field("attributes", { value: "" }));
  parts.push(field("read_only", { value: "false" }));
  parts.push(field("sys_created_on", { value: "" }));
  parts.push(field("sys_created_by", { value: "" }));
  parts.push(field("name", { value: "" }));
  parts.push("</record>");
  return parts.join("");
}

interface FieldOpts {
  modified?: boolean;
  value_set?: boolean;
  dsp_set?: boolean;
  value: string;
  display?: string;
}

function field(name: string, opts: FieldOpts): string {
  var modified = opts.modified === true ? "true" : "false";
  var valueSet = opts.value_set === true ? "true" : "false";
  var dspSet = opts.dsp_set === true ? "true" : "false";
  var inner = "<value>" + xmlEscape(opts.value) + "</value>";
  if (opts.dsp_set === true) {
    inner +=
      "<display_value>" +
      xmlEscape(opts.display === undefined ? "" : opts.display) +
      "</display_value>";
  }
  return (
    '<field name="' +
    name +
    '" modified="' +
    modified +
    '" value_set="' +
    valueSet +
    '" dsp_set="' +
    dspSet +
    '">' +
    inner +
    "</field>"
  );
}

/** Minimal XML-attr/text escaping — the values cross an XML boundary. */
export function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the full `<record_update>` column blob. `sysIds[i]` is the fresh
 * client-generated sys_id for column i (length must match `columns`).
 */
export function buildColumnXml(
  columns: Array<NormalizedColumn>,
  sysIds: Array<string>,
): string {
  if (!Array.isArray(columns)) {
    throw new Error("buildColumnXml: columns must be an array.");
  }
  if (!Array.isArray(sysIds) || sysIds.length !== columns.length) {
    throw new Error(
      "buildColumnXml: need exactly one sys_id per column (got " +
        (Array.isArray(sysIds) ? sysIds.length : "none") +
        " for " +
        columns.length +
        " columns).",
    );
  }
  var open =
    '<record_update table="sys_dictionary" field="null" query="nameONE IN^element!=NULL^ORDERBYelement">';
  var body = "";
  for (var i = 0; i < columns.length; i += 1) {
    body += renderRecord(columns[i], sysIds[i]);
  }
  return open + body + "</record_update>";
}
