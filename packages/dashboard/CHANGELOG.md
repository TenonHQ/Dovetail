# Changelog — @tenonhq/dovetail-dashboard

## Unreleased — Phase E (claude-plans v2 bidirectional surfaces)

- **New dependency** `@tenonhq/dovetail-claude-plans` (workspace) — write routes call directly into the package's storage layer so the state machine, conflict rule, and dispatch-token lifecycle are enforced in exactly one place.
- **Three new POST routes** under `/api/claude-plans/:slug/`:
  - `answers` → `recordAnswer()`. Forces `answered_by: "dashboard"` by default.
  - `stage` → `setStage()`. Forces `source: "dashboard"` so the conflict rule (design doc §4) treats operator moves as authoritative.
  - `dispatch` → `dispatchStage()`. Pass-through; dashboard sends dry-run first, then confirm+token.
- **Typed error envelope** — every error response carries `{ error: <code>, name: <ClassName>, message }`. HTTP status reflects the failure mode: 400 (validation / no-token), 404 (plan-not-found), 409 (illegal transition / conflict), 410 (stale token), 424 (missing agent), 500 (spawn / internal).
- **Stage Map strip** on the plan detail page — 10 stage pills with current-stage highlight, click-to-set_stage, per-stage Dispatch (▶) button, and a ⚠ marker for stages whose agent hasn't shipped yet (test-first, test-reality).
- **Dispatch dialog** — opens on Dispatch click, POSTs dry-run first, renders the resolved command + cwd, then the operator confirms to fire a live dispatch (which consumes the cached `set_stage` token).
- **Questions & Answers tab** — lists `plan.questions`, lets the operator answer each one (free-form input + clickable suggested options); SSE plan upsert re-renders the tab automatically.
- **Per-plan token cache** — the most recent `set_stage` response is held client-side per plan so the Dispatch button has a token to consume. Cache is cleared on plan switch.
- **Rate limited** — all three new routes share `claudePlansLimiter` (60 req / 15 min / IP), same as the existing destructive delete route.
