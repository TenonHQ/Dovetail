# CLAUDE.md

Guidance for Claude Code when working in the Dovetail repo. Read [`docs/dovetail-platform-spec.md`](docs/dovetail-platform-spec.md) before architectural decisions or adding packages.

## What Dovetail Is

Integration platform + Claude Code's action layer for ServiceNow. Bidirectional sync between local files and ServiceNow instances, layered with build pipelines (TypeScript, Babel, Webpack, SASS) and a small action layer (helpers, MCP server, dashboard). npm-workspaces monorepo, 20 packages published under `@tenonhq/dovetail-*`.

## Quick Start

```bash
nvm use 22            # Node 22 LTS required
npm install
npx dove watch        # watch all configured scopes, auto-sync
npm test              # from a package directory
```

Full command reference: see `Essential Commands` further down, or `npx dove --help`.

## Releasing — Critical Rules

> **All PRs in this repo MUST be opened as DRAFT, unless the user explicitly asks otherwise.** Merge-to-`main` auto-publishes changed `packages/**` to npm immediately, and a bad version cannot be unpublished cleanly. Open every PR as Draft, convert to *Ready for review* only after sign-off, then merge. The rule applies uniformly (even docs-only) so reviewers never have to guess whether a PR is safe. The only override is an explicit user instruction for a specific PR (e.g. "open it as ready", "automerge it") — never decide on your own that a change is "safe enough" to skip Draft.

How publishing works:
- **Trigger** — merge to `main` touching `packages/**` runs `.github/workflows/publish.yml`.
- **Scope** — packages with changed files, **plus every package that transitively depends on a changed one** (the cascade), built and published in dependency order.
- **Internal ranges** — inter-package `@tenonhq/dovetail-*` deps MUST be floating `~0.0.x`, never `^0.0.x`. On a pre-1.0 package `^0.0.x` is a *hard pin* (`^0.0.10` = `0.0.10` only), which forces consumers to set an `overrides` block / `--legacy-peer-deps` (ERESOLVE). CI enforces this via `node Scripts/normalize-internal-deps.js --check`; run `--write` to fix a violation.
- **Gate** — full monorepo must build (`tsc`) and pass tests, and the internal-range guard must be clean; any failure publishes nothing.
- **Versioning** — patch-bumped automatically: `max(package.json version, npm-latest + 1 patch)`. For a minor/major release, edit the package's `version` in your PR; CI honors it.
- **After publish** — CI commits `postpublish` version bumps back to `main` as `chore(release): … [skip ci]` and cuts git tags + GitHub Releases per package.

Orchestration: [`Scripts/PUBLISHING.md`](Scripts/PUBLISHING.md). Preview a merge with `node Scripts/publish-on-merge.js --dry-run` or the **Publish packages** workflow (dry-run on by default).

## Config Architecture

**`dove.config.js` is the single source of truth.** There are no hidden defaults — `defaultOptions.ts` was intentionally cleared; do not add defaults back.

### Gotchas (silent failure modes)

- **Missing `includes._tables`** — if `excludes._tables` is defined but `includes._tables` is missing/empty, **nothing syncs**. Define `includes._tables` explicitly.
- **Missing field type overrides** — tables with non-trivial fields (JSON, large strings) sync correctly only when listed as non-prefixed keys with overrides (e.g. `sys_ux_macroponent: { composition: { type: "json" } }`). Without overrides, sync may corrupt or skip the field silently.
- **Wrong scope on writes** — Table API POSTs from scripts adopt the API user's session scope (usually Tenon - Core). Always write scoped records through Dovetail's REST endpoints; never via raw Table API. See [`../ServiceNow/CLAUDE.md`](../ServiceNow/CLAUDE.md).

### Structure

- `_` prefix = config directive, not a table name:
  - `includes._tables` — whitelist of tables to sync (client-side filter — ServiceNow returns all tables in a scope, but only `_tables` entries get written to disk)
  - `includes._scopes` — per-scope overrides (additional tables, field type overrides)
  - `excludes._tables` — explicit excludes
- Non-prefixed `includes` keys = table names with field type overrides.

```javascript
module.exports = {
  sourceDirectory: "src",
  buildDirectory: "build",
  includes: {
    _tables: ["sys_script_include", "sys_script", /* ... */],
    sys_ux_macroponent: { composition: { type: "json" } },
    _scopes: {
      x_cadso_automate: { _tables: ["x_cadso_core_setting"] }
    }
  },
  excludes: { _tables: [] },
  scopes: {
    x_cadso_core: { sourceDirectory: "src/x_cadso_core" }
  }
};
```

