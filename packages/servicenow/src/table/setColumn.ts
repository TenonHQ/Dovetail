/**
 * dove-sn set-column — update the dictionary attributes of an EXISTING column on an
 * EXISTING ServiceNow table, captured into a named update set, then read back and
 * verified against the instance.
 *
 * NAMING. The schema-CRUD RFC penciled this verb in as `set-field`, but that name
 * shipped first (PR #205) as a DATA verb — it sets field VALUES on a record and
 * explicitly refuses sys_dictionary. The convention that settled in practice is:
 * "field" = a record's value, "column" = a table's schema. So the create verb is
 * `add-column` (the RFC called it `add-field`) and this is `set-column`.
 *
 * WHAT AN UPDATE ACTUALLY DOES TO A COLUMN — established live on tenonworkshed,
 * 2026-07-14, by writing values and reading them back, not by trusting an HTTP 200:
 *
 *   - label / mandatory / default_value / read_only  — plain dictionary-row fields.
 *     A pushWithUpdateSet write lands and sticks.
 *
 *   - max_length — PHYSICAL. It maps to the real database column, so changing it
 *     requires an ALTER. A pushWithUpdateSet write DOES fire that ALTER, in both
 *     directions (proven: 255 -> 100 shrank the column; 100 -> 200 grew it). No
 *     Studio form-replay is needed, which retires risk R2 in the RFC.
 *
 *   - internal_type — PHYSICAL, and a TRAP. ServiceNow accepts the write, returns
 *     HTTP 200, and silently ignores it: the field does not change and the
 *     update-set XML is not even touched. A verb that wrote it and trusted the 200
 *     would report success for an operation that did nothing. It is REFUSED here.
 *
 *   - element — immutable. A column cannot be renamed (RFC §4.5); that is a
 *     delete + recreate. REFUSED.
 *
 *   - a max_length SHRINK below the data already in the column — the third silent
 *     no-op. ServiceNow refuses it, and refuses SILENTLY: 200 OK, column unchanged,
 *     data intact. Clear the over-long values and the identical shrink then works. So
 *     the platform protects the data; it just never tells you why nothing happened.
 *     set-column runs a pre-flight, NAMES the rows that block the shrink, and refuses
 *     rather than issuing a write that would be quietly ignored (--force-shrink to
 *     attempt it regardless).
 *
 * AN ALTER FIRES ON A CHANGE, NOT ON A WRITE. Writing 40 over an existing 40 is a
 * no-op: ServiceNow sees no change, no ALTER runs, and the call still succeeds. So a
 * request whose values already match is reported as `unchanged` — never as `applied`,
 * which would imply we had confirmed the physical column. We have not, and cannot,
 * from metadata alone: a column created by the pre-fix add-column claims 40 while
 * really being varchar(255). Repairing such a column is a separate story.
 *
 * The through-line: THREE of the operations this verb could perform return HTTP 200 and
 * do nothing. That is why every write is read back and compared, and why nothing is ever
 * reported as applied on the strength of a status code.
 *
 * Fields are taken from a strict ALLOWLIST, not an open map — an unbounded write to
 * sys_dictionary lets a caller quietly corrupt the schema.
 *
 * ES6 only, no optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";

/** The dictionary attributes set-column will write, keyed by the friendly name a
 *  caller uses. Everything absent from this map is refused. */
var WRITABLE: Record<string, string> = {
  label: "column_label",
  mandatory: "mandatory",
  default: "default_value",
  readOnly: "read_only",
  maxLength: "max_length",
};

/** Attributes ServiceNow will not honour on an existing column, and the reason. Each
 *  is refused up front rather than written and hopefully verified — writing them
 *  produces a success response and no change. */
var REFUSED: Record<string, string> = {
  internalType:
    "ServiceNow silently ignores an internal_type change on an existing column — it " +
    "returns HTTP 200, the field does not change, and nothing is captured (verified " +
    "live 2026-07-14). Delete and recreate the column with the type you want.",
  type: "internal_type cannot be changed on an existing column — delete and recreate it.",
  element:
    "a column cannot be renamed — `element` is immutable. Delete the column and " +
    "recreate it under the new name, migrating the data yourself.",
  name: "a column cannot be renamed — `element` is immutable. Delete and recreate it.",
};

