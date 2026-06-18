# CLAUDE.md

Guidance for Claude Code when working in the Dovetail repo. Read [`docs/dovetail-platform-spec.md`](docs/dovetail-platform-spec.md) before architectural decisions or adding packages.

## What Dovetail Is

Integration platform + Claude Code's action layer for ServiceNow. Bidirectional sync between local files and ServiceNow instances, layered with build pipelines (TypeScript, Babel, Webpack, SASS) and a small action layer (helpers, MCP server, dashboard). npm-workspaces monorepo; packages published under `@tenonhq/dovetail-*`.

## Quick Start

```bash
nvm use 22            # Node 22 LTS required
npm install
npx dove watch        # watch all configured scopes, auto-sync
npm test              # from a package directory
```

Full command reference: see `Essential Commands` further down, or `npx dove --help`.

## Releasing — Critical Rules

> **All PRs in this repo MUST be opened as DRAFT, unless the user explicitly asks otherwise.** Merge-to-`main` auto-publishes changed `packages/**` to npm immediately, and a bad version cannot be unpublished cleanly. Open every PR as Draft, convert to _Ready for review_ only after sign-off, then merge. The rule applies uniformly (even docs-only) so reviewers never have to guess whether a PR is safe. The only override is an explicit user instruction for a specific PR (e.g. "open it as ready", "automerge it") — never decide on your own that a change is "safe enough" to skip Draft.

How publishing works:

- **Trigger** — merge to `main` touching `packages/**` runs `.github/workflows/publish.yml`.
- **Scope** — packages with changed files, **plus every package that transitively depends on a changed one** (the cascade), built and published in dependency order.
- **Internal ranges** — inter-package `@tenonhq/dovetail-*` deps MUST be floating `~0.0.x`, never `^0.0.x`. On a pre-1.0 package `^0.0.x` is a _hard pin_ (`^0.0.10` = `0.0.10` only), which forces consumers to set an `overrides` block / `--legacy-peer-deps` (ERESOLVE). CI enforces this via `node Scripts/normalize-internal-deps.js --check`; run `--write` to fix a violation.
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
    _tables: ["sys_script_include", "sys_script" /* ... */],
    sys_ux_macroponent: { composition: { type: "json" } },
    _scopes: {
      x_cadso_automate: { _tables: ["x_cadso_core_setting"] },
    },
  },
  excludes: { _tables: [] },
  scopes: {
    x_cadso_core: { sourceDirectory: "src/x_cadso_core" },
  },
};
```

### Synced Table Types

Script-bearing `sys_*` / `sys_ux_*` record types (script includes, business rules, UI actions, ACLs, macroponents, screens, etc.). Full inventory: [`../ServiceNow/CLAUDE.md`](../ServiceNow/CLAUDE.md).

## Packages

Each is published as `@tenonhq/dovetail-*`. Grouped by role (no frozen counts — `package.json` workspaces is the source of truth):

- **Core + types** — `dovetail-core` (the `dove` CLI binary + sync engine), `dovetail-types`.
- **Build pipeline** — Babel / TypeScript / Webpack / SASS / ESLint / Prettier plugins that compile component source for ServiceNow.
- **Action layer** — `dovetail-servicenow` (platform helpers + `dove-sn` binary), `dovetail-sawmill` (cross-instance update-set retrieve/preview/commit), `dovetail-schema` (table schema fetcher), `dovetail-mcp` (read-mostly MCP stdio server; ClickUp writes gated by `SINC_MCP_WRITES_ENABLE=1`, dry-run unless `confirm:true`; telemetry at `~/.dovetail-mcp/telemetry.jsonl`, redacted), `dovetail-claude-plans` (MCP server + CLI for the plans dashboard).
- **Integrations** — ClickUp, Google auth, Google Calendar, Gmail.
- **UI** — `dovetail-dashboard` (Update Set Dashboard web UI).

> **Canonical catalog of MCP servers, every tool, and when to use each: [`docs/claude-operating-guide.md`](docs/claude-operating-guide.md).** That doc is the source of truth for what Claude can do here — counts and tool lists drift, so don't restate them.

### Reach-for-these subsystems

- **V2 Flow Designer codec** — `packages/core/src/flowDesigner/values.ts` exports `decodeV2Values` / `encodeV2Values` for `sys_hub_flow` step value blobs (base64+gzip+JSON). Round-trip tested against real fixtures. Don't hand-roll base64/gzip.
- **`addChoicesToField`** — update-set-aware, idempotent upsert of `sys_choice` + `sys_dictionary` rows. Pins writes to a target update set.
- **`buildFlow` CLI (`dove-sn`, Phase 1)** — orchestrates Custom Action Type + Subflow authoring. Exit codes: `0` done, `2` needs UI publish, `3-5` escalations. `createBranch` is `NotImplemented`. See `packages/servicenow/README.md`.

## Server-Side REST API

Dovetail's server operations live in a **global-scoped Scripted REST API** named **"Dovetail"** (legacy name: "Claude").

- **Base path:** `/api/cadso/dovetail/` (client falls back to legacy `/api/cadso/claude/` — see [`docs/dovetail-servicenow-migration.md`](docs/dovetail-servicenow-migration.md))
- **Web service definition sys_id:** look up by name ("Dovetail") on the target instance — don't hardcode; the value differs per instance and can drift.
- **Auth:** authenticated + `snc_internal_role`

| Method | Path                 | Purpose                                                                                                                                              |
| ------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/changeScope`       | Switch app scope. `?scope=x_cadso_core`                                                                                                              |
| GET    | `/currentUpdateSet`  | Read current update set. Optional `?scope=...`                                                                                                       |
| GET    | `/changeUpdateSet`   | Switch active update set. `?sysId=...` or `?name=...&scope=...`                                                                                      |
| POST   | `/pushWithUpdateSet` | Update a record within a specified update set. Body: `{ update_set_sys_id, table, record_sys_id, fields }`                                           |
| POST   | `/createRecord`      | Create a record. Body: `{ table, fields }` (+ optional `sys_id`, `scope`, `update_set_sys_id`). Supports cross-instance moves via explicit `sys_id`. |
| POST   | `/deleteRecord`      | Delete a record. Body: `{ table, sys_id }`                                                                                                           |

