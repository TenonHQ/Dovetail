/**
 * The orchestrator: given a ClickUp status change, resolve the task's update
 * set(s) on the source and promote each to the target — idempotency check →
 * preview (never commit blind) → commit — then confirm on the task.
 *
 * A ClickUp status change is the sole trigger (D2: direct promotion, no PR).
 * Any set's failure stops the run and does NOT advance the task.
 */

import type {
  Commenter,
  PreviewError,
  PromoteResult,
  Promoter,
  PromotionLadder,
  PromotionRung,
  ResolvedUpdateSet,
  SnReader,
} from "./types";
import { nameMatchesTaskId, resolveUpdateSets } from "./resolveUpdateSets";

export interface PromoteForStatusParams {
  status: string;
  taskId: string;
  config: PromotionLadder;
  /** Reads sys_update_set on the SOURCE instance. */
  sourceReader: SnReader;
  /** Reads sys_update_set on the TARGET instance (idempotency check). */
  targetReader: SnReader;
  /** Transport pointed at the TARGET instance. */
  promoter: Promoter;
  /** Optional ClickUp comment sink. */
  commenter?: Commenter;
}

export interface PromoteOutcome {
  updateSet: ResolvedUpdateSet;
  /** "promoted" = committed now; "already" = idempotency skip. */
  status: "promoted" | "already";
  result?: PromoteResult;
}

export type PromoteForStatusResult =
  | { kind: "invalid-task-id" }
  | { kind: "skipped"; reason: string }
  | { kind: "no-update-sets" }
  | { kind: "ambiguous"; scope: string; candidates: ResolvedUpdateSet[] }
  | {
      kind: "preview-blocked";
      updateSet: ResolvedUpdateSet;
      previewErrors: PreviewError[];
      done: PromoteOutcome[];
    }
  | {
      kind: "failed";
      updateSet: ResolvedUpdateSet;
      error: string;
      done: PromoteOutcome[];
    }
  | { kind: "promoted"; outcomes: PromoteOutcome[] };

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function isAlreadyCommitted(params: {
  reader: SnReader;
  taskId: string;
  name: string;
}): Promise<boolean> {
  var rows = await params.reader.query({
    table: "sys_update_set",
    query: "name=" + params.name + "^state=complete",
    fields: ["sys_id", "name", "state"],
    limit: 1,
  });
  return rows.some(function (row) {
    var name = typeof row.name === "string" ? row.name : "";
    return (
      name === params.name &&
      nameMatchesTaskId({ name: name, taskId: params.taskId })
    );
  });
}

function buildComment(params: {
  status: string;
  target: string;
  outcomes: PromoteOutcome[];
}): string {
  var lines: string[] = [];
  lines.push("🚀 Promotion (" + params.status + " → " + params.target + ")");
  params.outcomes.forEach(function (o) {
    var verb = o.status === "promoted" ? "committed" : "already present";
    lines.push("• " + verb + ": " + o.updateSet.name);
  });
  return lines.join("\n");
}

export async function promoteForStatus(
  params: PromoteForStatusParams,
): Promise<PromoteForStatusResult> {
  var config = params.config;

  // 1. Validate the task id against the canonical pattern (untrusted webhook input).
  var pattern: RegExp;
  try {
    pattern = new RegExp(config.taskIdPattern);
  } catch (err) {
    return { kind: "invalid-task-id" };
  }
  if (!params.taskId || !pattern.test(params.taskId)) {
    return { kind: "invalid-task-id" };
  }

  // 2. Look up the rung for this status.
  var rung: PromotionRung | undefined = config.statusMap[params.status];
  if (!rung) {
    return {
      kind: "skipped",
      reason: "'" + params.status + "' is not a promotion status",
    };
  }
  if (rung.enabled !== true) {
    return {
      kind: "skipped",
      reason: "edge for '" + params.status + "' is disabled",
    };
  }

  // 3. Resolve the update set(s) on the source.
  var resolved = await resolveUpdateSets({
    reader: params.sourceReader,
    taskId: params.taskId,
    config: config,
  });
  if (resolved.kind === "not-found") {
    return { kind: "no-update-sets" };
  }
  if (resolved.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      scope: resolved.scope,
      candidates: resolved.candidates,
    };
  }

  var sourceInstance: PromotionInstanceRef =
    config.instances[rung.sourceInstance];
  var sourceRef =
    sourceInstance && sourceInstance.url
      ? sourceInstance.url
      : rung.sourceInstance;
  var allow = config.skipPreviewErrors || [];
  var outcomes: PromoteOutcome[] = [];

  // 4. Promote each set: idempotency → preview → gate → commit.
  var i;
  for (i = 0; i < resolved.updateSets.length; i = i + 1) {
    var set = resolved.updateSets[i];

    var already = await isAlreadyCommitted({
      reader: params.targetReader,
      taskId: params.taskId,
      name: set.name,
    });
    if (already) {
      outcomes.push({ updateSet: set, status: "already" });
      continue;
    }

    var preview: PromoteResult;
    try {
      preview = await params.promoter.promote({
        sourceInstance: sourceRef,
        updateSetName: set.name,
        commit: false,
        skipPreviewErrors: allow,
      });
    } catch (err) {
      return {
        kind: "failed",
        updateSet: set,
        error: errorMessage(err),
        done: outcomes,
      };
    }
    var blocking = preview.previewErrors.filter(function (e) {
      return allow.indexOf(e.type) === -1;
    });
    if (blocking.length > 0) {
      return {
        kind: "preview-blocked",
        updateSet: set,
        previewErrors: blocking,
        done: outcomes,
      };
    }

    var committed: PromoteResult;
    try {
      committed = await params.promoter.promote({
        sourceInstance: sourceRef,
        updateSetName: set.name,
        commit: true,
        skipPreviewErrors: allow,
      });
    } catch (err) {
      return {
        kind: "failed",
        updateSet: set,
        error: errorMessage(err),
        done: outcomes,
      };
    }
    outcomes.push({ updateSet: set, status: "promoted", result: committed });
  }

  // 5. Confirm on the ClickUp task.
  if (params.commenter) {
    await params.commenter.postComment({
      taskId: params.taskId,
      text: buildComment({
        status: params.status,
        target: rung.targetInstance,
        outcomes: outcomes,
      }),
    });
  }

  return { kind: "promoted", outcomes: outcomes };
}

/** The subset of PromotionInstance this module reads (url may be absent at runtime). */
interface PromotionInstanceRef {
  url: string | null;
}