export interface ColumnAttributes {
  /** The column's display label (sys_dictionary.column_label). */
  label?: string;
  /** Whether a value is required (sys_dictionary.mandatory). */
  mandatory?: boolean;
  /** The column's default value (sys_dictionary.default_value). */
  default?: string;
  /** Whether the column is locked against edits (sys_dictionary.read_only). */
  readOnly?: boolean;
  /** PHYSICAL: the column's length. Changing this fires a real ALTER on the table. */
  maxLength?: number;

  // The two below are declared ONLY so a caller can express them and be told why they
  // cannot be done. Silently dropping them would leave someone who asked to rename a
  // column believing it worked. Both are REFUSED with an explanation (see REFUSED).
  /** REFUSED — ServiceNow returns 200 and silently ignores a type change. */
  internalType?: string;
  /** REFUSED — a column cannot be renamed; that is a delete + recreate. */
  element?: string;
}

export interface SetColumnParams {
  client: ServiceNowClient;
  /** The table the column lives on, by name (e.g. "x_cadso_journey"). */
  table: string;
  /** The column's element (its real name, e.g. "description"). */
  column: string;
  /** The attributes to set. At least one is required. */
  attributes: ColumnAttributes;
  /** Update set to capture the change into. REQUIRED on the live path. */
  updateSetSysId?: string;
  /** Plan only — resolves and diffs, writes nothing. */
  dryRun?: boolean;
  /**
   * Skip the pre-flight check and attempt a shrink anyway, even though rows hold longer
   * values. OFF by default. Not a way to force data loss — ServiceNow silently refuses
   * such a shrink and preserves the data (see findTruncationRisk); the write will simply
   * be reported `failed` on read-back. The escape hatch exists because that behaviour was
   * observed on one instance, and an instance that DID truncate must not be able to do so
   * by accident.
   */
  forceShrink?: boolean;
}

/** One attribute's before -> after, as stored on the instance. */
export interface AttributeChange {
  attribute: string;
  from: string;
  to: string;
}

export interface SetColumnResult {
  status: "dry-run" | "applied" | "unchanged" | "failed";
  table: string;
  column: string;
  /** sys_id of the sys_dictionary row. */
  columnSysId: string;
  updateSetSysId: string;
  /** The attributes that differed and were written (empty when nothing changed). */
  changes: Array<AttributeChange>;
  /** True only when every requested value was READ BACK from the instance and matched. */
  verified: boolean;
  /** True when the sys_update_xml row for this column was found in the named update
   *  set. A write that lands but is not captured cannot be promoted — it dies on this
   *  instance, so a 200 alone is not success. */
  capturedInUpdateSet: boolean;
  note: string;
}

/** Normalize a requested attribute to the string ServiceNow stores, so the diff
 *  compares like with like (booleans are "true"/"false"; numbers are decimal). */
export function toStoredValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Translate the caller's friendly attributes into the sys_dictionary columns to write.
 * Throws on anything not on the allowlist — including the attributes ServiceNow will
 * silently refuse, which must fail loudly here rather than look like a success there.
 */
export function resolveAttributes(
  attributes: ColumnAttributes,
): Record<string, string> {
  if (!attributes || typeof attributes !== "object") {
    throw new Error("set-column: attributes object is required.");
  }
  var out: Record<string, string> = {};
  var keys = Object.keys(attributes);
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    var value = (attributes as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (REFUSED[key]) {
      throw new Error(
        "set-column: refusing to set '" + key + "' — " + REFUSED[key],
      );
    }
    var target = WRITABLE[key];
    if (!target) {
      throw new Error(
        "set-column: '" +
          key +
          "' is not a settable column attribute. Settable: " +
          Object.keys(WRITABLE).join(", ") +
          ".",
      );
    }
    out[target] = toStoredValue(value as string | number | boolean);
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      "set-column: at least one attribute to set is required (" +
        Object.keys(WRITABLE).join(", ") +
        ").",
    );
  }
  return out;
}

