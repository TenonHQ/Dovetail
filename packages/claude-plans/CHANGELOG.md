# Changelog — @tenonhq/dovetail-claude-plans

## v2 — bidirectional pipeline (PRs #100–#104)

The v2 line turns the package from a write-only plan surface into a **bidirectional pipeline**: a plan now carries an explicit pipeline stage that both Claude Code and the dashboard can move, with a token-gated path to spawning the next session. Delivered across PRs #100–#104 (Phases A–D below), strictly additive over v1.

**New plan fields** (all optional; defaulted on read so v1 records keep working): `schema_version` (`CURRENT_SCHEMA_VERSION = 2`), `stage`, `stage_history`, `dispatch_token`, `dispatch_log`.

**New MCP tools (3), bringing the total to 17:**

- `set_stage` — advance a plan through the 10-stage state machine. Validates the transition (`IllegalTransitionError`), applies the dashboard-wins conflict rule (`ConflictRejectedError`, 30s grace), atomically writes the new stage + appends a `StageTransition`, and issues a **one-time dispatch token** (5-min TTL) bound to the target stage. Each call rotates the token.
- `pull_plan` — single-read snapshot returning `{ plan, artifacts[], prompts[], questions[], stage, stage_history[], dispatch_log[] }` so the dashboard's plan-detail page renders without multiple round-trips.
- `dispatch_stage` — resolve and optionally spawn a Claude Code subprocess for a stage. **Dry-run by default** (logs a `dry-run` event, spawns nothing, does not consume the token); **live mode** requires `confirm: true` + a valid token, consumed **atomically before** the spawn. Gated stages (`test-first`, `test-reality`) raise `MissingAgentError` rather than no-op.

**New modules:** `src/state-machine.ts` (legal-transition table, `assertTransition`, `checkConflict`) and `src/dispatch.ts` (error taxonomy, token validation, command resolution, injectable spawn).

**New env vars:** `DOVE_CLAUDE_PLANS_TOKEN_TTL_MS`, `DOVE_CLAUDE_PLANS_DASHBOARD_GRACE_MS`, `DOVE_CLAUDE_PLANS_DISPATCH_CWD`.

**Backward compatibility:** `migrateV1OnLoad()` normalizes v1 records on read (no disk write until next mutation); `src/tests/v1-contract.test.ts` replays every `src/tests/fixtures/v1/*.json` fixture through the live registry against a frozen clock to lock each v1 tool's response shape. Deep dive: [`docs/v2-implementation.md`](./docs/v2-implementation.md).

---

## Unreleased — Phase D (dispatch_stage)