### Synced Table Types (16)

`sys_script_include`, `sys_script`, `sys_ui_script`, `sys_ui_page`, `sys_ux_client_script`, `sys_processor`, `sys_ws_operation`, `sys_rest_message_fn`, `sys_ui_action`, `sys_security_acl`, `sysevent_script_action`, `sys_ux_macroponent`, `sys_ux_event`, `sys_ux_client_script_include`, `sys_ux_screen`, `sys_script_fix`. Full inventory: [`../ServiceNow/CLAUDE.md`](../ServiceNow/CLAUDE.md).

## Package Inventory (20)

**Core + types**
- `dovetail-core` — CLI (`dove` binary) + sync engine
- `dovetail-types` — TypeScript definitions

**Build pipeline**
- `dovetail-babel-plugin`, `dovetail-babel-plugin-remove-modules`, `dovetail-babel-preset-servicenow`
- `dovetail-typescript-plugin`, `dovetail-webpack-plugin`, `dovetail-sass-plugin`
- `dovetail-eslint-plugin`, `dovetail-prettier-plugin`

**Action layer**
- `dovetail-servicenow` — platform helpers (`addChoicesToField`, `buildFlow` CLI / `dove-sn` binary)
- `dovetail-sawmill` — update-set retrieve/preview/commit across instances
- `dovetail-schema` — ServiceNow table schema fetcher
- `dovetail-mcp` — MCP stdio server, **read-mostly: 16 tools** (4 ClickUp read, 4 Gmail, 3 Calendar, 1 `servicenow_query_table`, + **4 ClickUp writes gated by `SINC_MCP_WRITES_ENABLE=1`**, dry-run unless `confirm:true`). Telemetry at `~/.dovetail-mcp/telemetry.jsonl` (redacted).
- `dovetail-claude-plans` — MCP server (25 tools: plans, Q&A, pipeline stages, lint events, version history, handoff, prompt-editor drafts) + CLI for plans surfaced in the dashboard

> **Full MCP catalog (46 tools across 3 servers — `dovetail-mcp`, `dovetail-claude-plans`, and the `dovetail-servicenow` authoring server) + when-to-use each tool: [`docs/claude-operating-guide.md`](docs/claude-operating-guide.md).** That doc is the canonical source of truth for what Claude can do here.

**Integrations**
- `dovetail-clickup`, `dovetail-google-auth`, `dovetail-google-calendar`, `dovetail-gmail`

**UI**
- `dovetail-dashboard` — Update Set Dashboard web UI

### Reach-for-these subsystems

- **V2 Flow Designer codec** — `packages/core/src/flowDesigner/values.ts` exports `decodeV2Values` / `encodeV2Values` for `sys_hub_flow` step value blobs (base64+gzip+JSON). Round-trip tested against real fixtures. Don't hand-roll base64/gzip.
- **`addChoicesToField`** — update-set-aware, idempotent upsert of `sys_choice` + `sys_dictionary` rows. Pins writes to a target update set.
- **`buildFlow` CLI (`dove-sn`, Phase 1)** — orchestrates Custom Action Type + Subflow authoring. Exit codes: `0` done, `2` needs UI publish, `3-5` escalations. `createBranch` is `NotImplemented`. See `packages/servicenow/README.md`.

## Server-Side REST API

Dovetail's server operations live in a **global-scoped Scripted REST API** named **"Dovetail"** (legacy name: "Claude").

- **Base path:** `/api/cadso/dovetail/` (client falls back to legacy `/api/cadso/claude/` — see [`../docs/dovetail-servicenow-migration.md`](../docs/dovetail-servicenow-migration.md))
- **Web service definition sys_id:** `b8a9db8d33d7a6107b18bc534d5c7b7b`
- **Auth:** authenticated + `snc_internal_role`

| Method | Path | Purpose |
|---|---|---|
| GET | `/changeScope` | Switch app scope. `?scope=x_cadso_core` |
| GET | `/currentUpdateSet` | Read current update set. Optional `?scope=...` |
| GET | `/changeUpdateSet` | Switch active update set. `?sysId=...` or `?name=...&scope=...` |
| POST | `/pushWithUpdateSet` | Update a record within a specified update set. Body: `{ update_set_sys_id, table, record_sys_id, fields }` |
| POST | `/createRecord` | Create a record. Body: `{ table, fields }` (+ optional `sys_id`, `scope`, `update_set_sys_id`). Supports cross-instance moves via explicit `sys_id`. |
| POST | `/deleteRecord` | Delete a record. Body: `{ table, sys_id }` |

