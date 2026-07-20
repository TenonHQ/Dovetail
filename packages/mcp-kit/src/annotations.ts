/**
 * MCP tool annotations (spec 2025-11-25) — untrusted behavioural hints that let
 * a host parallelize reads and gate writes. Never a security boundary. Six
 * presets cover every Dovetail tool's safety profile; each consumer imports the
 * ones it uses.
 *
 *   READ_ONLY                 — no writes; safe to auto-approve and run concurrently.
 *   WRITE_ADDITIVE_IDEMPOTENT — additive/recoverable write, safe to repeat (upsert, restore, link).
 *   WRITE_CREATE              — additive write, NOT idempotent (each call mints a new record).
 *   WRITE_OVERWRITE           — destructive but idempotent (prune/overwrite/delete: same end state).
 *   WRITE_EXECUTE             — destructive AND non-idempotent (runs an action; repeat repeats the effect).
 *   WRITE_DESTRUCTIVE         — irreversible hard-DELETE of schema (drop table/column), behind the S1
 *                               execution-context gate. A distinct named tier for reviewer/host legibility;
 *                               distinct from WRITE_OVERWRITE (which is destructive-but-idempotent).
 *
 * openWorldHint is intentionally left unset (spec default true) — Dovetail tools
 * reach an external service or spawn a process; a consumer documents any
 * local-only exception in its own registry.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type { ToolAnnotations };

export var READ_ONLY: ToolAnnotations = { readOnlyHint: true };

export var WRITE_ADDITIVE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true
};

export var WRITE_CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false
};

export var WRITE_OVERWRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true
};

export var WRITE_EXECUTE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false
};

// Reserved for the context-gated hard-DELETE of schema (drop table/column, RFC §7).
// The hint profile matches WRITE_EXECUTE — destructive and not something a host should
// silently retry — but the distinct NAME is the point: it marks the op as running behind
// the S1 execution-context gate, legibly separate from WRITE_OVERWRITE (destructive but
// idempotent: prune/soft-delete/overwrite).
export var WRITE_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false
};
