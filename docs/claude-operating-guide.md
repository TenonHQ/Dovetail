# How Claude Uses Dovetail

> **Canonical source of truth** for what Claude Code can do with Dovetail — every MCP tool, every CLI command, and the conventions that gate them. This doc lives next to the code so it can't drift behind a sibling repo.
>
> Audience: a Claude Code session (or the developer reading over its shoulder). For *building/contributing* to Dovetail, see [`../ONBOARDING.md`](../ONBOARDING.md). For the platform design, see [`dovetail-platform-spec.md`](dovetail-platform-spec.md).

Dovetail is the action layer that lets a Claude session **read and write ServiceNow, ClickUp, Gmail, and Calendar**, surface **plans in a dashboard**, and **author SN views/layouts/flows** — all from the terminal. The capability surface is three MCP servers (**41 tools**), three CLIs (`dove`, `dove-sn`, `dove-claude-plans`), and a set of installable skills.

---

## 1. The three MCP servers at a glance

| Server | Package | Tools | Posture | When you reach for it |
|---|---|---|---|---|
| **dovetail-mcp** | `@tenonhq/dovetail-mcp` | 16 | Read-mostly; 4 ClickUp writes behind an env gate | Look up ClickUp tasks, unread/starred mail, today's calendar, or query any SN table read-only |
| **dovetail-claude-plans** | `@tenonhq/dovetail-claude-plans` | 20 | Read + write (no gate) | Push a plan/diagram/artifact to the dashboard, park Q&A, drive pipeline stages, record lint events, browse plan versions, build a session handoff |
| **dovetail-servicenow** | `@tenonhq/dovetail-servicenow` (`dove-sn mcp`) | 5 | All writes, update-set-captured, `dryRun`-capable | Declaratively author SN views, list/form layouts, related lists, and field choices |

MCP tools surface in a session as `mcp__<server-key>__<tool>` (e.g. `mcp__claude-plans__push_plan`), where `<server-key>` is whatever the session's MCP config names the server. The **tool names below are the names registered in code** — verified against each package's `registry.ts`.

---

## 2. `dovetail-mcp` — 16 tools (read + gated ClickUp writes)

Source: `packages/mcp/src/registry.ts`. The 4 write tools throw unless `SINC_MCP_WRITES_ENABLE=1` is set, and they return a **dry-run preview** unless you pass `confirm:true` (gate: `packages/mcp/src/tools/clickup-write.ts`).

### ClickUp — read (4)
| Tool | What it does | When to use |
|---|---|---|
| `clickup_list_tasks` | List tasks assigned to the authed user, grouped by status | "What's on my plate?" |
| `clickup_get_task` | Fetch one task by ID | Pull a ticket's full body before acting on it |
| `clickup_search_tasks` | Substring search across team task name/description | Find a task when you don't have the ID |
| `clickup_get_team_sync` | Structured team sync across the 7-stage pipeline (Blocked → Done) + unmapped/unassigned | A sprint-board read or standup snapshot |

### ClickUp — write (4) · gated `SINC_MCP_WRITES_ENABLE=1`, dry-run unless `confirm:true`
| Tool | What it does |
|---|---|
| `clickup_update_task` | Update name/markdownContent/status/priority. Use `customTaskIds:true`+`teamId` for IDs like `DEV-225` |
| `clickup_set_custom_field` | Set one custom-field value (`POST /task/{id}/field/{fieldId}`) |
| `clickup_create_task` | Create a task in a list (content, status, priority, assignees, customFields) |
| `clickup_link_tasks` | Link two tasks (`POST /task/{id}/link/{linksTo}`) |

### Gmail — read (4)
`gmail_get_unread`, `gmail_get_starred`, `gmail_search` (Gmail query syntax), `gmail_get_action_required` (matches subject patterns/labels: "action required", "urgent", "asap", "time sensitive").

### Calendar — read (3)
`calendar_get_today`, `calendar_get_week` (next 7 days), `calendar_get_event` (by ID).

