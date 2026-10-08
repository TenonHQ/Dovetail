/**
 * Cross-scope DESIGN ACCESS — the `sys_scope_design_access` record that lets one app
 * author (design) inside another app's tables.
 *
 * Why this exists: since the Zurich bw40 hotfix (tenonworkstudio, 2026-10-04), creating a
 * column from app S on a table owned by app T through the platform UI / Studio fails with
 *
 *   Invalid 'Table' selected on the Dictionary Entry record. The '<table>' table is in
 *   application '<T>', but the current application is '<S>'. The 'Table' field can only
 *   select '<T>' tables with read access enabled.
 *
 * even when the table's own Application Access flags (read / alter / configuration) are
 * all on. The fix is a Design Access record: source_scope = S (the authoring app),
 * target_package = T (the app that owns the table), owned by — and captured in an update
 * set of — S. Without it the column can still be inserted headless (the scope-aware
 * createRecord op does not hit the UI check), but the next person to open that column in
 * the UI, and the target instance's checks, trip over it. So add-column --cross-scope FLAGS
 * a missing record and can create it; this module is that check + create.
 *
 * Read-back discipline matches add-column: a created record is read back by the returned
 * sys_id and its source/target asserted before it is called verified. ES6 only, no
 * optional chaining, no `any`.
 */

import type { ServiceNowClient } from "../client";
import { fieldToString } from "../setField";

var SYS_ID = /^[0-9a-f]{32}$/i;
var SCOPE_NAME = /^[a-z0-9_]+$/i;
/** Safe to splice into an encoded query: no ^, =, spaces or other operators. */
var SAFE_ID = /^[0-9a-z_]+$/i;

export var DESIGN_ACCESS_TABLE = "sys_scope_design_access";

export interface ResolvedScopeRef {
  /** Scope NAME (e.g. "x_cadso_journey"). */
  name: string;
  /** sys_scope sys_id. */
  sysId: string;
}

/** Resolve a scope by NAME or sys_id; empty strings when not found. */
export async function resolveScopeRef(
  client: ServiceNowClient,
  scope: string,
): Promise<ResolvedScopeRef> {
  var s = String(scope || "").trim();
  if (!s) return { name: "", sysId: "" };
  if (!SYS_ID.test(s) && !SCOPE_NAME.test(s)) {
    throw new Error(
      "design-access: '" + s + "' is not a scope name or sys_scope sys_id.",
    );
  }
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_scope",
    SYS_ID.test(s) ? "sys_id=" + s : "scope=" + s,
    { limit: 1, fields: ["sys_id", "scope"] },
  );
  if (rows.length === 0) return { name: "", sysId: "" };
  return {
    name: fieldToString(rows[0].scope),
    sysId: fieldToString(rows[0].sys_id),
  };
}

/**
 * Find the Design Access record granting `sourceScopeSysId` design access to
 * `targetScopeSysId`'s tables. Returns its sys_id, or "" when there is none.
 */
export async function findDesignAccess(params: {
  client: ServiceNowClient;
  sourceScopeSysId: string;
  targetScopeSysId: string;
}): Promise<string> {
  // Both ids are spliced into an encoded query — refuse anything that could carry a
  // query operator (^, =, spaces) rather than querying on it.
  if (
    !SAFE_ID.test(params.sourceScopeSysId) ||
    !SAFE_ID.test(params.targetScopeSysId)
  ) {
    return "";
  }
  var rows = await params.client.table.query<Record<string, unknown>>(
    DESIGN_ACCESS_TABLE,
    "source_scope=" +
      params.sourceScopeSysId +
      "^target_package=" +
      params.targetScopeSysId,
    { limit: 1, fields: ["sys_id"] },
  );
  return rows.length > 0 ? fieldToString(rows[0].sys_id) : "";
}

