# Changelog — @tenonhq/dovetail-claude-plans

## Unreleased — Phase B (v2 schema_version + migration)

- Add `schema_version` field to `ClaudePlan` (`1 | 2`, optional on the type — `CURRENT_SCHEMA_VERSION = 2`).
- Add `migrateV1OnLoad(plan)` in-memory normalizer; every plan read now passes through it. Idempotent on v2 records; v1 records gain `schema_version: 2` at read time and persist on the next write.
- Wire all `ClaudePlan` reads in `storage.ts` through the new `readPlan()` helper (was inline `readJson<ClaudePlan>`).
- Stamp `schema_version = 2` on every plan write: `pushPlan`, `updatePlanStatus`, `pushQuestion`, `recordAnswer`.
- `pushPlan` now preserves `existing.questions` across updates (previously wiped on second push — needed so the v1→v2 upgrade write doesn't lose Q&A data).
- Add `src/tests/v1-contract.test.ts` — exercises every fixture in `src/tests/fixtures/v1/*.json` through the live registry against a frozen clock + deterministic id generator + cleared `CLAUDE_CODE_SESSION_ID`. Any drift in a v1 tool's response shape fails the suite.
- Add Q&A audit tests (Phase A design §2.4): stale-question-answer guard, stage-scoped `get_answers` filter, last-write-wins regression guard on simulated concurrent `push_question`.
- Update v1 fixtures to add `schema_version: 2` and drop now-absent `content_html: null`. `list_recent_plans` fixture reduced to one record (frozen-clock can't tell two same-timestamp records apart deterministically).
