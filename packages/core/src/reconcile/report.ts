// Pure renderer for the `dove reconcile` dry-run report. Takes the classified
// diff for every scope plus the optional schema arm and produces a grouped,
// deep-linked, plain-text report. No I/O, no color codes — so it is exactly
// assertable in tests and the command layer can print it verbatim.
//
// What the report communicates, in priority order:
//   1. DRIFT (refuse-if-dirty)  — the dev's own instance edits since baseline.
//      Phase 2 blocks apply on these; Phase 1 surfaces them up top.
//   2. RECORD DELTAS            — create / update / delete the apply phases act on.
//   3. SCHEMA DELTAS            — report-only (a ServiceNow ceiling), with the
//      dictionary deep-links a human needs to apply them by hand.

import { SchemaDiff } from "@tenonhq/dovetail-schema";
import { DirtyRecord, RecordChange, RecordDiff } from "./types";

export interface ReconcileScopeResult {
  scope: string;
  diff: RecordDiff;
  dirty: DirtyRecord[];
  hasBaseline: boolean;
  /** null when the schema arm was not run for this scope. */
  schema: SchemaDiff | null;
}

export interface ReconcileReportInput {
  /** Normalized instance host (no scheme), e.g. "tenonworkstudio". */
  instanceHost: string;
  /** Current git branch, for context in the header. */
  branchRef: string;
  scopes: ReconcileScopeResult[];
  /** Set when the schema arm could not run at all (e.g. no snapshot). */
  schemaSkippedReason: string | null;
}

function recordLink(host: string, table: string, sysId: string): string {
  if (!host) {
    return table + ".do?sys_id=" + sysId;
  }
  return (
    "https://" + host + ".service-now.com/" + table + ".do?sys_id=" + sysId
  );
}

function dictionaryLink(host: string, table: string, element: string): string {
  const query = element
    ? "name=" + table + "^element=" + element
    : "name=" + table;
  const base = host ? "https://" + host + ".service-now.com/" : "";
  return base + "sys_dictionary_list.do?sysparm_query=" + query;
}

function recordRow(host: string, glyph: string, change: RecordChange): string {
  const label = change.table + " > " + change.name;
  return (
    "  " +
    glyph +
    " " +
    label +
    "  " +
    recordLink(host, change.table, change.sys_id)
  );
}

function fieldSubRows(change: RecordChange): string[] {
  const rows: string[] = [];
  for (const delta of change.fieldDeltas) {
    let note: string;
    if (delta.changed) {
      note = "changed";
    } else if (delta.onBranch && !delta.onLive) {
      note = "missing on instance";
    } else {
      note = "extra on instance";
    }
    rows.push("      - " + delta.field + " (" + note + ")");
  }
  return rows;
}

function partitionDeletes(deletes: RecordChange[]): {
  applyable: RecordChange[];
  drift: RecordChange[];
} {
  const applyable: RecordChange[] = [];
  const drift: RecordChange[] = [];
  for (const change of deletes) {
    if (change.deleteDisposition === "tracked") {
      applyable.push(change);
    } else {
      drift.push(change);
    }
  }
  return { applyable, drift };
}