### ServiceNow — read (1)
| Tool | What it does | Guardrail |
|---|---|---|
| `servicenow_query_table` | Read-only GET against the SN Table API. Required: `table`, `sysparm_query`. Optional: `fields[]`, `limit` (default 100, max 1000) | Sensitive tables (`sys_user_password`, `sys_credential`, …) are denied unless `SINC_MCP_SN_TABLE_OVERRIDE=<table>` is set |

> **For SN *writes*, this server has none** — use the `dovetail-servicenow` MCP (§4) or the `dove`/`dove-sn` CLIs (§5). This is by design: `dovetail-mcp` is read-mostly.

---

## 3. `dovetail-claude-plans` — 20 tools (plans, Q&A, stages, lint, versions, handoff)

Source: `packages/claude-plans/src/registry.ts`. No env gate. Dashboard renders these at `http://localhost:3456/claude-plans`. **8 read · 12 write**, in four groups.

> **Project rule (CTO repo):** every implementation plan / architecture proposal MUST be pushed via `push_plan` (with artifacts) before being presented. See the CTO `CLAUDE.md` §5.

### 3a. Plans & artifacts (core)
| Tool | R/W | What it does |
|---|---|---|
| `push_plan` | W | Create/overwrite a plan (`content_md` \| `content_html` \| `content_structured`). Auto-slugs; defaults to DRAFT |
| `update_plan_status` | W | Transition status — only DRAFT→APPROVED, DRAFT→EXITED, APPROVED→EXITED (reverses rejected) |
| `push_artifact` | W | Attach an artifact (`kind`: markdown \| mermaid \| prompt-cycle) |
| `push_diagram` | W | Attach a Mermaid diagram (wrapper over `push_artifact` kind=mermaid) |
| `push_prompt` | W | Attach a rewritten prompt to the Prompt tab (with before/after lint scores) |
| `delete_plan` | W | Permanently delete a plan + all artifacts |
| `get_plan` | R | Read a plan + its nested artifacts by slug |
| `list_recent_plans` | R | List plans newest-first (filter by `status`, `limit`) |
| `get_handoff_bundle` | R | Compose a paste-ready Markdown payload to resume a plan in a fresh session |

### 3b. Q&A
| Tool | R/W | What it does |
|---|---|---|
| `push_question` | W | Park a question on a plan for a later session/operator |
| `record_answer` | W | Answer a previously-parked question (last-write-wins) |
| `get_answers` | R | List a plan's parked Q&A (filter `answered`, `stage`) |

### 3c. v2 pipeline (stages)
| Tool | R/W | What it does |
|---|---|---|
| `set_stage` | W | Move a plan to a new pipeline stage; validates the transition against the v2 state machine (`src/state-machine.ts`) and rejects illegal moves |
| `dispatch_stage` | W | Resolve (and optionally spawn) a Claude Code subprocess to drive a plan at a stage. **Riskiest v2 tool — dry-run by default; live spawn needs `confirm:true` + a valid one-time token.** Read `docs/v2-design.md` §7 first |
| `pull_plan` | R | Single-read snapshot of a plan + its full v2 surface (artifacts, prompts, questions, current stage, `stage_history`, `dispatch_log`) |

### 3d. Lint events & version history
| Tool | R/W | What it does |
|---|---|---|
| `push_lint_event` | W | Record a prompt-lint observation in the global store (dashboard `/prompt-lints`) |
| `get_lint_events` | R | List prompt-lint events newest-first (filters: `session_id`, `plan_slug`, `limit`) |
| `restore_plan_version` | W | Restore a prior plan version as the new current record (non-destructive — pre-restore state is snapshotted first) |
| `list_plan_versions` | R | List a plan's auto-saved version snapshots, newest-first |
| `get_plan_version` | R | Read one saved version snapshot (`{ version, saved_at, plan }`) |

**Typical flow:** `push_plan` → `push_diagram`/`push_artifact` → present → on approval `update_plan_status APPROVED`. Park unknowns with `push_question`; resume later with `get_handoff_bundle`. Plan versions auto-save on every content-changing push, so an inferior overwrite is recoverable via `list_plan_versions` + `restore_plan_version`.