/** Fetch the column's dictionary row, or throw a message that says what to check. */
async function fetchColumn(
  client: ServiceNowClient,
  table: string,
  column: string,
  fields: Array<string>,
): Promise<Record<string, unknown>> {
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_dictionary",
    "name=" + table + "^element=" + column,
    { limit: 1, fields: fields },
  );
  if (rows.length === 0) {
    throw new Error(
      "set-column: no column '" +
        column +
        "' on table '" +
        table +
        "' (no sys_dictionary row). Check the table and column names, and that your " +
        "user can read sys_dictionary. To CREATE a column, use add-column.",
    );
  }
  return rows[0];
}

/** How many rows we will read when checking a shrink for truncation. A table bigger
 *  than this cannot be proven safe from here, and we say so rather than guess. */
var TRUNCATION_SCAN_LIMIT = 1000;

export interface TruncationRisk {
  /** Rows (within the scan) whose current value is longer than the new length. */
  offenders: number;
  /** The longest value found, so the caller can see how much room is actually needed. */
  longest: number;
  /** sys_ids of the first few offending rows, to make the problem concrete. */
  samples: Array<string>;
  /** True when the table has more populated rows than we read — we did NOT see them
   *  all, so "no offenders found" would be a guess, not a fact. */
  incomplete: boolean;
}

/**
 * Would shrinking this column cut existing data?
 *
 * WHAT THE PLATFORM ACTUALLY DOES (measured on tenonworkshed, 2026-07-14, by trying it):
 * ServiceNow REFUSES to shrink a column below the length of data already in it — and
 * refuses SILENTLY. The write returns HTTP 200, max_length stays where it was, and the
 * data is left intact. Clear the offending values and the identical shrink then works.
 * So the platform protects the data; what it does not do is tell you why nothing
 * happened. Without this check you get an opaque "the column did not change".
 *
 * Hence the pre-flight: find the rows that block the shrink and NAME them, instead of
 * letting the caller issue a write that will be quietly ignored. It is also
 * defence-in-depth — that silent refusal was observed on ONE instance, and betting a
 * table's data on every ServiceNow/DB combination behaving identically is not a bet
 * worth taking.
 *
 * ServiceNow's encoded queries cannot filter on string length, so the values have to be
 * read and measured here. That is bounded: we read at most TRUNCATION_SCAN_LIMIT rows,
 * and if the column has more populated rows than that we report `incomplete` rather than
 * pretending the absence of evidence is evidence of absence.
 */
export async function findTruncationRisk(
  client: ServiceNowClient,
  table: string,
  column: string,
  newLength: number,
): Promise<TruncationRisk> {
  var rows = await client.table.query<Record<string, unknown>>(
    table,
    column + "ISNOTEMPTY",
    { limit: TRUNCATION_SCAN_LIMIT, fields: ["sys_id", column] },
  );
  var offenders = 0;
  var longest = 0;
  var samples: Array<string> = [];
  for (var i = 0; i < rows.length; i += 1) {
    var value = fieldToString(rows[i][column]);
    if (value.length > longest) longest = value.length;
    if (value.length > newLength) {
      offenders += 1;
      if (samples.length < 3) samples.push(fieldToString(rows[i].sys_id));
    }
  }
  return {
    offenders: offenders,
    longest: longest,
    samples: samples,
    incomplete: rows.length >= TRUNCATION_SCAN_LIMIT,
  };
}

/** Human-readable version of the risk, used in both the refusal and the dry-run note. */
function describeRisk(
  table: string,
  column: string,
  from: string,
  to: string,
  risk: TruncationRisk,
): string {
  if (risk.offenders > 0) {
    return (
      "shrinking " +
      table +
      "." +
      column +
      " from " +
      from +
      " to " +
      to +
      " will NOT take: " +
      risk.offenders +
      (risk.incomplete ? "+" : "") +
      " row(s) already hold a longer value (longest is " +
      risk.longest +
      " characters). ServiceNow refuses to shrink a column below the data in it — and " +
      "refuses SILENTLY, returning success while leaving the column unchanged. Shorten " +
      "or clear those values first and the shrink will work. Sample rows: " +
      risk.samples.join(", ") +
      "."
    );
  }
  return (
    "shrinking " +
    table +
    "." +
    column +
    " from " +
    from +
    " to " +
    to +
    ", and the column holds more rows than can be checked from here (read the first " +
    TRUNCATION_SCAN_LIMIT +
    "). No over-length value was found among them, but the rest were NOT checked, so " +
    "this shrink cannot be proven safe."
  );
}

