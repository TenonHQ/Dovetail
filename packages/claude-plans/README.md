# @tenonhq/dovetail-claude-plans

An **MCP server + storage library** that surfaces a Claude Code session's plan — and, as of v2, its full pipeline state — in the Dovetail dashboard at `/claude-plans`. A Claude Code session pushes a plan (and optional artifacts, prompts, questions, and stage transitions) over MCP stdio; records land as atomic JSON files under `~/.dovetail/claude-plans/`; the dashboard watches that directory and renders everything live (markdown via marked, diagrams via mermaid.js). A small CLI ships alongside for listing, exiting, and running the server.

---

## Install / build / test

Part of the Dovetail npm-workspaces monorepo. Requires **Node 22+**.

```bash
npm i -D @tenonhq/dovetail-claude-plans      # consumers
```

The operating repo's `.mcp.json` already wires the server in via `npx -y @tenonhq/dovetail-claude-plans mcp`.

Local development inside the monorepo:

```bash
npm test          # jest (unit + v1-contract suites)
npm run prepack   # tsc — compiles src/ → dist/
```

The package publishes the **built `dist/`** only (`"files": ["dist"]`, `"main": "./dist/index.js"`); `prepack` runs `tsc` so a publish always ships fresh compiled output. The CLI entry point is `dove-claude-plans` (`bin` → `dist/cli.js`).

---

## Storage model

Records are plain JSON files under a single root directory:

```
~/.dovetail/claude-plans/                    # override with DOVE_CLAUDE_PLANS_DIR
├── <plan-slug>.json                         # the plan record
├── <plan-slug>/
│   ├── artifacts/<artifact-slug>.json       # markdown / mermaid / prompt-cycle
│   └── prompts/<prompt-slug>.json           # rewritten prompts (push_prompt)
└── _lint-events/<event-id>.json             # global, plan-independent lint events
```

- **Atomic writes.** Every write goes to a `.tmp.<pid>.<rand>` file and is `rename`d into place, so the dashboard's chokidar watcher never observes a torn file.
- **`schema_version`.** Plan records carry `schema_version` (`CURRENT_SCHEMA_VERSION = 2`).
- **v1 → v2 migration on read.** Every plan read passes through `migrateV1OnLoad()`, which stamps `schema_version: 2` and defaults the v2 fields in memory. It is idempotent on v2 records and **does not write to disk** — the upgrade materializes on the next write (`push_plan` / `update_plan_status` / `push_question` / `record_answer` / `set_stage`). v1 records therefore keep round-tripping through every v1 tool unchanged.

---

## MCP tool reference

17 tools total. Inputs below are the authoritative zod fields; required fields are marked `(req)`.

### Plan CRUD

| Tool | Purpose | Key inputs |
|---|---|---|
| `push_plan` | Create or update a plan (auto-slugs from `title`; status defaults to `DRAFT`). Returns the plan plus a dashboard `url`. | `title (req)`, exactly one of `content_md` / `content_html` / `content_structured`, `slug`, `status`, `pr_number`/`pr_url`/`pr_title`, `linked_artifacts[]`, `categories[]` |
| `update_plan_status` | Transition status. Legal: `DRAFT→APPROVED`, `DRAFT→EXITED`, `APPROVED→EXITED`. Reverses/skips rejected. | `slug (req)`, `to (req)` |
| `get_plan` | Return one plan with its nested artifacts. | `slug (req)` |
| `list_recent_plans` | List plans newest-first. | `status`, `limit` (default 20) |
| `delete_plan` | Permanently delete a plan and all its artifacts. | `slug (req)` |
| `get_handoff_bundle` | Compose one paste-ready Markdown payload to resume a plan in a fresh session; hoists the newest rewritten prompt into a `READY-TO-PASTE PROMPT` section. | `slug (req)`, `follow_links` (default false), `include_artifact_kinds[]` |

### Artifacts / Prompts

| Tool | Purpose | Key inputs |
|---|---|---|
| `push_artifact` | Attach an artifact (`kind: markdown \| mermaid \| prompt-cycle`) to a plan. Mermaid sources are header-validated. | `plan_slug (req)`, `kind (req)`, `title (req)`, `content (req)`, `slug` |
| `push_diagram` | Convenience wrapper around `push_artifact` for Mermaid. Validates the source begins with a recognized diagram header. | `plan_slug (req)`, `title (req)`, `mermaid_source (req)`, `slug` |
| `push_prompt` | Attach a rewritten prompt (e.g. from `/improve-prompt`). Surfaces on the dashboard's Prompt tab and feeds `get_handoff_bundle`. | `plan_slug (req)`, `title (req)`, `content (req)`, `slug`, `source_draft`, `score_before`, `score_after` |

### Q&A