---

## 4. `dovetail-servicenow` MCP (`dove-sn mcp`) — 5 tools (SN authoring writes)

Source: `packages/servicenow/src/mcp/registry.ts`. **All writes**, all **captured in the update set you pass**, all support `dryRun` to preview without writing, all **idempotent**.

| Tool | What it does |
|---|---|
| `create_view` | Create a custom view (`sys_ui_view`); existing same-name view returned unchanged |
| `set_list_layout` | Declaratively set a list layout's columns + order for table+view. `prune` (default true) removes columns not in the spec |
| `set_form_layout` | Declaratively set form sections + fields. First section is primary (omit its caption). `prune` default true |
| `set_related_lists` | Set which related lists appear on a form. IDs: `"<table>.<field>"` or `"REL:<sys_relationship>"` |
| `add_choices_to_field` | Upsert `sys_choice` values and optionally flip `sys_dictionary.choice` to render as a dropdown |

Same operations are available from the `dove-sn` CLI (§5) for scripted/CI use.

---

## 5. The three CLIs

### `dove` (package `core`) — sync engine + everything
Source: `packages/core/src/commander.ts`. Run `npx dove <cmd> --help`.

| Command | Notable flags | Purpose |
|---|---|---|
| `watch` (`w`) | `--port`, `--noDashboard`, `--monitorInterval`, `--noMonitoring` | Watch all scopes, auto-sync to SN; dashboard on :3456 |
| `refresh` (`r`) | `--force`, `--scope`, **`--benchmark`** | Pull latest manifest + files. `--benchmark` logs per-scope/aggregate HTTP latency, bytes, file counts |
| `push` | **`--diff <branch>`**, **`--clickup <id\|url>`**, `--updateSet <name>`, `--ci` | Push local → SN. `--diff` filters to files changed vs a git branch; `--clickup` creates an update set from a ClickUp task |
| `build` | `--diff <branch>` | Build app files locally; `--diff` scopes to a branch diff |
| `deploy` | | Deploy local build to the scoped app |
| `download <scope>` | | Full scope download from SN |
| `init` / `initScopes` | | First-time project setup / provision configured scopes |
| `init-claude` | `--force` | Install Dovetail's Claude Code skills into `.claude/commands/` (see §6) |
| `login [plugin]` | `--all`, `--instance`, `--user`, `--password` | Authenticate SN (and integrations) |
| `status` | | Connected-instance info |
| `create <table>` / `delete <table>` | `--scope`, `--from`, `--field`, `--sysid`, `--keepLocal`, `--ci` | Create/delete an SN record |
| `migrate` | `--apply` | Migrate a project Sincronia → Dovetail. **Default dry-run**; `--apply` executes |
| `task clear` | | Clear the active ClickUp task (`.dove-active-task.json`) so stale tasks don't route update sets |
| `clickup <sub>` | | ClickUp ops: `tasks`, `task <id>`, `create <list>`, `update <id>`, `comment <id> <msg>`, `teams`, `setup`, `spaces`, `lists <id>` |
| update-set family | `--name`, `--scope`, `--clickup` | `createUpdateSet`, `switchUpdateSet`, `listUpdateSets`, `currentUpdateSet` |
| scope family | `--scope` | `changeScope`, `currentScope` |
| `dashboard` | `--port` | Launch the Update-Set Dashboard web UI |
| `schema pull` | `--output`, `--scope` | Pull SN table schemas |
| `knowledge-diff` | `--manifest`, `--config`, `--ledger`, `--out`, `--json` | Report Dovetail releases this repo hasn't documented yet — diffs the published `release-manifest.json` against a consumer `ledger.json` and stages per-package release-event JSON into `context/dovetail-releases/pending/` for the `dovetail-features-sync` skill. `--json` prints the diff instead of writing files |

> **There is no `dove diff` command.** `--diff` is a flag on `push` and `build`. (Older docs listed `dove diff` — that was never a real command.)

