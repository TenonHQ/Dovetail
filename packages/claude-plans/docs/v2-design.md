# claude-plans v2 — Design Document (Phase A)

> Status: **Design — STOPS here for Daniel's confirm before Phase B.**
> Scope: full v2 (six MCP tools, stage state machine, dashboard surfaces).
> Source brief: closed upstream operating-repo PR #159 + its plan file.

This document is the single design artifact for v2. Phases B–E reference it; any deviation requires an amendment PR against this file.

---

## 0. Reconciliation with the current code

Three of the six "new v2 tools" already exist in `src/registry.ts`: `push_question`, `record_answer`, `get_answers` (with `PlanQuestion` shape carrying `stage`, `answer`, `answered_at`, `answered_by`; storage helpers `pushQuestion` / `recordAnswer` / `getAnswers`; atomic write via tmp+rename). The genuine net-new MCP tools in v2 are:

- `set_stage` — record a stage transition; issues a one-time idempotency token.
- `pull_plan` — returns plan + artifacts + prompts + questions + stage + dispatch log in a single read.
- `dispatch_stage` — dry-run by default; live mode spawns a Claude Code subprocess targeting a stage of a plan, gated by token + `confirm: true`.

The existing dashboard package is `@tenonhq/dovetail-dashboard` shipped from `packages/dashboard/` (Express + vanilla HTML/JS + SSE via chokidar) — **not** Next.js. Phase E builds on that stack; no framework migration is in scope.

---

## 1. Storage schema diff

### 1.1 File on disk

Unchanged path: `~/.dovetail/claude-plans/<slug>.json` (override via `DOVE_CLAUDE_PLANS_DIR`). Atomic-write rule (tmp file + `fs.renameSync`) already lives in `atomicWriteJson()`; **v2 reuses it unchanged** and requires that any new helper (`setStage`, `consumeDispatchToken`, `appendDispatchLog`) also routes through it.

### 1.2 Additive fields on `ClaudePlan`

All new fields are optional with safe defaults. Records written before v2 (no `schema_version`) load successfully and are treated as `schema_version: 1`. The first v2 write upgrades them transparently (load → normalize → write).

```ts
interface ClaudePlanV2 extends ClaudePlan {
  schema_version?: 1 | 2; // absent ⇒ 1; v2 writes always set 2
  stage?: PipelineStage | null; // null until first set_stage
  stage_history?: StageTransition[]; // append-only; empty when omitted
  dispatch_token?: DispatchToken | null; // current outstanding token, or null
  dispatch_log?: DispatchEvent[]; // append-only; both dry-run and live events
}

type PipelineStage =
  | "research"
  | "pre-stage-improve"
  | "planning"
  | "post-plan-improve"
  | "test-first"
  | "code"
  | "per-step-review"
  | "architectural-review"
  | "test-reality"
  | "documentation";

interface StageTransition {
  from: PipelineStage | null;
  to: PipelineStage;
  at: string; // ISO 8601
  by: string; // session_id or operator label
  source: "code" | "dashboard"; // who initiated; feeds conflict resolution
}

interface DispatchToken {
  token: string; // tok_<24-hex>
  issued_for_stage: PipelineStage; // must match dispatch target
  issued_at: string; // ISO 8601
  expires_at: string; // issued_at + 5 min
  consumed_at?: string; // set when dispatch_stage consumes it
}

interface DispatchEvent {
  at: string;
  target_stage: PipelineStage;
  mode: "dry-run" | "live";
  by: string; // operator label
  command?: string; // resolved spawn command (recorded for both)
  cwd?: string; // resolved working dir
  outcome: "ok" | "missing-agent" | "stale-token" | "no-token" | "spawn-error";
  pid?: number; // live spawns only
  error?: string; // failure message (sanitized)
}
```

### 1.3 v1 → v2 load-time migration

Implemented in a new helper `migrateV1OnLoad(plan)` invoked by every loader (`readJson<ClaudePlan>` callsites). Rules:

1. If `plan.schema_version === 2` → return as-is.
2. Otherwise: set `schema_version = 2`; default `stage = null`, `stage_history = []`, `dispatch_token = null`, `dispatch_log = []` (only if absent — never overwrite). **No disk write here** — migration is materialized on the next `pushPlan` / `setStage` write that already touches the record. v1-only readers (e.g. legacy dashboards) keep working because every added field is optional.
3. v1 contract fixtures (§5) lock the pre-migration shape so we can prove no silent drift.

### 1.4 Concurrency

Storage is per-plan, single-file. Atomic rename guarantees no torn reads. v2 does **not** add cross-process locks; two simultaneous writers can race and last-write-wins (current documented behaviour). The state machine + idempotency token are how we keep `dispatch_stage` honest — the token is a logical lock, not a file lock.

---

## 2. New MCP tool signatures

JSDoc-style sketches. Final zod schemas land in Phase C/D.

### 2.1 `set_stage`

```ts
/**
 * Move a plan to a new pipeline stage. Validates the transition against the
 * state machine in §3. On success, atomically writes the new stage,
 * appends to stage_history, and ISSUES a one-time dispatch token bound to
 * the new stage with a 5-minute TTL.
 *
 * The returned token is the only way to subsequently call dispatch_stage in
 * live mode. Calling set_stage again rotates the token (the previous one is
 * invalidated).
 *
 * Conflict rule (§4) applies if a concurrent writer has already moved the
 * plan since the caller last read it.
 */
set_stage(input: {
  plan_slug: string;
  to: PipelineStage;
  by?: string;                 // defaults to CLAUDE_CODE_SESSION_ID
  source?: "code" | "dashboard"; // defaults to "code"
}): {
  plan_slug: string;
  stage: PipelineStage;
  token: DispatchToken;
  history_length: number;
}
```

Errors:

- `IllegalTransitionError` — `to` not in `LEGAL_TRANSITIONS[from]`.
- `PlanNotFoundError` — slug doesn't exist.

### 2.2 `pull_plan`

```ts
/**
 * Single-read snapshot of everything the dashboard or a resuming session
 * needs. Returns plan + artifacts + prompts + questions + stage state
 * (current stage, history) + dispatch_log. Equivalent to combining
 * get_plan + get_answers + the stage/dispatch fields but in one call so the
 * dashboard can render without three round-trips.
 */
pull_plan(input: {
  plan_slug: string;
}): {
  plan: ClaudePlanV2;
  artifacts: ClaudeArtifact[];
  prompts: ClaudePrompt[];
  questions: PlanQuestion[];
  stage: PipelineStage | null;
  stage_history: StageTransition[];
  dispatch_log: DispatchEvent[];
}
```

Errors: `PlanNotFoundError`.

### 2.3 `dispatch_stage`

```ts
/**
 * Resolve the Claude Code spawn command for a stage and, in live mode,
 * launch it. Default mode is dry-run: resolves command + cwd, appends a
 * dry-run DispatchEvent, returns the resolved shape, and exits without
 * spawning. Live mode requires:
 *   - confirm: true (explicit operator intent)
 *   - token equals plan.dispatch_token.token
 *   - token is unconsumed AND now <= expires_at
 *   - token.issued_for_stage === target_stage
 * On a successful live call, the token is consumed atomically before
 * spawn; a subsequent dispatch_stage with the same token returns
 * StaleTokenError.
 *
 * Stages "test-first" and "test-reality" require agents not yet shipped
 * (PR #160). Until that lands, dispatch_stage raises MissingAgentError
 * naming the absent agent (test-author / test-reality-checker) so the
 * operator sees the gap immediately — never silent no-op.
 */
dispatch_stage(input: {
  plan_slug: string;
  target_stage: PipelineStage;
  confirm?: boolean;  // default false ⇒ dry-run
  token?: string;     // required when confirm===true
  by?: string;
}): {
  mode: "dry-run" | "live";
  plan_slug: string;
  target_stage: PipelineStage;
  command: string;     // e.g. "claude-code --resume <slug> --stage <stage>"
  cwd: string;
  pid?: number;        // live mode only
  event: DispatchEvent; // the event appended to dispatch_log
}
```

Errors (each is its own typed class; see §6):