All POSTs are `application/json`. Update-set ops save/restore the previous update set. Source XML lives under `Downloads/sys_ws_operation (web_service_definition=<Dovetail def sys_id>)*.xml`.

## Commands — the non-obvious bits

Full CLI via `npx dove --help`. The common verbs (`watch`, `push`, `pull`, `refresh`, `status`, `build`, `deploy`, update-set + scope ops) are self-describing there. The few that trip people up:

- **`--diff <branch>` is a FLAG, not a `dove diff` command.** There is no `dove diff`. `--diff` scopes a `push`/`build` to files changed vs a git branch, e.g. `npx dove push --diff main`.
- **`--env <path>` targets a different instance per command** (alias `-e` / `--env-file`) — loads creds from a specific file instead of the project-root `.env`, so one checkout can hit multiple instances. `dove login --env <path>` also _writes_ to that file. Applies to `dove-sn` and the MCP servers too (`--env` / `DOVETAIL_ENV_FILE`). Already-exported vars (e.g. `SN_INSTANCE`) are never overridden — useful in CI, a footgun otherwise.
- **`npx dove task clear`** — deselect the active task so a `push` doesn't land in a stale update set.
- **`npx dove migrate`** — Sincronia → Dovetail; dry-run by default, `--apply` to execute.

First-time setup: `npm i -D @tenonhq/dovetail-core` → `npx dove init` → `npx dove configure` (creates `.env`, do not commit) → `npx dove watch`.

## Plugin System

```javascript
module.exports = {
  name: "my-plugin",
  transform: async (source, path) => transformedSource,
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

| Symptom                    | First check                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Auth failure               | `.env` credentials, instance URL format, user role (or pass `--env <path>` to load a different file)                        |
| Hitting the wrong instance | A stray `.env` in cwd, or shell-exported `SN_INSTANCE` overriding the file — pass `--env <path>` and unset conflicting vars |
| Nothing syncs              | `includes._tables` is defined and non-empty                                                                                 |
| Field corrupted on push    | Add field type override under non-prefixed `includes.<table>`                                                               |
| Manifest drift             | `npx dove refresh`                                                                                                          |
| Build error                | Node 22 LTS, plugin config                                                                                                  |
| Sync conflict              | `npx dove status` (or the dashboard), then `npx dove refresh`                                                               |
| Wrong scope on writes      | Use Dovetail REST endpoints, not raw Table API                                                                              |

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

---

_Last updated: 2026-06-15 — lean pass: dropped rot-prone counts/enumerations (point to [`docs/claude-operating-guide.md`](docs/claude-operating-guide.md) as canonical), trimmed the CLI catalog to non-obvious flags._
