/**
 * Best-effort publication trigger for a Subflow or Custom Action Type.
 *
 * DEPRECATED FOR ACTION TYPES — the real snapshot compiler is now known and
 * shipped as `publishActionType` (see ./publishActionType.ts). That function
 * replays the Flow Designer Publish call (GET model → graft `steps` → POST to
 * /snapshot → 201) over basic auth and actually compiles sys_hub_flow_snapshot,
 * which is what makes a Custom Action Type draggable in the palette. Prefer
 * `publishActionType` for action types. `triggerPublication` is retained for
 * back-compat and for the subflow path, which still uses the degraded trigger
 * below.
 *
 * Ships in DEGRADED MODE — the deterministic field/value combo that compels
 * ServiceNow to compile sys_hub_flow_snapshot was, when this was written, an
 * unknown "Phase 0 spike". This function:
 *
 *   1. Sets `status="published"` on the parent record via pushWithUpdateSet
 *      (this is the most likely single-field trigger; harmless if it isn't).
 *   2. Polls sys_hub_flow_snapshot for up to SNAPSHOT_TIMEOUT_MS, expecting
 *      a row whose `flow` FK matches our sys_id.
 *   3. Returns one of:
 *        - { status: "published", snapshotSysId } — snapshot appeared
 *        - { status: "snapshot-pending" }          — push succeeded, no snapshot yet
 *        - { status: "needs-ui-publish", uiUrl }   — push failed or timed out
 *
 * The skill UI then prints "open Flow Designer at <uiUrl> and click Publish"
 * for the needs-ui-publish case so a human can complete the operation.
 *
 * Once Phase 0 documents the real trigger, replace the body of the
 * setStatusPublished step with the discovered recipe and tighten the
 * timing/return shape — the public type stays stable.
 */

import type { ServiceNowClient } from "../client";
import type { FlowKind } from "./listTemplates";

export interface TriggerPublicationParams {
  client: ServiceNowClient;
  sysId: string;
  kind: FlowKind;
  /** Required to push the status flip; share the clone/create call's update set. */
  updateSetSysId: string;
  /**
   * Optional instance host for the UI fallback URL — defaults to the env var
   * the client was built from. Pass it explicitly if you want a different
   * link target (e.g., a workshop instance after promotion).
   */
  instanceHost?: string;
  /** Max time spent polling the snapshot table after the push. Default 15s. */
  snapshotTimeoutMs?: number;
}

export interface TriggerPublicationResult {
  status: "published" | "snapshot-pending" | "needs-ui-publish";
  snapshotSysId?: string;
  /** Filled in when status="needs-ui-publish" so callers can surface a clickable URL. */
  uiPublishUrl?: string;
  /** True iff the push to set status="published" was accepted by SN. */
  pushSucceeded: boolean;
}

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15000;
const POLL_DELAYS_MS: ReadonlyArray<number> = [500, 1000, 2000, 4000, 8000];

function buildUiPublishUrl(host: string | undefined, kind: FlowKind, sysId: string): string {
  // Normalize host: strip protocol prefix and trailing slashes without a polynomial regex.
  // CodeQL flags /\/+$/ as ReDoS-vulnerable on uncontrolled input, so we use a bounded loop.
  var normalizedHost = host || "";
  if (normalizedHost.indexOf("://") >= 0) {
    normalizedHost = normalizedHost.substring(normalizedHost.indexOf("://") + 3);
  }
  while (normalizedHost.length > 0 && normalizedHost.charAt(normalizedHost.length - 1) === "/") {
    normalizedHost = normalizedHost.substring(0, normalizedHost.length - 1);
  }
  var base = normalizedHost ? "https://" + normalizedHost : "";
  if (!base) {
    var fallbackHost = process.env.SN_INSTANCE
      || process.env.SN_DEV_INSTANCE
      || process.env.SN_PROD_INSTANCE
      || "";
    if (fallbackHost && fallbackHost.indexOf(".") < 0) {
      fallbackHost = fallbackHost.toLowerCase() + ".service-now.com";
    }
    base = fallbackHost ? "https://" + fallbackHost : "";
  }
  if (kind === "subflow") {
    return base + "/$flow-designer.do?sysparm_nostack=true#/flow-editor/" + sysId;
  }
  return base + "/sys_hub_action_type_definition.do?sys_id=" + sysId;
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function pollForSnapshot(
  client: ServiceNowClient,
  sysId: string,
  timeoutMs: number,
): Promise<{ found: boolean; snapshotSysId?: string }> {
  var startedAt = Date.now();
  for (var i = 0; i < POLL_DELAYS_MS.length; i++) {
    var delay = POLL_DELAYS_MS[i];
    if (Date.now() - startedAt + delay > timeoutMs) break;
    await sleep(delay);
    var rows = await client.buildAgent.runQuery<{ sys_id: string }>({
      table: "sys_hub_flow_snapshot",
      query: "flow=" + sysId + "^ORDERBYDESCsys_created_on",
      limit: 1,
    });
    if (rows.length > 0) return { found: true, snapshotSysId: rows[0].sys_id };
  }
  return { found: false };
}

export async function triggerPublication(opts: TriggerPublicationParams): Promise<TriggerPublicationResult> {
  var parentTable = opts.kind === "actionType" ? "sys_hub_action_type_definition" : "sys_hub_flow";
  var timeoutMs = opts.snapshotTimeoutMs != null ? opts.snapshotTimeoutMs : DEFAULT_SNAPSHOT_TIMEOUT_MS;
  var uiUrl = buildUiPublishUrl(opts.instanceHost, opts.kind, opts.sysId);

  // Step 1: best-effort status flip. We don't actually know if this triggers
  // compilation (Phase 0). If it throws, we go straight to UI fallback.
  var pushSucceeded = false;
  try {
    await opts.client.claude.pushWithUpdateSet({
      update_set_sys_id: opts.updateSetSysId,
      table: parentTable,
      record_sys_id: opts.sysId,
      fields: { status: "published" },
    });
    pushSucceeded = true;
  } catch (err) {
    return {
      status: "needs-ui-publish",
      uiPublishUrl: uiUrl,
      pushSucceeded: false,
    };
  }

  // Step 2: poll snapshot table.
  var probe = await pollForSnapshot(opts.client, opts.sysId, timeoutMs);
  if (probe.found) {
    return {
      status: "published",
      snapshotSysId: probe.snapshotSysId,
      pushSucceeded: true,
    };
  }

  // Push went through but no snapshot — degraded outcome.
  return {
    status: "snapshot-pending",
    pushSucceeded: true,
    uiPublishUrl: uiUrl,
  };
}
