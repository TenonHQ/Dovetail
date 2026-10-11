/**
 * dove-sn create-record — create ONE new record in a data table, captured
 * into a specified update set, then read back and verify.
 *
 * Wraps the Dovetail core Scripted REST `createRecord` op, which switches the
 * executing user's app scope and update set server-side, inserts, and
 * restores both — so the record is owned by the right app and the insert is
 * captured in the right update set without touching sys_user_preference.
 * The INSERT counterpart to `set-field`.
 *
 * NOT for schema tables (sys_db_object / sys_dictionary) — that's
 * create-table / add-column. NOT for sys_update_set — that's
 * `dove createUpdateSet`. To UPDATE an existing record, use `set-field`.
 */

import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import { fieldToString, pickFields, verifyReadBack, readBackNote, uniqueFields } from "./setField";
import type { RecordWriteResult } from "./setField";
import {
  domainProblemNote,
  domainSnapshot,
  normalizeDomain,
  readServerDomainEcho
} from "./domain";
import type { DomainCheck } from "./domain";

export interface CreateRecordParams {
  client?: ServiceNowClient;
  table: string;
  /** Field name -> value for the new record. Values are sent as strings; ServiceNow coerces. */
  fields: Record<string, string>;
  /** App scope that will own the record. Required — session-scope stamping is the #1 wrong-scope cause. */
  scope?: string;
  /** Update set to capture the insert into. Required for a tracked write. */
  updateSetSysId?: string;
  /** Encoded query; when it already matches a row the insert is skipped (idempotent re-runs). */
  ifAbsentQuery?: string;
  /**
   * Session domain to insert in: "global" or a domain sys_id. Defaults to the
   * payload's own sys_domain when it carries one, else "global". On a
   * domain-separated instance the platform stamps the SESSION domain on an insert
   * and ignores a sys_domain in the payload — so the domain must be chosen here.
   */
  domain?: string;
  dryRun?: boolean;
}

export interface CreateRecordResult extends RecordWriteResult {
  status: "dry-run" | "created" | "skipped" | "failed";
  scope: string;
}

// Same guard as set-field: schema tables are never written as data — routed to
// the dedicated schema verbs instead so we never orphan or corrupt metadata.
var REFUSED_TABLES = ["sys_db_object", "sys_dictionary"];

// The generic createRecord op never sets `application`, so an update set
// inserted through it lands in the session app while the read-back (name only)
// still reports success. Update sets go through the scope-correct
// createUpdateSet op instead.
var UPDATE_SET_TABLE = "sys_update_set";