export interface EnsureDesignAccessParams {
  client: ServiceNowClient;
  /** The AUTHORING app — scope name or sys_scope sys_id (e.g. "x_cadso_journey"). */
  sourceScope: string;
  /** The app that OWNS the tables — scope name or sys_scope sys_id (e.g. "x_cadso_automate"). */
  targetScope: string;
  /** Update set (in the SOURCE scope) to capture the record in. Required on the live path. */
  updateSetSysId?: string;
  /** Report whether the record exists / would be created — no writes. */
  dryRun?: boolean;
}

export interface EnsureDesignAccessResult {
  status: "exists" | "created" | "dry-run" | "failed";
  /** Source (authoring) scope name. */
  sourceScope: string;
  /** Target (table-owning) scope name. */
  targetScope: string;
  /** The Design Access record's sys_id ("" when absent on dry-run, or on failure before insert). */
  sysId: string;
  /** True when the record is present: found, or created and read back. */
  present: boolean;
  /** Update set the create was captured into ("" when nothing was written). */
  updateSetSysId: string;
  note: string;
}

/** Resolve both scopes, refusing unknown or identical ones. Shared by dry-run and live. */
async function resolvePair(
  params: EnsureDesignAccessParams,
): Promise<{ source: ResolvedScopeRef; target: ResolvedScopeRef }> {
  if (!params || typeof params !== "object")
    throw new Error("design-access: params object required.");
  if (!params.client) throw new Error("design-access: client is required.");
  if (!params.sourceScope || !String(params.sourceScope).trim())
    throw new Error(
      "design-access: sourceScope (the authoring app) is required.",
    );
  if (!params.targetScope || !String(params.targetScope).trim())
    throw new Error(
      "design-access: targetScope (the app that owns the tables) is required.",
    );
  var source = await resolveScopeRef(params.client, params.sourceScope);
  if (!source.sysId)
    throw new Error(
      "design-access: source scope '" +
        params.sourceScope +
        "' was not found in sys_scope.",
    );
  var target = await resolveScopeRef(params.client, params.targetScope);
  if (!target.sysId)
    throw new Error(
      "design-access: target scope '" +
        params.targetScope +
        "' was not found in sys_scope.",
    );
  if (source.sysId === target.sysId)
    throw new Error(
      "design-access: source and target are the same scope ('" +
        source.name +
        "') — an app needs no design access to its own tables.",
    );
  return { source: source, target: target };
}

/**
 * Make sure `sourceScope` has design access to `targetScope`'s tables. Idempotent: an
 * existing record is reported ("exists") and nothing is written. Dry-run reports whether
 * it exists or would be created. Live creates it through the scope-aware createRecord op
 * switched to the SOURCE scope, captured in `updateSetSysId` (which must belong to the
 * source scope), then reads it back.
 */