| Tool | Purpose | Key inputs |
|---|---|---|
| `push_question` | Park a question on a plan; returns a `PlanQuestion` with assigned id (`q_<8-hex>`). | `plan_slug (req)`, `question (req)`, `header`, `options[]`, `stage`, `asked_by` |
| `record_answer` | Record/overwrite an answer to an existing question (last-write-wins). | `plan_slug (req)`, `question_id (req, q_<8-hex>)`, `answer (req)`, `answered_by` |
| `get_answers` | List a plan's Q&A entries. | `plan_slug (req)`, `answered` (true/false filter), `stage` (exact match) |

### Prompt-lint

Lint events are **not owned by a plan** — they capture Turn-0 checklist scores for arbitrary prompts (typically from the `UserPromptSubmit` hook) and surface on the standalone `/prompt-lints` page.

| Tool | Purpose | Key inputs |
|---|---|---|
| `push_lint_event` | Record a prompt-lint observation in the global store (`<root>/_lint-events/<id>.json`). | `score (req, 0-100)`, `missing[]`, `antipatterns[]`, `ceremony[]`, `threshold`, `prompt_excerpt`, `source`, `session_id`, `plan_slug` |
| `get_lint_events` | List lint events newest-first. | `session_id`, `plan_slug`, `limit` |

### v2 Pipeline (new)

The three tools that drive the bidirectional v2 pipeline. They build on the v2 plan fields `stage`, `stage_history`, `dispatch_token`, and `dispatch_log`.

#### `set_stage`

Move a plan to a new pipeline stage. Validates the transition against the v2 state machine (`src/state-machine.ts`) and **issues a one-time dispatch token** bound to the new stage (5-minute TTL). Each call rotates the token — the previous outstanding token is overwritten and becomes stale.

- **Inputs:** `plan_slug (req)`, `to (req)` — one of the 10 `PipelineStage` values, `by` (defaults to `CLAUDE_CODE_SESSION_ID`), `source` — `code` (default) or `dashboard`.
- **Output:** `{ plan_slug, stage, token: DispatchToken, history_length }`.
- **Notable errors:** `IllegalTransitionError` (move not reachable from the current stage; the error lists the legal next stages); `ConflictRejectedError` (a `code`-sourced write when the last recorded transition was `dashboard`-sourced and within the 30-second grace window — see `DOVE_CLAUDE_PLANS_DASHBOARD_GRACE_MS`). Dashboard-sourced writes always win.

#### `pull_plan`

Single-read snapshot of a plan and all its v2 surface, so the dashboard's plan-detail page renders without three round-trips.

- **Inputs:** `plan_slug (req)`.
- **Output:** `{ plan, artifacts[], prompts[], questions[], stage, stage_history[], dispatch_log[] }`.
- **Notable errors:** plan-not-found (404-equivalent `PlanNotFoundError`) when the slug does not exist.

#### `dispatch_stage`

Resolve (and optionally spawn) a Claude Code subprocess to drive a plan at a given stage. **The riskiest v2 tool** — see [`docs/v2-implementation.md`](./docs/v2-implementation.md).

- **Modes:** *dry-run* (default) resolves the spawn command + working dir, appends a `dry-run` `DispatchEvent` to `dispatch_log`, and returns — **no process is launched, and the token is not consumed**. *Live* (`confirm: true` + valid `token`) consumes the plan's outstanding token **atomically before** spawning, so a crashed/leaked subprocess never breaks the single-use guarantee.
- **Inputs:** `plan_slug (req)`, `target_stage (req)`, `confirm` (default false), `token` (required when `confirm === true`; format `tok_<24-hex>`), `by`.
- **Output:** `{ mode, plan_slug, target_stage, command, cwd, pid?, event }`.
- **Notable errors:** `MissingAgentError` — `target_stage` `test-first` and `test-reality` are gated until the `test-author` / `test-reality-checker` agents ship (never a silent no-op); `NoTokenError` (no/missing token in live mode); `StaleTokenError` (token mismatch, already consumed, expired, or issued for a different stage); `SpawnError` (the spawn primitive failed to launch).

---

## v2 pipeline — quick mental model

The three pipeline tools form a deliberate, token-gated loop:

1. **`set_stage`** advances the plan through the 10-stage state machine and hands back a **one-time dispatch token** (5-minute TTL). The token is the *only* way to drive a live spawn, and it is rotated on every `set_stage`.
2. **`pull_plan`** is the **single-read snapshot** — the canonical way to read a plan's whole v2 surface in one call.
3. **`dispatch_stage`** is **dry-run by default**. A live subprocess spawn requires `confirm: true` **and** the current token; the token is consumed atomically before the spawn.

The 10 stages: `research → pre-stage-improve → planning → post-plan-improve → test-first → code → per-step-review → architectural-review → test-reality → documentation` (transitions enforced by `state-machine.ts`, not free movement).