export async function createRecord(params: CreateRecordParams): Promise<CreateRecordResult> {
  var client = params.client || createClient({});
  var table = params.table;
  if (!table) {
    throw new Error("create-record: --table is required.");
  }
  if (REFUSED_TABLES.indexOf(table) !== -1) {
    throw new Error(
      "create-record: refusing to write " + table + " as data — it is a schema table. "
        + "Use add-column / create-table for schema changes."
    );
  }
  if (table === UPDATE_SET_TABLE) {
    throw new Error(
      "create-record: refusing to create a sys_update_set record — the generic createRecord op "
        + "does not set its application, so the set would land in the session app. "
        + "Use `dove createUpdateSet --name <name> --scope <scope>` instead."
    );
  }
  var fieldNames = params.fields ? Object.keys(params.fields) : [];
  if (fieldNames.length === 0) {
    throw new Error("create-record: at least one field (--fields key=value) is required.");
  }
  if (!params.scope) {
    throw new Error("create-record: --scope is required so the record is owned by the right app.");
  }
  if (!params.updateSetSysId) {
    throw new Error("create-record: --update-set <sys_id> is required so the insert is captured.");
  }

  var domain = resolveCreateDomain(params);
  var domainCheck: DomainCheck = {
    requested: domain,
    domainAware: false,
    expected: domain,
    actual: "",
    overridesCreated: [],
    serverAcknowledged: false,
    problems: []
  };

  var readFields = uniqueFields(["sys_id"].concat(fieldNames, ["sys_domain"]));

  // Idempotent re-runs: skip the insert when the guard query already matches.
  if (params.ifAbsentQuery) {
    // noDomain: a row that already exists in another domain must still count as
    // present, or a re-run would insert a duplicate the caller cannot see.
    var existing = await client.table.query(table, params.ifAbsentQuery, {
      limit: 1,
      fields: readFields,
      noDomain: true
    });
    if (existing.length > 0) {
      var existingSysId = fieldToString(existing[0].sys_id);
      var existingValues = pickFields(existing[0], fieldNames);
      var existingCheck = verifyReadBack(params.fields, existingValues);
      var existingDomain = domainSnapshot(existing[0]);
      domainCheck.domainAware = existingDomain.domainAware;
      domainCheck.actual = existingDomain.domain;
      if (existingDomain.domainAware && existingDomain.domain !== domain) {
        domainCheck.problems.push(
          "The existing row is in sys_domain " + (existingDomain.domain || "(empty)") + ", not " + domain
            + " — move it with set-field --fields \"sys_domain=" + domain + "\"."
        );
      }
      var matches = existingCheck.verified && domainCheck.problems.length === 0;
      return {
        status: "skipped",
        table: table,
        sysId: existingSysId,
        scope: params.scope,
        updateSetSysId: params.updateSetSysId,
        fields: params.fields,
        after: existingValues,
        verified: matches,
        domain: domainCheck,
        note: matches
          ? "skipped: --if-absent matched " + table + "/" + existingSysId
            + " and its values already match." + readBackNote(existingCheck)
          : "skipped: --if-absent matched " + table + "/" + existingSysId
            + (existingCheck.verified
              ? " but its domain differs. " + domainCheck.problems.join(" ")
              : " but its values differ from the requested fields — use set-field to update it.")
      };
    }
  }

  if (params.dryRun) {
    return {
      status: "dry-run",
      table: table,
      sysId: "",
      scope: params.scope,
      updateSetSysId: params.updateSetSysId,
      fields: params.fields,
      after: {},
      verified: false,
      domain: domainCheck,
      note: "dry-run: no write. Would create a " + table + " record with "
        + JSON.stringify(params.fields) + " in scope " + params.scope
        + " and session domain " + domain
        + ", captured into update set " + params.updateSetSysId + "."
    };
  }

  // Insert via the scope- and update-set-aware core REST op.
  var created = await client.claude.createRecord({
    table: table,
    fields: params.fields,
    scope: params.scope,
    update_set_sys_id: params.updateSetSysId,
    domain: domain
  });
  domainCheck.serverAcknowledged = readServerDomainEcho(created) !== null;
  var sysId = fieldToString(created && created.sys_id);
  if (!sysId) {
    return {
      status: "failed",
      table: table,
      sysId: "",
      scope: params.scope,
      updateSetSysId: params.updateSetSysId,
      fields: params.fields,
      after: {},
      verified: false,
      domain: domainCheck,
      note: "createRecord returned no sys_id — the insert may not have landed; check the instance."
    };
  }

  // Read back and verify each field equals what we sent.
  var afterRows = await client.table.query(table, "sys_id=" + sysId, {
    limit: 1,
    fields: readFields,
    noDomain: true
  });
  var after = pickFields(afterRows[0] || {}, fieldNames);
  // A requested sys_domain is checked by the domain check below, which knows the
  // platform may legitimately store it as "global" vs the caller's spelling.
  var fieldCheckInput: Record<string, string> = {};
  Object.keys(params.fields).forEach(function (k) {
    if (k !== "sys_domain") fieldCheckInput[k] = params.fields[k];
  });
  var check = verifyReadBack(fieldCheckInput, after);
  var afterDomain = domainSnapshot(afterRows[0]);
  domainCheck.domainAware = afterDomain.domainAware;
  domainCheck.actual = afterDomain.domain;
  if (afterDomain.domainAware && afterDomain.domain !== domain) {
    domainCheck.problems.push(
      "The insert landed in sys_domain " + (afterDomain.domain || "(empty)") + ", not " + domain + "."
        + " Fix it with set-field --sys-id " + sysId + " --fields \"sys_domain=" + domain
        + "\" --update-set " + params.updateSetSysId + "."
    );
  }
  var verified = afterRows.length > 0 && check.verified && domainCheck.problems.length === 0;

  var note: string;
  if (verified) {
    note = "Created " + table + "/" + sysId + " and verified via read-back"
      + (afterDomain.domainAware ? " (sys_domain " + afterDomain.domain + ")" : "")
      + "." + readBackNote(check);
  } else if (domainCheck.problems.length > 0) {
    note = "Insert landed as " + sysId + ". " + domainProblemNote(domainCheck, "createRecord")
      + (check.verified ? "" : " Field read-back also differs (" + check.mismatched.join(", ") + ").");
  } else {
    note = "Insert landed as " + sysId
      + " but read-back does not match the requested values ("
      + (afterRows.length > 0 ? check.mismatched.join(", ") : "no row read back")
      + ") — check field types / ACLs.";
  }

  return {
    status: verified ? "created" : "failed",
    table: table,
    sysId: sysId,
    scope: params.scope,
    updateSetSysId: params.updateSetSysId,
    fields: params.fields,
    after: after,
    verified: verified,
    domain: domainCheck,
    note: note
  };
}

/**
 * The session domain for an insert: an explicit `domain` wins; otherwise the
 * payload's own sys_domain (the platform ignores it on insert, so honour it by
 * running the insert in that domain); otherwise "global". Both given and
 * different is a contradiction and refused.
 */
export function resolveCreateDomain(params: CreateRecordParams): string {
  var fromFields = params.fields && Object.prototype.hasOwnProperty.call(params.fields, "sys_domain")
    ? params.fields.sys_domain
    : undefined;
  var explicit: string | undefined;
  var implied: string | undefined;
  try {
    explicit = params.domain === undefined ? undefined : normalizeDomain(params.domain);
    implied = fromFields === undefined ? undefined : normalizeDomain(fromFields);
  } catch (e) {
    throw new Error("create-record: --" + (e instanceof Error ? e.message : String(e)));
  }
  if (explicit !== undefined && implied !== undefined && explicit !== implied) {
    throw new Error(
      "create-record: fields.sys_domain (" + implied + ") contradicts --domain (" + explicit
        + "). Pass the domain once, with --domain."
    );
  }
  if (explicit !== undefined) return explicit;
  if (implied !== undefined) return implied;
  return normalizeDomain(undefined);
}