### `dove-sn` (package `servicenow`) — SN authoring CLI
Source: `packages/servicenow/src/cli.ts`. Every write lands in `--update-set`; most support `--dry-run` and `--json`.

| Command | Purpose |
|---|---|
| `add-choices` | Upsert `sys_choice`/`sys_dictionary` for `table.column`. Choices as `value=Label,value2=Label2` or `--from-json` |
| `create-view` | Create a `sys_ui_view` |
| `set-list-layout` | Set a list layout's columns (`--from-json` or `--columns`); `--prune` |
| `set-form-layout` | Set form sections + fields (`--from-json`, nested spec) |
| `set-related-lists` | Set a form's related lists (`--from-json` or `--related-lists`); `--prune` |
| `build-flow` | Author Custom Action Types + Subflows from a JSON spec. Exit codes: `0` done/unchanged/dry-run, `2` needs UI publish, `3` verify-mismatch, `4` write-failed, `5` unrecoverable |
| `mcp` | Run the MCP stdio server (`--smoke` lists tools and exits) |

### `dove-claude-plans` (package `claude-plans`) — plan store CLI
Source: `packages/claude-plans/src/cli.ts`.

| Command | Purpose |
|---|---|
| `mcp` | Run the plans MCP server (`--smoke` lists tools) |
| `list` | List plans newest-first (`--status DRAFT\|APPROVED\|EXITED`) |
| `exit <slug>` | Flip one plan to EXITED |
| `exit-stale` | Flip every DRAFT plan to EXITED (used by a Claude Stop hook); `--quiet` |
| `recategorize` | Re-extract topic categories on every plan (`--dry` previews) |
| `where` | Print the plan storage root path |

---

## 6. `dove init-claude` — the 9 installable skills

`npx dove init-claude` copies these from `packages/core/skills/` into your project's `.claude/commands/` (`packages/core/src/claudeCommand.ts`):

`dove-setup-project`, `dove-configure-pipeline`, `dove-debug-build`, `dove-manage-tables`, `dove-create-record`, `dove-delete-record`, `dove-manage-update-sets`, `dove-create-plugin`, `dove-troubleshoot-sync`.

Use `--force` to overwrite existing copies.

---

## 7. Conventions that gate writes

- **ClickUp writes (dovetail-mcp):** set `SINC_MCP_WRITES_ENABLE=1`; every write is a dry-run preview unless `confirm:true`.
- **SN writes always go through an update set.** Pass `--update-set` (CLI) or the update-set arg (MCP). Never write scoped SN records via the raw Table API — a Table API POST adopts the API user's session scope and lands in the wrong app. (Dovetail's REST endpoints + `dove createUpdateSet` keep scope correct — see the repo `CLAUDE.md` → Server-Side REST API.)
- **SN `dryRun` first.** The `dove-sn` MCP write tools and CLI commands all preview before writing — use it.
- **Plans before presenting.** Push every plan/proposal via `push_plan` with artifacts.

---

## 8. Publishing & the DRAFT-PR rule

**Every PR in this repo MUST be opened as DRAFT.** Merge-to-`main` touching `packages/**` auto-publishes the changed packages to npm immediately (`.github/workflows/publish.yml`), and a bad version cannot be cleanly unpublished. Open as Draft, convert to *Ready for review* only after sign-off, then merge. The rule applies even to docs-only PRs so reviewers never have to guess. See [`../ONBOARDING.md`](../ONBOARDING.md) and the repo `CLAUDE.md` → Releasing.

---

## 9. Where else to look

- Building/contributing to Dovetail → [`../ONBOARDING.md`](../ONBOARDING.md)
- All docs → [`INDEX.md`](INDEX.md)
- Platform design → [`dovetail-platform-spec.md`](dovetail-platform-spec.md)
- V2 Flow codec → `packages/core/src/flowDesigner/values.ts`
- Cross-instance update-set promotion → [`../packages/sawmill/README.md`](../packages/sawmill/README.md)

*Last updated: 2026-05-29 · Tool counts verified against each package's `registry.ts`.*