- `IllegalTransitionError` — `target_stage` not legal from current stage.
- `MissingAgentError` — target_stage in {test-first, test-reality} and the matching agent is absent.
- `NoTokenError` — `confirm: true` but no token provided.
- `StaleTokenError` — token expired, mismatched, or already consumed.
- `SpawnError` — live spawn failed (recorded with `outcome: "spawn-error"`).

### 2.4 Existing Q&A tools — Phase B audit

`push_question`, `record_answer`, `get_answers` keep their current signatures (v1 contract — see §5). Phase B work is limited to:

- Add `schema_version: 2` stamp on the plan record they write.
- Wire reads through `migrateV1OnLoad()` so a v1 record answered post-v2 upgrades cleanly.
- Add the missing test cases the prompt called out (concurrent question append race, stale-question answer guard returning `QuestionNotFoundError`, stage-scoped `get_answers` filter).

---

## 3. Pipeline stage state machine

### 3.1 The 10 stages

Ordered by intended forward flow (from brief PR #155 — the 13-agent pipeline collapsed to 10 surface stages). Each stage maps to one or more existing agents; stars mark net-new agents authored in sibling PR #160:

| #   | Stage                  | Agent / asset                                              |
| --- | ---------------------- | ---------------------------------------------------------- |
| 1   | `research`             | `idea-shaper`, `devils-advocate`                           |
| 2   | `pre-stage-improve`    | `improve-prompt` skill                                     |
| 3   | `planning`             | `push_plan` (this package)                                 |
| 4   | `post-plan-improve`    | `improve-prompt` skill (optional toggle)                   |
| 5   | `test-first`           | `test-author` ★ (PR #160 — until then `MissingAgentError`) |
| 6   | `code`                 | Ralph autonomous loop                                      |
| 7   | `per-step-review`      | `code-review`, `pr` skills                                 |
| 8   | `architectural-review` | `architecture-critic` agent                                |
| 9   | `test-reality`         | `test-reality-checker` ★ (PR #160)                         |
| 10  | `documentation`        | `docs` skill, `documentation-generator`                    |

### 3.2 Legal transitions

The state machine is deliberately permissive about backward moves (operators legitimately bounce back to `research` or `planning` after a failed review) but rejects skip-forward jumps that bypass mandatory gates.

```ts
const LEGAL_TRANSITIONS: Record<PipelineStage | "__START__", PipelineStage[]> =
  {
    __START__: ["research", "planning"],
    research: ["pre-stage-improve", "planning", "research"], // self = re-research
    "pre-stage-improve": ["planning", "research"],
    planning: ["post-plan-improve", "test-first", "research", "planning"],
    "post-plan-improve": ["test-first", "planning"],
    "test-first": ["code", "planning"], // back to planning if tests reveal a planning miss
    code: ["per-step-review", "test-first"], // back to tests if code drifted
    "per-step-review": ["code", "architectural-review"],
    "architectural-review": [
      "per-step-review",
      "test-reality",
      "documentation",
    ],
    "test-reality": ["documentation", "code"], // back to code if reality check fails
    documentation: ["documentation"], // terminal; self-loop allowed for re-docs
  };
```

**Rules:**

1. Initial transition (when `plan.stage == null`) draws from `__START__`.
2. Skip-forward beyond the immediate downstream set is illegal — e.g. `planning → architectural-review` is rejected. The operator must walk the steps (this is the whole point of the state machine; auto-skipping `test-first` is exactly what the brief flags as risky).
3. Self-loop is only legal where listed (`research`, `planning`, `documentation`). It exists so re-running a stage (e.g. re-shape the idea) is observable in `stage_history`.
4. Every transition appends to `stage_history` even when `from === to`.

### 3.3 Worked example

Plan starts at `null`. `set_stage(plan, to: "research")` → legal (in `__START__`). Plan now at `research`. `set_stage(plan, to: "test-first")` → **illegal** (not in `research`'s allowed list); raises `IllegalTransitionError("research -> test-first not allowed; legal: pre-stage-improve, planning, research")`. Operator instead moves through `pre-stage-improve → planning → test-first`, generating four `StageTransition` rows.

---

## 4. Conflict resolution (Q3 from brief)

When the same plan record is mutated by both the dispatched subprocess (writing as `source: "code"`) and the operator dashboard (writing as `source: "dashboard"`), whose move wins?

### 4.1 Options enumerated

**Option A — `dashboard-wins`.** Any dashboard-sourced write supersedes any code-sourced write on the same plan within the same wall-clock window. _Worked example:_ code writes `set_stage(to: code)` at T; dashboard writes `set_stage(to: planning)` at T+1s; resolved state is `planning`. _Strength:_ matches the operator-GUI vision — the human in front of the dashboard is the steering wheel. _Weakness:_ a dashboard left open by mistake can stomp legitimate forward progress from a long-running session.

**Option B — `code-wins`.** Mirror of A — code-sourced writes supersede dashboard ones. _Strength:_ protects long-running autonomous loops. _Weakness:_ if a dispatched subprocess is wedged or hallucinating, the operator can't override it from the dashboard — defeats the bidirectional purpose.

**Option C — `last-write-wins-with-timestamps`.** Whichever write has the later `at` timestamp wins, irrespective of source. _Worked example:_ same as A, `planning` wins because T+1s > T. _Strength:_ no source bias, deterministic, simplest implementation (no extra logic — atomic rename already does this). _Weakness:_ clock skew between processes; two writes 50ms apart can land in non-causal order on disk.

### 4.2 Choice — Option A (`dashboard-wins`)

**Rationale.** The whole point of v2 is that the dashboard is the operator's steering wheel for in-flight pipeline runs. Option C is tempting because it's free, but a dashboard click is an explicit human intent; a code write is a programmatic move that the human may or may not have approved. When the two collide, the human wins. Option B inverts this, which is wrong for a GUI surface; Option C silently lets clock skew decide, which makes the bug-class "operator click ignored" possible.

**Implementation.** A single helper `resolveConflict(currentOnDisk, incoming)` consumed by `set_stage`, `pull_plan` (read-time normalization), and `dispatch_stage` (re-checks before consuming a token). Pseudocode:

```ts
function resolveConflict(
  current: ClaudePlanV2,
  incoming: WriteIntent,
): "accept" | "reject" {
  if (!current.stage_history?.length) return "accept";
  const lastTransition =
    current.stage_history[current.stage_history.length - 1];
  // Dashboard-sourced incoming always wins.
  if (incoming.source === "dashboard") return "accept";
  // Code-sourced incoming is rejected if the last transition was dashboard-sourced
  // AND was made within the last 30 seconds (the "operator just touched this" window).
  const cutoff = Date.now() - 30_000;
  if (
    lastTransition.source === "dashboard" &&
    Date.parse(lastTransition.at) >= cutoff
  ) {
    return "reject"; // returns ConflictRejectedError to the caller
  }
  return "accept";
}
```

The 30-second window is the only knob; it can be tuned via `DOVE_CLAUDE_PLANS_DASHBOARD_GRACE_MS`. Test fixtures in §5 lock this behaviour with two cases (dashboard-stomp accepted; code-overwrite-recent-dashboard-click rejected).

### 4.3 `ConflictRejectedError`

A new typed error (alongside the others in §6). Carries the rejected `WriteIntent` and the winning `StageTransition` for debugging. Returned to the code-sourced caller; dashboard never sees it (dashboard always wins).

---

## 5. v1 contract fixtures

Committed under `packages/claude-plans/src/tests/fixtures/v1/` — one JSON file per preserved v1 tool. Each fixture is `{ tool, request, response, notes }` with deterministic timestamps (`2026-05-26T12:00:00.000Z`) and a fixed-seed slug, so a snapshot test can compare byte-for-byte without flakiness.

The snapshot test (added in Phase B; run by Phases C/D/E in CI) exercises each tool with the recorded `request` and asserts the response equals the recorded `response` modulo allowed normalization (timestamps via a freezer, slugs via a fixed `Math.random` seed, content hashes recomputed deterministically). A failure means a v1 consumer would see different output — block the PR.

### 5.1 Tools fixtured

| Tool                 | Fixture file              | Why it matters                                                                 |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `push_plan`          | `push_plan.json`          | Most-called write; locks plan record shape.                                    |
| `push_artifact`      | `push_artifact.json`      | Locks artifact record shape, including mermaid normalization.                  |
| `push_diagram`       | `push_diagram.json`       | Mermaid header + sequence-semicolon lint contract.                             |
| `push_prompt`        | `push_prompt.json`        | Prompt-tab record shape + score badges.                                        |
| `update_plan_status` | `update_plan_status.json` | DRAFT→APPROVED transition shape; rejects locked too.                           |
| `delete_plan`        | `delete_plan.json`        | `{deleted, slug}` response.                                                    |
| `get_plan`           | `get_plan.json`           | `PlanWithArtifacts` shape; the dashboard's primary read.                       |
| `list_recent_plans`  | `list_recent_plans.json`  | `{plans: ClaudePlan[]}` envelope + default-limit ordering.                     |
| `get_handoff_bundle` | `get_handoff_bundle.json` | Markdown serializer; downstream session-resume depends on this.                |
| `push_question`      | `push_question.json`      | v2 will add `schema_version`; this fixture proves response shape is unchanged. |
| `record_answer`      | `record_answer.json`      | Same.                                                                          |
| `get_answers`        | `get_answers.json`        | Same.                                                                          |

### 5.2 Fixture envelope

```json
{
  "tool": "push_plan",
  "request": { "title": "...", "content_md": "..." },
  "response": {
    "slug": "...",
    "title": "...",
    "status": "DRAFT",
    "...": "..."
  },
  "notes": "Plain text content_md, no PR fields, no linked_artifacts."
}
```

The snapshot test loads each `.json`, calls the tool through `buildDescriptors()` (the registry's entry point — same surface MCP clients use), and `deepEqual`s the response against the fixture's `response`. A small `normalizeForFixture` helper handles the timestamp-freezing and hash recomputation.

---

## 6. Typed errors

Phase A names the error classes so consumers (and the dashboard's UI hints in Phase E) can branch on them cleanly. Implementation lands in Phase C/D.

| Class                    | Where raised                  | HTTP-ish status |
| ------------------------ | ----------------------------- | --------------- |
| `PlanNotFoundError`      | every tool                    | 404             |
| `QuestionNotFoundError`  | `record_answer`               | 404             |
| `IllegalTransitionError` | `set_stage`, `dispatch_stage` | 409             |
| `ConflictRejectedError`  | `set_stage`                   | 409             |
| `MissingAgentError`      | `dispatch_stage` (stages 5/9) | 424             |
| `NoTokenError`           | `dispatch_stage` (live)       | 400             |
| `StaleTokenError`        | `dispatch_stage` (live)       | 410             |
| `SpawnError`             | `dispatch_stage` (live)       | 500             |

All extend a base `ClaudePlansError` carrying `code`, `message`, and a structured `details` object. The MCP server surfaces them as `tool_result` errors with the `code` in the body — no stack traces leaked.

---

## 7. `dispatch_stage` safety model

The riskiest surface in v2. Detailed below so the implementation in Phase D has zero ambiguity.

### 7.1 Command resolution

```ts
function resolveDispatchCommand(
  plan: ClaudePlanV2,
  stage: PipelineStage,
): {
  command: string;
  cwd: string;
} {
  // Working dir: the repo root recorded on the plan, falling back to a
  // configurable home (DOVE_CLAUDE_PLANS_DISPATCH_CWD), falling back to cwd.
  const cwd =
    plan.session_id /* future: map session_id -> repo */ ||
    process.env.DOVE_CLAUDE_PLANS_DISPATCH_CWD ||
    process.cwd();

  // Command: a single argv array we hand to spawn; never shell-interpolated.
  // The actual binary is `claude` (Claude Code CLI). We pass the plan slug
  // and target stage as flags; the agent layer reads them.
  const argv = [
    "claude",
    "--resume-plan",
    plan.slug,
    "--target-stage",
    stage,
    "--session-source",
    "dispatch",
  ];
  return { command: argv.join(" "), cwd };
}
```

The returned `command` string is for the dry-run display. The live spawn uses `argv` directly via `child_process.spawn(argv[0], argv.slice(1), { cwd, stdio: "inherit", detached: true })` — never `exec` / shell, so the resolved `plan.slug` (already slug-regex-constrained) can't be a shell-injection vector.

### 7.2 Dry-run output (the default)

```json
{
  "mode": "dry-run",
  "plan_slug": "my-plan",
  "target_stage": "test-first",
  "command": "claude --resume-plan my-plan --target-stage test-first --session-source dispatch",
  "cwd": "/path/to/Craftsman/Dovetail",
  "event": { "...": "the DispatchEvent appended to dispatch_log" }
}
```

Dry-run never spawns. It appends a `DispatchEvent` with `mode: "dry-run"` so the operator's first click leaves an audit trail. Token is NOT consumed on dry-run.

### 7.3 Live mode preconditions (ALL must hold)

1. `confirm === true`.
2. `token` provided.
3. `plan.dispatch_token != null` (set_stage was called to issue one).
4. `token === plan.dispatch_token.token`.
5. `plan.dispatch_token.consumed_at == null` (not already used).
6. `Date.now() <= Date.parse(plan.dispatch_token.expires_at)` (within 5-min TTL).
7. `plan.dispatch_token.issued_for_stage === target_stage` (can't re-use a token to dispatch to a different stage).
8. `target_stage` is not in {test-first, test-reality} **or** the matching agent exists on disk (`.claude/agents/test-author.md` etc.). When PR #160 lands, the existence check is what flips from raising `MissingAgentError` to allowing dispatch.

Token consumption is atomic: load the plan, set `consumed_at = nowIso()`, atomic write, **then** spawn. If the spawn fails after consumption, the token is still consumed — the operator must re-issue via `set_stage` (this is by design; we'd rather replay the stage move than risk a double-spawn).

### 7.4 Token lifecycle

- **Issued** by `set_stage` on every successful transition. Token format: `tok_<24-hex>` (96 bits of entropy from `crypto.randomBytes(12)`).
- **TTL** 5 minutes from issue. Configurable via `DOVE_CLAUDE_PLANS_TOKEN_TTL_MS`.
- **Bound** to `(plan_slug, issued_for_stage)`. A token from `set_stage(to: code)` cannot be used to `dispatch_stage(target: per-step-review)`.
- **Consumed** by exactly one successful `dispatch_stage(confirm: true)`. After consumption, the same token returns `StaleTokenError`.
- **Rotated** by any subsequent `set_stage` call — the previous outstanding token is overwritten in the plan record and becomes effectively stale on next check.
- **Single outstanding** per plan. If a stage move is rolled back (illegal transition rejected before write), no token is issued.

### 7.5 Out-of-scope (open risks acknowledged)

Lifted from PR #159's supporting doc — explicitly NOT covered by v2:

- Concurrent-dispatch detection (two operators clicking Dispatch on different machines within the TTL window) — current behaviour: first one to consume the token wins, second sees `StaleTokenError`. Acceptable.
- Crashed-subprocess detection — if the spawned `claude` dies mid-stage, the plan's stage stays where it was set; no cleanup loop. Deferred.
- Cross-machine dispatch — `cwd` is local. Deferred until claude-plans gains a remote-share story.
- Test-reality-checker hallucination policy (brief Q2) — agent doesn't exist yet; `MissingAgentError` until it does.

---

## 8. Phase order recap (for the PR description)

| Phase | Deliverable                                                         | Gates                   |
| ----- | ------------------------------------------------------------------- | ----------------------- |
| A     | This doc + `src/tests/fixtures/v1/*.json`                           | STOP for Daniel confirm |
| B     | Q&A audit + `schema_version` + `migrateV1OnLoad()` + missing tests  | Phase A merged          |
| C     | `set_stage`, `pull_plan` + state-machine helper + token issuance    | Phase B merged          |
| D     | `dispatch_stage` with dry-run/confirm/token consume + missing-agent | Phase C merged          |
| E     | Dashboard surfaces (Questions tab, Stage Map, per-stage Dispatch)   | Phases B+C+D all merged |

Each phase is its own Draft PR (auto-publishes packages on merge — see `Dovetail/CLAUDE.md` §Releasing).

---

_Last updated: 2026-05-26 — design only; no implementation yet._