export async function ensureDesignAccess(
  params: EnsureDesignAccessParams,
): Promise<EnsureDesignAccessResult> {
  var pair = await resolvePair(params);
  var client = params.client;
  var label = "'" + pair.source.name + "' -> '" + pair.target.name + "'";
  var existing = await findDesignAccess({
    client: client,
    sourceScopeSysId: pair.source.sysId,
    targetScopeSysId: pair.target.sysId,
  });
  var base = {
    sourceScope: pair.source.name,
    targetScope: pair.target.name,
  };
  if (existing) {
    return {
      status: "exists",
      sourceScope: base.sourceScope,
      targetScope: base.targetScope,
      sysId: existing,
      present: true,
      updateSetSysId: "",
      note:
        "Design Access " +
        label +
        " already exists (" +
        DESIGN_ACCESS_TABLE +
        " " +
        existing +
        ") — nothing to do.",
    };
  }

  var us = params.updateSetSysId ? params.updateSetSysId.trim() : "";
  if (us) {
    if (!SAFE_ID.test(us))
      throw new Error(
        "design-access: update set '" + us + "' is not a sys_id.",
      );
    var usRows = await client.table.query<Record<string, unknown>>(
      "sys_update_set",
      "sys_id=" + us,
      { limit: 1, fields: ["sys_id", "name", "application"] },
    );
    if (usRows.length === 0)
      throw new Error(
        "design-access: update set '" +
          us +
          "' was not found in sys_update_set.",
      );
    if (fieldToString(usRows[0].application) !== pair.source.sysId) {
      throw new Error(
        "design-access: update set '" +
          (fieldToString(usRows[0].name) || us) +
          "' does not belong to the source scope '" +
          pair.source.name +
          "' — the Design Access record is owned by the AUTHORING app and ships in its " +
          "update set. Pass an update set in '" +
          pair.source.name +
          "'.",
      );
    }
  }

  if (params.dryRun) {
    return {
      status: "dry-run",
      sourceScope: base.sourceScope,
      targetScope: base.targetScope,
      sysId: "",
      present: false,
      updateSetSysId: us,
      note:
        "dry-run: no write. Design Access " +
        label +
        " is MISSING — would create it in scope '" +
        pair.source.name +
        "', captured into update set " +
        (us || "(none provided — required on the live path)") +
        ", then read it back.",
    };
  }

  if (!us) {
    throw new Error(
      "design-access: updateSetSysId is required on the live path so the record is " +
        "captured in a known update set of the source scope (dry-run does not need one).",
    );
  }

  var created: { sys_id: string; [k: string]: unknown } | undefined;
  try {
    created = await client.claude.createRecord({
      table: DESIGN_ACCESS_TABLE,
      fields: {
        source_scope: pair.source.sysId,
        target_package: pair.target.sysId,
      },
      scope: pair.source.name,
      update_set_sys_id: us,
    });
  } catch (e) {
    return failed(base, us, "", "insert failed: " + errText(e));
  }
  var newSysId = fieldToString(created && created.sys_id);
  if (!newSysId) {
    return failed(
      base,
      us,
      "",
      "createRecord returned no sys_id — the insert may not have landed; check the instance.",
    );
  }
  var rows: Array<Record<string, unknown>>;
  try {
    rows = await client.table.query<Record<string, unknown>>(
      DESIGN_ACCESS_TABLE,
      "sys_id=" + newSysId,
      { limit: 1, fields: ["sys_id", "source_scope", "target_package"] },
    );
  } catch (e) {
    return failed(
      base,
      us,
      newSysId,
      "record created but the read-back failed: " + errText(e),
    );
  }
  if (rows.length === 0) {
    return failed(
      base,
      us,
      newSysId,
      "createRecord returned " +
        newSysId +
        " but no record was found on read-back.",
    );
  }
  var gotSource = fieldToString(rows[0].source_scope);
  var gotTarget = fieldToString(rows[0].target_package);
  if (gotSource !== pair.source.sysId || gotTarget !== pair.target.sysId) {
    return failed(
      base,
      us,
      newSysId,
      "record " +
        newSysId +
        " read back as source_scope '" +
        (gotSource || "(empty)") +
        "' / target_package '" +
        (gotTarget || "(empty)") +
        "', not the requested '" +
        pair.source.sysId +
        "' / '" +
        pair.target.sysId +
        "'. Fix or delete it on the instance.",
    );
  }
  return {
    status: "created",
    sourceScope: base.sourceScope,
    targetScope: base.targetScope,
    sysId: newSysId,
    present: true,
    updateSetSysId: us,
    note:
      "Created Design Access " +
      label +
      " (" +
      DESIGN_ACCESS_TABLE +
      " " +
      newSysId +
      ") — verified on read-back, captured into update set " +
      us +
      ".",
  };
}

function errText(e: unknown): string {
  return e && (e as Error).message ? (e as Error).message : String(e);
}

function failed(
  base: { sourceScope: string; targetScope: string },
  updateSetSysId: string,
  sysId: string,
  note: string,
): EnsureDesignAccessResult {
  return {
    status: "failed",
    sourceScope: base.sourceScope,
    targetScope: base.targetScope,
    sysId: sysId,
    present: false,
    updateSetSysId: updateSetSysId,
    note: "design-access: " + note,
  };
}
