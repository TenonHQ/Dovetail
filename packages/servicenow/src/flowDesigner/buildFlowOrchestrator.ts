/**
 * Orchestrator for /sn-build-flow: validate spec → dispatch clone/create →
 * verify structurally → trigger best-effort publication → emit a result with
 * exit-code semantics that the CLI maps directly.
 *
 * Phase 1 ships clone for both subflow and actionType. Create is wired to
 * a NotImplemented branch so the spec format is locked in now and can be
 * filled in by Phase 1.C.2 without changing the CLI contract.
 */

import type { ServiceNowClient } from "../client";
import { cloneSubflow } from "./cloneSubflow";
import type { CloneSubflowResult } from "./cloneSubflow";
import { cloneActionType } from "./cloneActionType";
import type { CloneActionTypeResult } from "./cloneActionType";
import { verifyArtifact } from "./verifyArtifact";
import type { VerifyReport } from "./verifyArtifact";
import { triggerPublication } from "./triggerPublication";
import type { TriggerPublicationResult } from "./triggerPublication";
import type { FlowKind } from "./listTemplates";

export interface BuildFlowSpec {
  kind: FlowKind;
  mode: "clone" | "create";
  sourceSysId?: string;
  newName: string;
  newScope: string;
  updateSetSysId: string;
  modifications?: {
    description?: string;
    fieldPatch?: Record<string, unknown>;
  };
}

export interface BuildFlowOptions {
  dryRun?: boolean;
  /** Skip the publish step entirely; only run clone + verify. */
  skipPublish?: boolean;
  /** Forwarded to triggerPublication. Useful for tight tests; defaults to its own 15s. */
  snapshotTimeoutMs?: number;
}

/**
 * Outcome categories. Maps directly to CLI exit codes:
 *   done                  → 0
 *   needs-ui-publish      → 2 (writes + verify ok, publish degraded)
 *   verify-mismatch       → 3 (writes ok but verify saw counts that don't match expectations)
 *   write-failed          → 4 (escalated; partial state in update set)
 *   unrecoverable         → 5 (spec or auth bug — never even reached SN)
 *   dry-run               → 0 (no writes, plan emitted)
 *   unchanged             → 0 (idempotent short-circuit)
 */
export type BuildFlowOutcome =
  | "done"
  | "needs-ui-publish"
  | "verify-mismatch"
  | "write-failed"
  | "unrecoverable"
  | "dry-run"
  | "unchanged";

export interface BuildFlowResult {
  outcome: BuildFlowOutcome;
  exitCode: 0 | 2 | 3 | 4 | 5;
  spec: BuildFlowSpec;
  /** Filled when clone/create produced a new artifact. */
  artifact?: {
    sysId: string;
    action: "created" | "unchanged";
    writtenCount: number;
  };
  verify?: VerifyReport;
  publish?: TriggerPublicationResult;
  /** Fired only on dryRun; the planned write graph. */
  plan?: Array<{ id: string; table: string; logicalName: string }>;
  error?: { stage: string; message: string };
}

const RX_SYS_ID = /^[0-9a-f]{32}$/;

function unrecoverable(spec: BuildFlowSpec, stage: string, message: string): BuildFlowResult {
  return {
    outcome: "unrecoverable",
    exitCode: 5,
    spec: spec,
    error: { stage: stage, message: message },
  };
}

function validateSpec(spec: any): BuildFlowSpec {
  if (!spec || typeof spec !== "object") throw new Error("spec must be a JSON object");
  if (spec.kind !== "subflow" && spec.kind !== "actionType") {
    throw new Error("spec.kind must be 'subflow' or 'actionType', got " + JSON.stringify(spec.kind));
  }
  if (spec.mode !== "clone" && spec.mode !== "create") {
    throw new Error("spec.mode must be 'clone' or 'create', got " + JSON.stringify(spec.mode));
  }
  if (spec.mode === "clone" && (!spec.sourceSysId || !RX_SYS_ID.test(spec.sourceSysId))) {
    throw new Error("spec.sourceSysId must be a 32-char sys_id when mode=clone");
  }
  if (typeof spec.newName !== "string" || spec.newName.trim().length === 0) {
    throw new Error("spec.newName is required");
  }
  if (!RX_SYS_ID.test(spec.newScope || "")) {
    throw new Error("spec.newScope must be a 32-char sys_scope sys_id");
  }
  if (!RX_SYS_ID.test(spec.updateSetSysId || "")) {
    throw new Error("spec.updateSetSysId must be a 32-char sys_id");
  }
  return spec as BuildFlowSpec;
}

async function ensureUpdateSetInProgress(client: ServiceNowClient, sysId: string): Promise<void> {
  var rows = await client.buildAgent.runQuery<{ sys_id: string; state: string; name: string }>({
    table: "sys_update_set",
    query: "sys_id=" + sysId,
    limit: 1,
  });
  if (!rows.length) {
    throw new Error("update set " + sysId + " not found");
  }
  var us = rows[0];
  if (us.state !== "in progress" && us.state !== "in_progress") {
    throw new Error("update set '" + us.name + "' is in state '" + us.state + "' — only 'in progress' update sets can capture new changes.");
  }
}