function renderScope(
  host: string,
  scopeResult: ReconcileScopeResult,
  lines: string[],
): void {
  const { scope, diff, dirty } = scopeResult;
  const deletes = partitionDeletes(diff.deletes);

  lines.push("");
  lines.push("Scope: " + scope);

  if (!scopeResult.hasBaseline) {
    lines.push(
      "  ! no baseline for this instance — deletes are shown but cannot be " +
        "applied (run a reconcile apply to establish one).",
    );
  }

  // 1. Drift first — it is what blocks an apply.
  if (dirty.length > 0) {
    lines.push(
      "  DRIFT — instance changed since baseline (apply would refuse):",
    );
    for (const record of dirty) {
      lines.push(
        "      ! " +
          record.table +
          " > " +
          record.name +
          "  " +
          recordLink(host, record.table, record.sys_id),
      );
    }
  }

  // 2. Record deltas.
  if (diff.creates.length > 0) {
    lines.push("  CREATE (" + diff.creates.length + "):");
    for (const change of diff.creates) {
      lines.push(recordRow(host, "+", change));
    }
  }
  if (diff.updates.length > 0) {
    lines.push("  UPDATE (" + diff.updates.length + "):");
    for (const change of diff.updates) {
      lines.push(recordRow(host, "~", change));
      for (const sub of fieldSubRows(change)) {
        lines.push(sub);
      }
    }
  }
  if (deletes.applyable.length > 0) {
    lines.push("  DELETE (" + deletes.applyable.length + "):");
    for (const change of deletes.applyable) {
      lines.push(recordRow(host, "-", change));
    }
  }
  if (deletes.drift.length > 0) {
    lines.push(
      "  INSTANCE-ONLY — present on instance, not in branch, not in baseline " +
        "(kept, never deleted):",
    );
    for (const change of deletes.drift) {
      lines.push(recordRow(host, "?", change));
    }
  }

  // 3. Schema — report-only.
  renderSchema(host, scopeResult, lines);

  const noRecordDeltas =
    diff.creates.length === 0 &&
    diff.updates.length === 0 &&
    deletes.applyable.length === 0;
  if (noRecordDeltas && dirty.length === 0) {
    lines.push(
      "  in sync (" + diff.unchangedCount + " records match the instance)",
    );
  }
}

function renderSchema(
  host: string,
  scopeResult: ReconcileScopeResult,
  lines: string[],
): void {
  const schema = scopeResult.schema;
  if (!schema) {
    return;
  }
  const total =
    schema.summary.breaking + schema.summary.warn + schema.summary.info;
  if (total === 0) {
    return;
  }
  lines.push(
    "  SCHEMA — report-only (" +
      total +
      " change(s); ServiceNow blocks headless dictionary writes — apply by hand):",
  );
  for (const table of schema.tables) {
    lines.push(
      "      " +
        table.change +
        " table " +
        table.table +
        "  " +
        dictionaryLink(host, table.table, ""),
    );
  }
  for (const field of schema.fields) {
    lines.push(
      "      " +
        field.change +
        " " +
        field.table +
        "." +
        field.field +
        "  " +
        dictionaryLink(host, field.table, field.field),
    );
  }
}

export function formatReconcileReport(input: ReconcileReportInput): string {
  const host = input.instanceHost;
  const lines: string[] = [];

  lines.push("dove reconcile — dry run (no changes applied)");
  lines.push("  instance  " + (host || "(unknown)"));
  lines.push("  branch    " + (input.branchRef || "(unknown)"));

  let totalCreates = 0;
  let totalUpdates = 0;
  let totalDeletes = 0;
  let totalDrift = 0;
  let totalInstanceOnly = 0;

  for (const scopeResult of input.scopes) {
    renderScope(host, scopeResult, lines);
    const deletes = partitionDeletes(scopeResult.diff.deletes);
    totalCreates += scopeResult.diff.creates.length;
    totalUpdates += scopeResult.diff.updates.length;
    totalDeletes += deletes.applyable.length;
    totalInstanceOnly += deletes.drift.length;
    totalDrift += scopeResult.dirty.length;
  }

  if (input.schemaSkippedReason) {
    lines.push("");
    lines.push("Schema diff skipped: " + input.schemaSkippedReason);
  }

  lines.push("");
  lines.push(
    "Summary: " +
      totalCreates +
      " create, " +
      totalUpdates +
      " update, " +
      totalDeletes +
      " delete" +
      (totalInstanceOnly > 0
        ? ", " + totalInstanceOnly + " instance-only kept"
        : "") +
      (totalDrift > 0 ? ", " + totalDrift + " drift" : ""),
  );

  if (totalDrift > 0) {
    lines.push(
      "Apply would REFUSE: " +
        totalDrift +
        " record(s) changed on the instance since baseline. " +
        "Keep them with a refresh, or discard with --force.",
    );
  }

  return lines.join("\n");
}
