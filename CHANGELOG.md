# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- Release commits are rebuilt on the latest `main` tip again (#288 re-landed), and the publisher now refuses to push a release commit that touches anything beyond the lockfile, package `version` / `@tenonhq/*` ranges and release metadata. A stale-checkout release commit had silently reverted #287, #288, #290 and #311.
- `@modelcontextprotocol/sdk` is back on `^1.32.1` in every MCP package (#311 re-landed; it had been reverted), and `@hono/node-server` resolves past the 1.19.15 advisory.
- `dove pull` never overwrites another record's manifest key: a same-named record gets the `name (sys_id prefix)` suffix a refresh would give it, and a collision on a server-provided key is refused. `dove pull --dry-run` / `--sys-ids` without a table now error instead of running a full refresh.
- `dove-sn create-record`, MCP `create_record` and `snClient.createRecord` refuse `sys_update_set` (the generic insert lands it in the session's app); use `dove createUpdateSet` / `dove create sys_update_set`.
- `getScopeId("global")` resolves `sys_id=global` (several `sys_scope` rows carry `scope=global`), and any other ambiguous scope name throws. `dove create sys_update_set` refuses a duplicate in-progress name in the scope and its hint activates the new set by `--sysId`.
- `design-access` and `add-column --cross-scope` refuse an update set that is not in progress; the Design Access record is created only after every refusing check (dependency included, also on scoped dry-runs), and its read-back asserts the owning `sys_scope`. `--dependent-on-field` is validated before it reaches a query.
- `set-column --dependent-on-field` on an inherited column writes a child-only `sys_dictionary_override` (`dependent` + `dependent_override`) instead of refusing.
- `index-create` warns (`IDENTITY WARNING` in the note) when the REST identity differs from the form-login user, since the capture can land in that user's set, and names the set a missing capture actually landed in. `index-list` / `index-create` / `add-index` resolve table-per-hierarchy children to their storage-root table instead of reporting no indexes.
- `delete-record` / `delete_record` checks the update set is in progress, pins it as current before deleting, reads the DELETE capture back (`captured`, `capturedInto`, `captureState`), and always runs the read-back even when the delete call throws.
- `DovetailUtilsMS` (server, deploy separately) fails closed on a `scopeQuery` without a `{scope}`/`{scopeId}` token, with `^NQ`, a dot-walk, or a field `isValidField()` rejects — instead of letting ServiceNow drop the term and return the whole table.
- `add-column --dry-run` / `add_column { dryRun: true }` now runs the same scope guards as the live path whenever a `scope` is named, so a mismatched or cross-scope request fails the dry-run the way it fails live instead of planning clean and failing on the write. A dry-run with no scope named stays network-free. (#316)
- `dove create sys_update_set --scope <x>` now routes through the scope-correct `createUpdateSet` server op instead of the generic record insert (which let ServiceNow default `application` to the session's current app), reads the set back, and exits non-zero naming requested vs. actual scope if it is mis-scoped. `--scope` is required for `sys_update_set` in `--ci` mode. (#231)

### Added

- `dove pull <table> <sys_id...>` — per-record pull. Mirrors one record (or `--sys-ids a,b,c`, or every `<table>_<sys_id>` capture in `--from-update-set <sys_id>`) into the repo without a scope-wide refresh: writes only that record's folder and adds/updates only its manifest key, leaving every other manifest entry byte-identical (trailing newline preserved; a manifest not written by Dovetail's own writer is flagged for formatting churn). Resolves scope from the record's `sys_scope`; with `--scope`, a record outside it refuses the WHOLE pull before any content is fetched. Folder name and file list come from the scope's server-side manifest (so they match what a full refresh writes); a table the server manifest skips (no script/html column, no override) still mirrors as `metaData.json` only, with a warning that a scope-wide refresh will drop its entry. `--dry-run` lists the files and manifest keys it would touch. Read-only against the instance. A bare `dove pull` is still the alias of `refresh`, and a stray `-t` is an error instead of a silent no-op. (#319)
- `dove-sn design-access` / MCP `design_access` — ensure the `sys_scope_design_access` record that lets one app author in another app's tables. Since the Zurich bw40 hotfix the platform UI refuses a cross-scope column without it ("Invalid 'Table' selected on the Dictionary Entry record … can only select '<app>' tables with read access enabled"), even when the table's access flags are all on. Idempotent; created through the scope-aware `createRecord` op in the SOURCE app's update set (refused if the set belongs to another scope) and read back with source/target asserted; `--dry-run` reports exists/missing.
- `add-column --cross-scope` / `add_column { crossScope: true }` now FLAGS a missing Design Access record on every result (`designAccess { required, present, sysId, created }` + a note; `present: null` when it could not be read), and `--ensure-design-access` / `ensureDesignAccess: true` creates it first in the column's update set — the column is not added if that create fails.
- `dove-sn add-column --cross-scope` / MCP `add_column { crossScope: true }` — add a column OWNED by a different app scope than its table (ServiceNow's cross-scope field: a Journey column on an Automate table, element `x_cadso_journey_<name>`). The insert runs through the scope-aware `createRecord` op switched to the column's scope, so the dictionary row and its Dictionary + Field Label captures land in the column's scope; the stored element and `sys_scope` are read back. Guards: the owner scope must exist, the table must allow new fields from other scopes (`sys_db_object.alter_access`), and the update set must belong to the column's scope. Without the opt-in a mismatched `--scope` is still refused. Verified live on workstudio. (#316)
- `dove-sn help <verb>` / `dove-sn <verb> --help` / `dove-sn --help` — per-verb usage (required and optional flags with value formats, write gate, example) from a single `VERB_USAGE` table; `Missing required flags` errors now print the verb's usage block; help never loads an env file or builds a client. (#302, shipped in #314 via #309)
- `servicenow_query_table` (`dovetail-mcp`) accepts `offset` → `sysparm_offset`, so result sets past the 1000-row page ceiling can be paged. (#298, shipped in #314 via #310)
- `delete_record` MCP tool on `dove-sn mcp` + `dove-sn delete-record` verb — read-back before and after, dry-run by default, `--update-set` required. Completes the generic ServiceNow write surface (create / update / delete) that #154 asked for, on `dove-sn mcp` rather than `dovetail-mcp`. (#154, #308)
- `tableOptions.<table>.scopeQuery` — sync tables whose rows carry no `sys_scope` (`sys_choice`) by an encoded query with `{scope}`/`{scopeId}` tokens; the server lists such a table for every scope instead of discovering it via `sys_metadata`.
- `tableOptions.<table>.nameTemplate` — record folder names from raw field values (`"{name}.{element}.{value}"`), so `sys_choice` / `sys_dictionary` records get stable, non-colliding directories. Server `DovetailUtilsMS` + `dovetail-types`.

### Changed

- `dove watch` (`w` / `watchAllScopes`) is hidden from `dove --help` and scrubbed from Claude-facing docs and skills; still fully wired for humans. It now prints a human-only warning when it detects a Claude Code session (`CLAUDECODE` / `CLAUDE_CODE_*`), because a branch switch mid-watch overwrites instance records. Human-facing docs keep it, labelled with the caveat. (#155)
- The watcher now refuses to start in a Claude Code tool shell (`CLAUDECODE` set; override `DOVE_ALLOW_WATCH_IN_CLAUDE=1`) and pauses — dropping queued changes, pushing nothing — when git `HEAD` moves while it runs, so a branch switch can no longer mass-push the working tree.

## [0.0.83] - 2026-04-17

### Added

- `--benchmark` flag for `sinc refresh` with workstudio measurements (#41)
- Active task banner and record links in watch log (#37)

### Fixed

- `sinc refresh` now pulls instance-side edits down to local (#36)
- `sinc refresh` gated on scope + table whitelists (#34)
- `bulkDownload` chunked, REST 500 error detail surfaced (#33)
- Dashboard session persistence and watcher scope switching (#31, #32)
- Default update set fallback warning — RFC-0004 defect 3.3 (#40)
- Restored 3 multi-scope test suites after mock gap and stale assertions (#39)

### Changed

- `@tenonhq/sincronia-core@0.0.83` / `@tenonhq/sincronia-clickup@0.0.7` published
- Internal refs bumped to core 0.0.82, clickup 0.0.6 (#44)
- RFC-0004 canonical pointer replaces duplicate copy (#38)

## [0.0.82] - 2026-04-14

### Added

- Sincronia multi-scope QA/UAT audit — 20 remediations across scope safety, API resilience, and docs (#29)

### Changed

- Removed single-scope mode, enforced multi-scope (#21)
- Multi-scope manifests handled across push, build, create, delete (#20)
- Config phase, dashboard port flag, concurrency batching (#19)
- Per-scope progress bars for sync operations (#18)

### Fixed

- `normalizeInstance` trailing slash alignment (#17)
- Skip login prompts when `.env` credentials exist (#23)

## [0.0.78] - 2026-04-10

### Added

- Multi-scope support for `sinc init` (#26)
- Dashboard task filters and default update set names (#27)
- Sincronia platform specification docs (#24)

## [0.0.73] - 2026-04-08

### Fixed

- `sinc init` no longer starts the dashboard server — plugin discovery was requiring the dashboard package which started Express as a side effect
- Dashboard `server.js` now guarded with `require.main === module` to prevent startup on `require()`

### Added

- `--port` / `-p` flag for `sinc watch` and `sinc dashboard` — run multiple sessions on different ports (e.g. `sinc watch --port 3457`)
- Port precedence: `--port` flag > `DASHBOARD_PORT` env var > default `3456`
- `sincronia-dashboard` and `sincronia-schema` added to plugin discovery skip list

### Changed

- `@tenonhq/sincronia-types@0.0.11` — added `port` to `WatchCmdArgs`
- `@tenonhq/sincronia-dashboard@0.0.8` — guarded `app.listen()` with `require.main` check
- `@tenonhq/sincronia-core@0.0.73` — discovery skip list, `--port` flag

## [0.4.1] - 2020-07-06

### Added

- updated deps version with security vulnerabilities [@collinparker-nuvolo]
- in dev mode, retries are disabledd from [@nrdurkin]

## [0.4.0] - 2020-06-19

### Added

- Installed Jest and added preliminary tests from [@tyler-ed]
- Added diff option to build and deploy commands from [@nrdurkin]
- Added documentation for new configuration options and commands from [@nrdurkin]

### Changed

- Dev mode will periodically refresh the manifest from [@nrdurkin]

## [0.3.10-alpha.0] - 2020-06-01

### Added

- Retry sending files when network error occurs while pushing to server from [@nrdurkin].
- Added status command to show current connection information from [@nrdurkin]
- Added "build" command to create static deployable bundles from [@nrdurkin].
- Added "deploy" command to deploy static bundles to servers from [@nrdurkin].

### Changed

- "sinc push" shows record count before confirmation from [@nrdurkin].
- Validate credentials during init from [@nrdurkin].
- refactored config loading during startup to be more straight forward and performent from [@nrdurkin].

### Removed

- nothing removed

## [0.3.6] - 2020-02-12

### Added

- created by [@bbarber9](https://github.com/bbarber9).

### Changed

- no changes

### Removed

- nothing removed

[0.4.1]: https://github.com/nuvolo/sincronia/releases/tag/v0.4.1
[0.4.0]: https://github.com/nuvolo/sincronia/releases/tag/v0.4.0
[0.3.6]: https://github.com/nuvolo/
[0.3.10-alpha.0]: https://github.com/nuvolo/sincronia/releases/tag/v0.3.10-alpha.0
[@nrdurkin]: https://github.com/nrdurkin
[@tyler-ed]: https://github.com/tyler-ed
[@collinparker-nuvolo]: https://github.com/collinparker-nuvolo