- New module `src/dispatch.ts`:
  - Error classes: `MissingAgentError`, `NoTokenError`, `StaleTokenError`, `SpawnError`.
  - `KNOWN_MISSING_AGENTS` constant gating stages `test-first` (test-author) and `test-reality` (test-reality-checker) — clear an entry when the agent ships (PR #160).
  - `resolveDispatchCommand(plan, stage)` — argv builder (no shell interpolation surface). `DOVE_CLAUDE_PLANS_DISPATCH_CWD` overrides the working dir.
  - `validateToken()` — pure helper running all 5 token preconditions from design doc §7.3.
  - `productionSpawn` — detached + stdio-inherited `child_process.spawn`. Injectable for tests via `dispatchStage`'s `spawn` option.
- New storage helper `dispatchStage()`:
  - Default mode is dry-run: appends `mode: "dry-run"` `DispatchEvent` to `dispatch_log`, returns without spawning, **does not consume the token**.
  - Live mode (`confirm: true`) consumes the plan's outstanding `dispatch_token` **atomically before spawn** — a crashed/leaked subprocess never invalidates the single-use guarantee. Logs a `spawn-error` event when the spawn primitive throws and rethrows.
  - Stages 5/9 raise `MissingAgentError` before any I/O — never silent no-op.
  - Failed token validation appends a `no-token` / `stale-token` event to `dispatch_log` so the dashboard sees the failed attempt.
- New MCP tool `dispatch_stage` registered. `TOOL_NAMES.length` is now 15.
- New `dispatch_stage` zod schema (`DISPATCH_TOKEN_PATTERN = /^tok_[0-9a-f]{24}$/`).
- 20+ new tests covering: dry-run behavior, `MissingAgentError` for stages 5/9 (and no-disk-write on raise), every live-mode rejection mode (no token, mismatch, wrong stage, expired, consumed), successful live spawn (token consumed, argv recorded, pid in log), atomic consume-before-spawn (spawn crash leaves token consumed), `validateToken` and `resolveDispatchCommand` pure-unit cases.

## Unreleased — Phase C (state machine + set_stage + pull_plan)

- New types: `PipelineStage` (10-stage enum), `StageTransition`, `DispatchToken`, `DispatchEvent`, `StageTransitionSource`. Added to `ClaudePlan` as optional fields (`stage`, `stage_history`, `dispatch_token`, `dispatch_log`).
- New module `src/state-machine.ts`: `LEGAL_TRANSITIONS` table, `legalNextStages()`, `assertTransition()` raising `IllegalTransitionError`, `checkConflict()` raising `ConflictRejectedError`. Dashboard-wins conflict rule with 30s grace (configurable via `DOVE_CLAUDE_PLANS_DASHBOARD_GRACE_MS`).
- New storage helper `setStage()` — validates, applies conflict resolution, atomically writes stage + appends `StageTransition`, issues a `DispatchToken` (5-min TTL, configurable via `DOVE_CLAUDE_PLANS_TOKEN_TTL_MS`).
- New storage helper `loadPlanFull()` — single-read snapshot returning plan + artifacts + prompts + questions + stage + history + dispatch_log. Safe defaults for v1 records.
- New MCP tools `set_stage` and `pull_plan` registered (14 tools total now).
- `pushPlan` preserves stage state (`stage`, `stage_history`, `dispatch_token`, `dispatch_log`) across content updates — only `setStage` is allowed to mutate stage data.
- 59 new tests: full legal-transition matrix coverage, 12 representative illegal transitions, full conflict-resolution coverage (dashboard-wins, grace window, override), `setStage` integration (token rotation, TTL override, illegal-transition no-write, pushPlan preservation), `loadPlanFull` (v1 default behavior, missing slug).

## Unreleased — Phase B (v2 schema_version + migration)

- Add `schema_version` field to `ClaudePlan` (`1 | 2`, optional on the type — `CURRENT_SCHEMA_VERSION = 2`).
- Add `migrateV1OnLoad(plan)` in-memory normalizer; every plan read now passes through it. Idempotent on v2 records; v1 records gain `schema_version: 2` at read time and persist on the next write.
- Wire all `ClaudePlan` reads in `storage.ts` through the new `readPlan()` helper (was inline `readJson<ClaudePlan>`).
- Stamp `schema_version = 2` on every plan write: `pushPlan`, `updatePlanStatus`, `pushQuestion`, `recordAnswer`.
- `pushPlan` now preserves `existing.questions` across updates (previously wiped on second push — needed so the v1→v2 upgrade write doesn't lose Q&A data).
- Add `src/tests/v1-contract.test.ts` — exercises every fixture in `src/tests/fixtures/v1/*.json` through the live registry against a frozen clock + deterministic id generator + cleared `CLAUDE_CODE_SESSION_ID`. Any drift in a v1 tool's response shape fails the suite.
- Add Q&A audit tests (Phase A design §2.4): stale-question-answer guard, stage-scoped `get_answers` filter, last-write-wins regression guard on simulated concurrent `push_question`.
- Update v1 fixtures to add `schema_version: 2` and drop now-absent `content_html: null`. `list_recent_plans` fixture reduced to one record (frozen-clock can't tell two same-timestamp records apart deterministically).