export async function runBuildFlow(
  client: ServiceNowClient,
  rawSpec: unknown,
  opts: BuildFlowOptions = {},
): Promise<BuildFlowResult> {
  // Phase 0: validation (synchronous spec checks).
  var spec: BuildFlowSpec;
  try {
    spec = validateSpec(rawSpec);
  } catch (err: any) {
    return unrecoverable(rawSpec as BuildFlowSpec, "validateSpec", err.message);
  }

  if (spec.mode === "create") {
    return unrecoverable(spec, "dispatch", "mode=create is not implemented in Phase 1 (clone only). Filed for Phase 1.C.2.");
  }

  // Phase 1: update set check (network).
  if (!opts.dryRun) {
    try {
      await ensureUpdateSetInProgress(client, spec.updateSetSysId);
    } catch (err: any) {
      return unrecoverable(spec, "ensureUpdateSet", err.message);
    }
  }

  // Phase 2: dispatch clone.
  var cloneResult: CloneSubflowResult | CloneActionTypeResult;
  try {
    if (spec.kind === "subflow") {
      cloneResult = await cloneSubflow({
        client: client,
        sourceSysId: spec.sourceSysId as string,
        newName: spec.newName,
        newScope: spec.newScope,
        updateSetSysId: spec.updateSetSysId,
        modifications: spec.modifications,
        dryRun: opts.dryRun,
      });
    } else {
      cloneResult = await cloneActionType({
        client: client,
        sourceSysId: spec.sourceSysId as string,
        newName: spec.newName,
        newScope: spec.newScope,
        updateSetSysId: spec.updateSetSysId,
        modifications: spec.modifications,
        dryRun: opts.dryRun,
      });
    }
  } catch (err: any) {
    return {
      outcome: "write-failed",
      exitCode: 4,
      spec: spec,
      error: { stage: spec.kind === "subflow" ? "cloneSubflow" : "cloneActionType", message: err.message || String(err) },
    };
  }

  // Dry run: emit the plan and stop.
  if (opts.dryRun) {
    return {
      outcome: "dry-run",
      exitCode: 0,
      spec: spec,
      artifact: { sysId: cloneResult.sysId, action: cloneResult.action, writtenCount: 0 },
      plan: (cloneResult.plan || []).map(function (op) {
        return { id: op.id, table: op.table, logicalName: op.logicalName };
      }),
    };
  }

  // Idempotent short-circuit: nothing to verify against because we didn't write.
  if (cloneResult.action === "unchanged") {
    return {
      outcome: "unchanged",
      exitCode: 0,
      spec: spec,
      artifact: { sysId: cloneResult.sysId, action: "unchanged", writtenCount: 0 },
    };
  }

  // Phase 3: structural verification (L1 + L4 if publish ran).
  var verify: VerifyReport;
  try {
    verify = await verifyArtifact({
      client: client,
      sysId: cloneResult.sysId,
      kind: spec.kind,
    });
  } catch (err: any) {
    return {
      outcome: "verify-mismatch",
      exitCode: 3,
      spec: spec,
      artifact: { sysId: cloneResult.sysId, action: cloneResult.action, writtenCount: cloneResult.written.length },
      error: { stage: "verifyArtifact", message: err.message || String(err) },
    };
  }

  if (!verify.found.parent) {
    return {
      outcome: "verify-mismatch",
      exitCode: 3,
      spec: spec,
      artifact: { sysId: cloneResult.sysId, action: cloneResult.action, writtenCount: cloneResult.written.length },
      verify: verify,
    };
  }

  // Phase 4: publication (best-effort, degraded mode until Phase 0 lands).
  var publish: TriggerPublicationResult | undefined;
  if (!opts.skipPublish) {
    try {
      publish = await triggerPublication({
        client: client,
        sysId: cloneResult.sysId,
        kind: spec.kind,
        updateSetSysId: spec.updateSetSysId,
        snapshotTimeoutMs: opts.snapshotTimeoutMs,
      });
    } catch (err: any) {
      // triggerPublication is engineered to never throw on the happy path,
      // but defensive: treat unexpected throws as needs-ui-publish.
      publish = {
        status: "needs-ui-publish",
        pushSucceeded: false,
        uiPublishUrl: undefined,
      };
    }
  }

  var artifact = {
    sysId: cloneResult.sysId,
    action: cloneResult.action,
    writtenCount: cloneResult.written.length,
  };

  if (!publish || publish.status === "needs-ui-publish" || publish.status === "snapshot-pending") {
    return {
      outcome: "needs-ui-publish",
      exitCode: 2,
      spec: spec,
      artifact: artifact,
      verify: verify,
      publish: publish,
    };
  }

  return {
    outcome: "done",
    exitCode: 0,
    spec: spec,
    artifact: artifact,
    verify: verify,
    publish: publish,
  };
}