/**
 * Assert the change was captured into the named update set. A write that lands on the
 * instance but is not captured can never be promoted — it exists only here. The
 * dictionary row's update name is deterministic, so we can look for it directly.
 */
async function assertCaptured(
  client: ServiceNowClient,
  table: string,
  column: string,
  updateSetSysId: string,
): Promise<boolean> {
  var name = "sys_dictionary_" + table + "_" + column;
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_update_xml",
    "update_set=" + updateSetSysId + "^name=" + name,
    { limit: 1, fields: ["sys_id", "name"] },
  );
  return rows.length > 0;
}

export async function setColumn(
  params: SetColumnParams,
): Promise<SetColumnResult> {
  if (!params || !params.client) {
    throw new Error("set-column: client is required.");
  }
  if (!params.table || !String(params.table).trim()) {
    throw new Error("set-column: --table is required.");
  }
  if (!params.column || !String(params.column).trim()) {
    throw new Error("set-column: --column is required.");
  }
  // Refusals and the allowlist are enforced BEFORE anything touches the instance, so
  // an unsettable attribute fails on the dry-run too.
  var writes = resolveAttributes(params.attributes);
  var targets = Object.keys(writes);

  var table = String(params.table).trim();
  var column = String(params.column).trim();

  var readFields = ["sys_id", "element", "internal_type"].concat(targets);
  var row = await fetchColumn(params.client, table, column, readFields);
  var columnSysId = fieldToString(row.sys_id);

  // Diff against what the instance actually stores. Only a genuine difference is
  // written: ServiceNow fires the physical ALTER on a CHANGE, and a same-value write
  // is a no-op that would still report success.
  var changes: Array<AttributeChange> = [];
  for (var i = 0; i < targets.length; i += 1) {
    var field = targets[i];
    var from = fieldToString(row[field]);
    var to = writes[field];
    if (from !== to) {
      changes.push({ attribute: field, from: from, to: to });
    }
  }

  // A max_length SHRINK fires an ALTER that silently truncates every longer value —
  // exactly the irreversible data loss this verb exists to prevent. Look before leaping:
  // a warning on the dry-run, a refusal on the live path.
  var shrink = changes.filter(function (c) {
    return (
      c.attribute === "max_length" &&
      c.from !== "" &&
      Number(c.to) < Number(c.from)
    );
  })[0];
  var risk: TruncationRisk | null = null;
  if (shrink) {
    risk = await findTruncationRisk(
      params.client,
      table,
      column,
      Number(shrink.to),
    );
  }
  var unsafeShrink = Boolean(
    risk && (risk.offenders > 0 || risk.incomplete) && !params.forceShrink,
  );
  var riskNote =
    unsafeShrink && shrink && risk
      ? " REFUSED WITHOUT --force-shrink: " +
        describeRisk(table, column, shrink.from, shrink.to, risk)
      : "";

  if (params.dryRun) {
    return {
      status: "dry-run",
      table: table,
      column: column,
      columnSysId: columnSysId,
      updateSetSysId: params.updateSetSysId ? params.updateSetSysId : "",
      changes: changes,
      verified: false,
      capturedInUpdateSet: false,
      note:
        riskNote +
        (changes.length === 0
          ? "dry-run: no write. " +
            column +
            " on " +
            table +
            " already holds every requested value — nothing would change."
          : "dry-run: no write. Would set " +
            describeChanges(changes) +
            " on " +
            table +
            "." +
            column +
            ", captured into update set " +
            (params.updateSetSysId
              ? params.updateSetSysId
              : "(none provided)") +
            "."),
    };
  }

  if (!params.updateSetSysId || !String(params.updateSetSysId).trim()) {
    throw new Error(
      "set-column: --update-set <sys_id> is required so the schema change is captured " +
        "and can be promoted. An uncaptured change exists only on this instance.",
    );
  }
  var updateSetSysId = String(params.updateSetSysId).trim();

  // The shrink guard. Refuse rather than fire an ALTER that would cut live data: the
  // truncation is silent and irreversible, and a verb built to stop silent data loss
  // must not be the thing that causes it. Opting in has to be deliberate and explicit.
  if (unsafeShrink && shrink && risk) {
    throw new Error(
      "set-column: refusing to shrink — " +
        describeRisk(table, column, shrink.from, shrink.to, risk) +
        " Nothing was written. To attempt it anyway, re-run with --force-shrink " +
        "(forceShrink: true) — but expect ServiceNow to ignore it.",
    );
  }

  // Nothing to do. Say so honestly rather than writing a value over itself and calling
  // it applied: that write would be a no-op, no ALTER would fire, and a green result
  // would imply we had confirmed the PHYSICAL column. Metadata equality does not prove
  // that — a column created by the pre-fix add-column reads 40 and is really 255.
  if (changes.length === 0) {
    return {
      status: "unchanged",
      table: table,
      column: column,
      columnSysId: columnSysId,
      updateSetSysId: updateSetSysId,
      changes: [],
      verified: true,
      capturedInUpdateSet: false,
      note:
        table +
        "." +
        column +
        " already holds every requested value — nothing written. NOTE: for max_length " +
        "this confirms the dictionary row only. It does not prove the physical column " +
        "is that size; a column created before the add-column sizing fix can claim one " +
        "length and really be another. Re-sizing such a column is a separate repair.",
    };
  }

  await params.client.claude.pushWithUpdateSet({
    update_set_sys_id: updateSetSysId,
    table: "sys_dictionary",
    record_sys_id: columnSysId,
    fields: writes,
  });

  // Read back from the instance. The write returning 200 is not evidence — that is
  // exactly what internal_type does while changing nothing.
  var after = await fetchColumn(params.client, table, column, readFields);
  var mismatched: Array<string> = [];
  for (var j = 0; j < targets.length; j += 1) {
    var name = targets[j];
    var got = fieldToString(after[name]);
    if (got !== writes[name]) {
      mismatched.push(
        name + " reads back as '" + got + "', not '" + writes[name] + "'",
      );
    }
  }
  var verified = mismatched.length === 0;
  var captured = await assertCaptured(
    params.client,
    table,
    column,
    updateSetSysId,
  );

  if (!verified) {
    return {
      status: "failed",
      table: table,
      column: column,
      columnSysId: columnSysId,
      updateSetSysId: updateSetSysId,
      changes: changes,
      verified: false,
      capturedInUpdateSet: captured,
      note:
        "the write returned success but the column did NOT change: " +
        mismatched.join("; ") +
        ". ServiceNow accepts and silently ignores some dictionary changes, so treat " +
        "this column as NOT updated and reconcile it on the instance.",
    };
  }

  return {
    status: "applied",
    table: table,
    column: column,
    columnSysId: columnSysId,
    updateSetSysId: updateSetSysId,
    changes: changes,
    verified: true,
    capturedInUpdateSet: captured,
    note: captured
      ? "Set " +
        describeChanges(changes) +
        " on " +
        table +
        "." +
        column +
        " — verified by read-back, and captured in update set " +
        updateSetSysId +
        "."
      : "Set " +
        describeChanges(changes) +
        " on " +
        table +
        "." +
        column +
        " and verified by read-back, but NO sys_update_xml row was found in update set " +
        updateSetSysId +
        " — the change is live on this instance but is NOT captured, so it cannot be " +
        "promoted. Check the update set is in progress and in the column's scope.",
  };
}

/** "max_length 40 -> 4000, mandatory false -> true" */
function describeChanges(changes: Array<AttributeChange>): string {
  return changes
    .map(function (c) {
      return (
        c.attribute + " " + (c.from === "" ? "(empty)" : c.from) + " -> " + c.to
      );
    })
    .join(", ");
}