All POSTs are `application/json`. Update-set ops save/restore the previous update set. Source XML: `Downloads/sys_ws_operation (web_service_definition=b8a9db8d33d7a6107b18bc534d5c7b7b)*.xml`.

## Essential Commands

```bash
# Watch / sync
npx dove watch [--port 3457] [--noDashboard]
npx dove push                 # push local changes
npx dove refresh              # refresh manifest, pull new files
npx dove download <scope>     # full scope download
npx dove status               # sync status + instance info
# No `dove diff` command — `--diff <branch>` is a FLAG on push/build that scopes
# the op to files changed vs a git branch, e.g. `npx dove push --diff main`.

# Build / deploy
npx dove build
npx dove deploy

# Scopes & update sets
npx dove initScopes
npx dove createUpdateSet
npx dove switchUpdateSet
npx dove listUpdateSets
npx dove currentUpdateSet
npx dove changeScope
npx dove currentScope

# Records
npx dove create <table>
npx dove delete <table>

# Tools
npx dove dashboard [--port 3457]
npx dove schema pull
npx dove init-claude          # install Claude Code skills
npx dove task clear           # deselect active task (avoid stale update set pushes)
npx dove migrate              # Sincronia → Dovetail (default dry-run; --apply to execute)
npx dove clickup              # subcommands: tasks, task, create, update, comment, teams, setup, spaces, lists

# Target a different instance per command (global flag on every command)
npx dove push --env .env.prod         # alias: -e, --env-file
npx dove status -e ../envs/workshop.env
```

**Per-command `.env` selection.** Every `dove` command accepts a global `--env <path>` flag (alias `-e` / `--env-file`) that loads credentials from a specific file instead of the project-root `.env` — so one checkout can target multiple instances. `dove login --env .env.prod` also *writes* to that file. The same applies to `dove-sn` (`--env` / `DOVETAIL_ENV_FILE`) and the MCP servers (`--env` arg / `DOVETAIL_ENV_FILE`). Variables already in the environment are never overridden, so an exported `SN_INSTANCE` still wins (useful in CI).

First-time setup: `npm i -D @tenonhq/dovetail-core` → `npx dove init` → `npx dove configure` (creates `.env`, do not commit) → `npx dove watch`.

## Plugin System

```javascript
module.exports = {
  name: "my-plugin",
  transform: async (source, path) => transformedSource
};
```

## Manifest

`dove.manifest.json` tracks file ↔ ServiceNow record mappings:

```json
{
  "version": "1.0.0",
  "files": {
    "sys_script_include/FileName.js": {
      "table": "sys_script_include",
      "sysId": "abc123def456",
      "field": "script"
    }
  }
}
```

Don't hand-edit. Use `npx dove refresh` to rebuild from ServiceNow.

## Troubleshooting

| Symptom | First check |
|---|---|
| Auth failure | `.env` credentials, instance URL format, user role (or pass `--env <path>` to load a different file) |
| Hitting the wrong instance | A stray `.env` in cwd, or shell-exported `SN_INSTANCE` overriding the file — pass `--env <path>` and unset conflicting vars |
| Nothing syncs | `includes._tables` is defined and non-empty |
| Field corrupted on push | Add field type override under non-prefixed `includes.<table>` |
| Manifest drift | `npx dove refresh` |
| Build error | Node 22 LTS, plugin config |
| Sync conflict | `npx dove status` (or the dashboard), then `npx dove refresh` |
| Wrong scope on writes | Use Dovetail REST endpoints, not raw Table API |

Debug logs: `dovetail-debug-*.log`.

## Notes

- Node 22 LTS required.
- ServiceNow user needs admin or developer role.
- All sync operations are async; respect ServiceNow API rate limits.
- Never commit credentials — use `.env`.

## Related

- [`docs/dovetail-platform-spec.md`](docs/dovetail-platform-spec.md) — design doc (what we built, what's next, technical debt)
- [`../ServiceNow/CLAUDE.md`](../ServiceNow/CLAUDE.md) — ServiceNow application code, scoping rules, full table inventory
- [`../ServiceNowTypes/CLAUDE.md`](../ServiceNowTypes/CLAUDE.md) — TS definitions for SN APIs
- [`../Tables/CLAUDE.md`](../Tables/CLAUDE.md) — table schemas
- [`../CLAUDE.md`](../CLAUDE.md) — Craftsman monorepo conventions (coding standards, git/worktree workflow, branch naming)
