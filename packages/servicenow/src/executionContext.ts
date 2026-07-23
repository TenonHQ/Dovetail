/**
 * S1 — Execution-context detection + two-phase gate (schema-CRUD RFC §7).
 *
 * The reusable gate every schema-mutating verb runs through before it writes. It
 * answers one question, given HOW the command was invoked:
 *
 *   - Local / interactive  → two-phase. A schema mutation writes only on explicit
 *     confirmation, after the caller has seen the dry-run plan.
 *   - Automation / CI       → a DESTRUCTIVE change is allowed only if it arrived
 *     through a merged pull request: the workflow passes a merge ref AND proof the
 *     change is present in that merged diff. Missing either → refuse. This is the
 *     §7.1 rule: an unattended run may not ORIGINATE a destructive schema change.
 *
 * This is NOT a security boundary — a caller can construct any input it likes. It is
 * a guard rail that makes the safe path the default and the dangerous path explicit,
 * legibly, in one place instead of re-derived per verb. It FAILS CLOSED: when the
 * context is ambiguous it resolves to `local` (confirm-required), and an automation
 * destructive write with no valid merge signal is refused (RFC R4 — the gate is only
 * as good as the signal the workflow passes, so absence or falsity both refuse).
 *
 * ES6 only; no optional chaining. Pure logic — no ServiceNow I/O — so it is unit
 * tested exhaustively and carries no live-instance risk.
 */

export type ExecutionContext = "local" | "automation";

export interface ResolveContextInput {
  /** Explicit override (e.g. from a `--context` flag). Wins over auto-detection. */
  override?: string;
  /**
   * Environment to read the CI signal from. Injected for tests; defaults to
   * process.env. Kept explicit so detection is deterministic and testable.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Whether we appear to be running in a CI/automation environment. Reads the standard
 * signals — GitHub Actions sets GITHUB_ACTIONS=true; CI=true is the generic marker
 * most runners set. Necessary but NOT sufficient to allow a destructive write: "ran
 * in CI" ≠ "came from a merged PR" (that is the merge-signal check in the gate).
 */
export function isCiEnvironment(
  env: Record<string, string | undefined>,
): boolean {
  return env.GITHUB_ACTIONS === "true" || env.CI === "true" || env.CI === "1";
}

/**
 * Resolve local-vs-automation. An explicit override always wins (and an override that
 * is neither 'local' nor 'automation' is a hard error, not a silent fallback). With
 * no override, auto-detect CI; default to `local` — the safer, confirm-required
 * branch — when there is no CI signal.
 */
export function resolveExecutionContext(
  input: ResolveContextInput = {},
): ExecutionContext {
  var override = input.override
    ? String(input.override).trim().toLowerCase()
    : "";
  if (override === "local" || override === "automation") {
    return override;
  }
  if (override) {
    throw new Error(
      "context must be 'local' or 'automation', got '" + input.override + "'.",
    );
  }
  var env = input.env || process.env;
  return isCiEnvironment(env) ? "automation" : "local";
}

/**
 * The merged-PR signal an automation workflow passes for a destructive change.
 *
 * `changePresent` is the load-bearing field: the workflow is responsible for proving
 * the destructive change is actually in the diff at `mergeRef`, and the gate fails
 * closed unless it is explicitly true. Passing a ref alone is not enough — that would
 * let any CI run assert "a PR merged somewhere", which is exactly the loophole §7.1
 * closes.
 */
export interface MergeSignal {
  /** The merge commit SHA or PR ref the automation ran from. */
  mergeRef: string;
  /** Proof the destructive change is present in the diff at `mergeRef`. */
  changePresent: boolean;
}

export interface WriteGateInput {
  context: ExecutionContext;
  /** True for a WRITE_DESTRUCTIVE operation (drop table/column). */
  destructive: boolean;
  /** Local: explicit confirmation that the dry-run plan was reviewed and accepted. */
  confirmed?: boolean;
  /** Automation: the merged-PR signal, required for a destructive change. */
  mergeSignal?: MergeSignal;
}

export interface GateDecision {
  allowed: boolean;
  /** Why the write was refused, and what to do — empty string when allowed. */
  reason: string;
}

/**
 * Decide whether a schema write may proceed. Returns a decision rather than throwing,
 * so a verb can fold `reason` into its own structured result; `assertWriteAllowed` is
 * the throwing wrapper for callers that prefer to abort.
 */
export function evaluateWriteGate(input: WriteGateInput): GateDecision {
  if (input.context === "local") {
    // Every schema mutation is two-phase locally — destructive or not.
    if (!input.confirmed) {
      return {
        allowed: false,
        reason:
          "Local schema writes are two-phase: review the dry-run plan, then re-run " +
          "with confirmation. Nothing was written.",
      };
    }
    return { allowed: true, reason: "" };
  }

  // Automation. A non-destructive write may run unattended; a destructive one may not
  // ORIGINATE here — it must have arrived through a merged PR.
  if (!input.destructive) {
    return { allowed: true, reason: "" };
  }
  if (!input.mergeSignal || !input.mergeSignal.mergeRef) {
    return {
      allowed: false,
      reason:
        "Automation refuses a destructive schema change without a merged-PR signal " +
        "— an unattended run may not originate one (fail closed).",
    };
  }
  if (!input.mergeSignal.changePresent) {
    return {
      allowed: false,
      reason:
        "The destructive change is not present in the merged diff '" +
        input.mergeSignal.mergeRef +
        "' — refusing (fail closed).",
    };
  }
  return { allowed: true, reason: "" };
}

/** Throwing wrapper around evaluateWriteGate for verbs that prefer to abort on refusal. */
export function assertWriteAllowed(input: WriteGateInput): void {
  var decision = evaluateWriteGate(input);
  if (!decision.allowed) {
    // No verb prefix — the reason is self-contained, and this gate is shared by every
    // schema verb (remove-field/remove-table/…), none of which owns the message.
    throw new Error(decision.reason);
  }
}