For the full design — state-machine table, conflict resolution, dispatch safety preconditions — see [`docs/v2-implementation.md`](./docs/v2-implementation.md).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DOVE_CLAUDE_PLANS_DIR` | `~/.dovetail/claude-plans` | Storage root for all plan/artifact/prompt/lint JSON. |
| `DOVE_CLAUDE_PLANS_TOKEN_TTL_MS` | `300000` (5 min) | Lifetime of the dispatch token issued by `set_stage`. |
| `DOVE_CLAUDE_PLANS_DASHBOARD_GRACE_MS` | `30000` (30 s) | Grace window for the dashboard-wins conflict rule in `set_stage`. |
| `DOVE_CLAUDE_PLANS_DISPATCH_CWD` | `process.cwd()` | Working directory `dispatch_stage` resolves for the spawned subprocess. |
| `CLAUDE_PLANS_DASHBOARD_URL` | `http://localhost:3456` | Base URL used to build the dashboard deep-link returned by `push_plan`. |
| `CLAUDE_CODE_SESSION_ID` | — | When set, auto-populates `session_id` / `by` / `asked_by` defaults. |

---

## CLI

```bash
dove-claude-plans list                 # all plans, newest first
dove-claude-plans list --status DRAFT
dove-claude-plans exit <slug>          # flip to EXITED
dove-claude-plans exit-stale           # flip every DRAFT to EXITED (Claude Stop hook)
dove-claude-plans recategorize [--dry] # re-extract topic categories on every plan
dove-claude-plans where                # print storage root
dove-claude-plans mcp                  # stdio MCP server (used by .mcp.json)
dove-claude-plans mcp --smoke          # list registered tools and exit (CI verification)
```

---

## `content_structured` — component library

`push_plan` accepts exactly one of `content_md` (Markdown), `content_html` (HTML, DOMPurify-sanitized), or `content_structured` (recommended). Pass a `{ sections: [...] }` object and the server renders it to HTML using the dashboard's component CSS — no HTML/CSS knowledge required.

```json
{
  "sections": [
    { "type": "header", "title": "Deploy PR #42", "subtitle": "feature/auth → PROD" },
    { "type": "meta", "rows": [
      { "label": "Status", "value": "Approved", "badge": "success" }
    ]},
    { "type": "steps", "steps": [
      { "label": "DEV",  "status": "done" },
      { "label": "TEST", "status": "active" },
      { "label": "PROD", "status": "pending" }
    ]},
    { "type": "checklist", "title": "Pre-deploy", "items": [
      { "label": "Tests pass", "done": true },
      { "label": "Migration run", "done": false }
    ]}
  ]
}
```

**Section types:**

| Type | Required fields | Optional fields |
|---|---|---|
| `header` | `title` | `subtitle` |
| `meta` | `rows: [{label, value}]` | `title`, `rows[].badge` (`default\|success\|warning\|danger\|info`) |
| `callout` | `message` | `variant` (`info\|warning\|danger\|success`), `title` |
| `checklist` | `items: [{label, done}]` | `title`, `items[].note` |
| `steps` | `steps: [{label, status}]` | `title`, `steps[].note` (`done\|active\|pending\|error`) |
| `metrics` | `items: [{label, value}]` | `items[].sub`, `items[].variant` |
| `section` | `title` | — |
| `table` | `headers: string[]`, `rows: string[][]` | `title` |
| `text` | `content` | — |
| `code` | `content` | `title`, `lang` |
| `tags` | `items: [{label}]` | `title`, `items[].color` |
| `timeline` | `events: [{label}]` | `title`, `events[].time`, `events[].note`, `events[].status` |
| `progress` | `items: [{label, value}]` | `title`, `items[].max` (default `100`), `items[].variant` |
| `people` | `items: [{name}]` | `title`, `items[].sublabel`, `items[].color` |
| `quote` | `text` | `cite` |

---

## Topic categories (Topics cloud)

Every `push_plan` extracts a short list of topical labels (`ServiceNow`, `Mortise`, `Mailgun`, `Tooling`, …) from the plan's title + content via [`src/categories.ts`](./src/categories.ts) and persists them as `categories: string[]`. Zero external deps — curated Tenon vocabulary first, frequency-fallback for novel topics. The dashboard reads `categories` to render the **Topics** cloud at the top of `/claude-plans`. To bootstrap existing plans after upgrading:

```bash
npx dove-claude-plans recategorize        # write
npx dove-claude-plans recategorize --dry  # preview only
```

Callers can override auto-extraction by passing `categories` to `push_plan`.

---

## Backward compatibility

The v1 tool contract is locked by fixtures. `src/tests/v1-contract.test.ts` replays every fixture in `src/tests/fixtures/v1/*.json` through the live registry against a frozen clock, a deterministic id generator, and a cleared `CLAUDE_CODE_SESSION_ID`. Any drift in a v1 tool's response shape fails the suite. The v2 additions are strictly additive: v1 plan records (no `questions` / `stage` / `dispatch_*` fields) round-trip through every v1 tool unchanged, and the v2 reads return safe defaults against them.

---

## Stop hook

Recommended addition to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "npx -y @tenonhq/dovetail-claude-plans exit-stale --quiet"
      }]
    }]
  }
}
```
