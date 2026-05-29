import chalk from "chalk";
import {
  FieldChange,
  NormalizedField,
  NormalizedSchema,
  NormalizedTable,
  SchemaDiff,
  Severity,
  TableChange,
} from "./types";

function parseLength(value: string): number | null {
  if (!value) {
    return null;
  }
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

// Compare two versions of the same field and emit one FieldChange per detected
// difference, ordered most-severe-first.
function diffField(options: {
  table: string;
  from: NormalizedField;
  to: NormalizedField;
}): FieldChange[] {
  const { table, from, to } = options;
  const field = to.name;
  const changes: FieldChange[] = [];

  if (from.type !== to.type) {
    changes.push({
      table,
      field,
      change: "retyped",
      severity: "BREAKING",
      from: from.type,
      to: to.type,
    });
  }

  const fromLen = parseLength(from.max_length);
  const toLen = parseLength(to.max_length);
  if (fromLen !== null && toLen !== null && fromLen !== toLen) {
    changes.push({
      table,
      field,
      change: toLen < fromLen ? "length_shrunk" : "length_grew",
      severity: toLen < fromLen ? "BREAKING" : "INFO",
      from: from.max_length,
      to: to.max_length,
    });
  }

  if (from.mandatory !== to.mandatory) {
    changes.push({
      table,
      field,
      change: to.mandatory ? "newly_mandatory" : "now_optional",
      severity: to.mandatory ? "BREAKING" : "INFO",
      from: from.mandatory,
      to: to.mandatory,
    });
  }

  // A new or retargeted FK constraint is breaking; dropping one only loosens.
  if (from.reference !== to.reference && to.reference !== "") {
    changes.push({
      table,
      field,
      change: "retargeted",
      severity: "BREAKING",
      from: from.reference,
      to: to.reference,
    });
  }

  if (from.default_value !== to.default_value) {
    changes.push({
      table,
      field,
      change: "default_changed",
      severity: "WARN",
      from: from.default_value,
      to: to.default_value,
    });
  }

  if (from.label !== to.label) {
    changes.push({
      table,
      field,
      change: "label_changed",
      severity: "INFO",
      from: from.label,
      to: to.label,
    });
  }

  return changes;
}

function fieldMap(table: NormalizedTable): Map<string, NormalizedField> {
  const map = new Map<string, NormalizedField>();
  for (const field of table.fields) {
    map.set(field.name, field);
  }
  return map;
}

const SEVERITY_RANK: { [key in Severity]: number } = {
  BREAKING: 0,
  WARN: 1,
  INFO: 2,
};

export function diffSchemas(options: {
  from: NormalizedSchema;
  to: NormalizedSchema;
  fromRef: string;
  toRef: string;
  scope?: string | null;
}): SchemaDiff {
  const { from, to, fromRef, toRef } = options;
  const scope = options.scope || null;

  const tables: TableChange[] = [];
  const fields: FieldChange[] = [];

  const fromNames = Object.keys(from.tables);
  const toNames = Object.keys(to.tables);
  const allTableNames = new Set([...fromNames, ...toNames]);

  for (const tableName of allTableNames) {
    const inFrom = from.tables[tableName];
    const inTo = to.tables[tableName];

    if (inFrom && !inTo) {
      tables.push({ table: tableName, change: "removed", severity: "BREAKING" });
      continue;
    }
    if (!inFrom && inTo) {
      tables.push({ table: tableName, change: "added", severity: "INFO" });
      continue;
    }
    if (!inFrom || !inTo) {
      continue;
    }

    const fromFields = fieldMap(inFrom);
    const toFields = fieldMap(inTo);
    const allFieldNames = new Set([...fromFields.keys(), ...toFields.keys()]);

    for (const fieldName of allFieldNames) {
      const ff = fromFields.get(fieldName);
      const tf = toFields.get(fieldName);
      if (ff && !tf) {
        fields.push({
          table: tableName,
          field: fieldName,
          change: "removed",
          severity: "BREAKING",
        });
      } else if (!ff && tf) {
        fields.push({
          table: tableName,
          field: fieldName,
          change: "added",
          severity: "INFO",
          to: tf.type,
        });
      } else if (ff && tf) {
        fields.push(...diffField({ table: tableName, from: ff, to: tf }));
      }
    }
  }

  const sortByTableField = (a: { table: string; field?: string }, b: { table: string; field?: string }) => {
    if (a.table !== b.table) {
      return a.table < b.table ? -1 : 1;
    }
    return (a.field || "") < (b.field || "") ? -1 : 1;
  };
  tables.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || sortByTableField(a, b));
  fields.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || sortByTableField(a, b));

  const all = [...tables, ...fields];
  const summary = {
    breaking: all.filter((c) => c.severity === "BREAKING").length,
    warn: all.filter((c) => c.severity === "WARN").length,
    info: all.filter((c) => c.severity === "INFO").length,
  };

  return {
    instance: to.instance || from.instance || "",
    from: { ref: fromRef, generated_at: from.generated_at },
    to: { ref: toRef, generated_at: to.generated_at },
    scope,
    summary,
    tables,
    fields,
    exit_code: summary.breaking > 0 ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const TABLE_CHANGE_LABEL: { [k: string]: string } = {
  added: "table added",
  removed: "table removed",
};

const FIELD_CHANGE_LABEL: { [k: string]: string } = {
  added: "field added",
  removed: "field removed",
  retyped: "field retyped",
  length_shrunk: "length shrunk",
  length_grew: "length grew",
  newly_mandatory: "newly mandatory",
  now_optional: "now optional",
  retargeted: "reference retargeted",
  default_changed: "default changed",
  label_changed: "label changed",
};

function severityGlyph(severity: Severity): string {
  if (severity === "BREAKING") {
    return chalk.red("✖"); // ✖
  }
  if (severity === "WARN") {
    return chalk.yellow("⚠"); // ⚠
  }
  return chalk.cyan("+");
}

function formatTransition(from: any, to: any): string {
  if (from === undefined && to === undefined) {
    return "";
  }
  if (from === undefined) {
    return chalk.gray("(" + String(to) + ")");
  }
  return chalk.gray(JSON.stringify(from) + " → " + JSON.stringify(to));
}

function formatTextLine(c: {
  label: string;
  target: string;
  from?: any;
  to?: any;
  severity: Severity;
}): string {
  const labelCol = c.label.padEnd(20);
  const targetCol = c.target.padEnd(48);
  const transition = formatTransition(c.from, c.to);
  return "  " + severityGlyph(c.severity) + " " + labelCol + targetCol + transition;
}

export function formatDiff(
  diff: SchemaDiff,
  options?: { format?: "text" | "json"; color?: boolean }
): string {
  const format = (options && options.format) || "text";
  if (format === "json") {
    return JSON.stringify(diff, null, 2);
  }
  if (options && options.color === false) {
    chalk.level = 0;
  }

  const lines: string[] = [];
  lines.push(chalk.bold("Schema drift: " + diff.instance));
  lines.push(
    "  from  " +
      diff.from.ref +
      (diff.from.generated_at ? chalk.gray("  (" + diff.from.generated_at + ")") : "")
  );
  lines.push(
    "  to    " +
      diff.to.ref +
      (diff.to.generated_at ? chalk.gray("  (" + diff.to.generated_at + ")") : "")
  );
  if (diff.scope) {
    lines.push("  scope " + diff.scope);
  }
  lines.push("");

  type Row = { label: string; target: string; from?: any; to?: any; severity: Severity };
  const rows: Row[] = [];
  for (const t of diff.tables) {
    rows.push({
      label: TABLE_CHANGE_LABEL[t.change] || t.change,
      target: t.table,
      severity: t.severity,
    });
  }
  for (const f of diff.fields) {
    rows.push({
      label: FIELD_CHANGE_LABEL[f.change] || f.change,
      target: f.table + "." + f.field,
      from: f.from,
      to: f.to,
      severity: f.severity,
    });
  }

  const severities: Severity[] = ["BREAKING", "WARN", "INFO"];
  const headerColor: { [k in Severity]: (s: string) => string } = {
    BREAKING: chalk.red.bold,
    WARN: chalk.yellow.bold,
    INFO: chalk.cyan.bold,
  };

  for (const severity of severities) {
    const group = rows.filter((r) => r.severity === severity);
    if (group.length === 0) {
      continue;
    }
    lines.push(headerColor[severity](severity + " (" + group.length + ")"));
    for (const row of group) {
      lines.push(formatTextLine(row));
    }
    lines.push("");
  }

  if (rows.length === 0) {
    lines.push(chalk.green("No drift detected."));
    lines.push("");
  }

  lines.push(
    diff.summary.breaking +
      " breaking, " +
      diff.summary.warn +
      " warning, " +
      diff.summary.info +
      " info  →  exit " +
      diff.exit_code
  );

  return lines.join("\n");
}
