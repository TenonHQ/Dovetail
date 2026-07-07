/**
 * @tenonhq/dovetail-deploy — type definitions.
 *
 * The package is transport-agnostic: it depends only on the small port
 * interfaces below (SnReader, Promoter, Commenter). The real
 * @tenonhq/dovetail-{servicenow,sawmill,clickup} clients are adapted to these
 * ports at the call site (the GitHub Action entry), keeping `sawmill` pure
 * transport and this package unit-testable with plain fakes.
 */

/** Promotion transport for an edge. Only "sawmill" is implemented today. */
export type Transport = "sawmill" | "company-repo" | "manual";

/** One instance on the ladder. `url: null` means not yet provisioned. */
export interface PromotionInstance {
  /** Bare subdomain, host, or full URL; null until the instance is provisioned. */
  url: string | null;
  /** GitHub Environment that holds this instance's credentials. */
  environment: string;
  /** Whether this instance is credentialed and usable. */
  enabled: boolean;
  /** Optional human role note (e.g. "dev-authoring"). */
  role?: string;
  /** Free-text provisioning to-do; present while the instance is not ready. */
  todo?: string;
}

/** One promotion edge, triggered by a ClickUp status. */
export interface PromotionRung {
  /** Stable ClickUp status id — the webhook payload match key. */
  clickupStatusId: string;
  /** Instance key the update set is promoted FROM. */
  sourceInstance: string;
  /** Instance key the update set is promoted TO. */
  targetInstance: string;
  transport: Transport;
  /** Whether this edge is live. A disabled edge is skipped, never an error. */
  enabled: boolean;
}

/** The canonical promotion ladder — the `promotion` block of automation-config.json. */
export interface PromotionLadder {
  /** Must equal branching.taskIdPattern in automation-config.json. */
  taskIdPattern: string;
  /** Scripted-REST promote path on the target; passed through to the transport. */
  promotePath?: string;
  /** Instance registry, keyed by instance name. */
  instances: Record<string, PromotionInstance>;
  /** Promotion edges, keyed by ClickUp status NAME. */
  statusMap: Record<string, PromotionRung>;
  /** Preview-error types allowed through the commit gate. */
  skipPreviewErrors?: string[];
}

/** One resolved update set on the source instance. */
export interface ResolvedUpdateSet {
  sysId: string;
  name: string;
  /** sys_scope sys_id of the update set's application. */
  scope: string;
}

/** A transport preview error (mirrors @tenonhq/dovetail-sawmill PreviewError). */
export interface PreviewError {
  type: string;
  message: string;
  targetTable?: string;
  targetName?: string;
  sysId?: string;
}

/** The result of one promote call (mirrors sawmill PromoteResponse). */
export interface PromoteResult {
  remoteUpdateSetSysId: string;
  previewErrors: PreviewError[];
  committed: boolean;
  elapsedMs: number;
}

/**
 * Port: read rows from a ServiceNow instance.
 * Adapt with `@tenonhq/dovetail-servicenow` — `client.table.query`.
 */
export interface SnReader {
  query(params: {
    table: string;
    query: string;
    fields?: string[];
    limit?: number;
  }): Promise<Array<Record<string, unknown>>>;
}

/**
 * Port: promote one update set across instances.
 * Adapt with `@tenonhq/dovetail-sawmill` — `createSawmillApi(target).promote`.
 */
export interface Promoter {
  promote(params: {
    sourceInstance: string;
    updateSetName: string;
    commit: boolean;
    skipPreviewErrors?: string[];
  }): Promise<PromoteResult>;
}

/**
 * Port: post a comment to a ClickUp task.
 * Adapt with `@tenonhq/dovetail-clickup` — `addComment`.
 */
export interface Commenter {
  postComment(params: { taskId: string; text: string }): Promise<void>;
}
