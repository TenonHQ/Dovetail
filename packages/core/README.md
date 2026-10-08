# @tenonhq/dovetail-core

The core of Dovetail — ships the `dove` CLI binary and the sync engine that connects local source files to a ServiceNow instance via REST.

## What's in this package

- **`dove` CLI** — command router built on yargs. Watch, push, pull, build, deploy, scope/update-set management, record CRUD, ClickUp integration, schema pull, dashboard launch, and the project migration command (`dove migrate`).
- **Sync engine** — file watcher, manifest-driven file ↔ ServiceNow record mapping, plugin pipeline runner, Scripted REST API client.
- **Skills** — `skills/` ships ~8 Claude Code skill markdowns. `dove init-claude` copies them into `<cwd>/.claude/commands/` for in-project Claude usage.

## Installation

```bash
nvm use 20
npm i -D @tenonhq/dovetail-core
npx dove init        # scaffolds dove.config.js
npx dove configure   # creates .env (do not commit)
```

## Commands

The full command surface is documented in the [root CLAUDE.md](../../CLAUDE.md#essential-commands). Source of truth lives in [`src/commander.ts`](src/commander.ts).

Quick reference:

```bash
npx dove watch         # HUMAN-ONLY local dev: multi-scope watch + dashboard (hidden from --help; stop before git checkout — see #155)
npx dove push          # build + push current files
npx dove refresh       # pull manifest + new files, scope-wide (alias: r; bare `dove pull` does the same)
npx dove pull <table> <sys_id>   # mirror ONE record: its folder + its manifest key, nothing else (--dry-run, --sys-ids, --from-update-set)
npx dove build         # local build only
npx dove deploy        # deploy built artifacts
npx dove dashboard     # update-set dashboard web UI
npx dove migrate       # migrate a Sincronia project to Dovetail (dry-run by default; --apply to write)
```

`dove watch` refuses to start (exit 1) inside a Claude Code tool shell — any shell with `CLAUDECODE` set — because a branch switch mid-watch overwrites instance records. A human who really means to run it from such a shell (e.g. an IDE terminal that inherited the variable) can set `DOVE_ALLOW_WATCH_IN_CLAUDE=1`. Other `CLAUDE_CODE_*` variables only print a warning.

The watcher also records the git `HEAD` when it starts and re-reads it before every push. If `HEAD` moved (a checkout, branch switch, reset or pull), it drops the queued changes, pushes nothing, logs an error and pauses syncing until you restart it on the branch you mean to sync. Outside a git work tree this check is off.

See [`UPDATE_SET_COMMANDS.md`](UPDATE_SET_COMMANDS.md) for the full update-set CLI surface.

### `dove create sys_update_set`

`npx dove create <table>` inserts through the generic `createRecord` endpoint — except for `sys_update_set`. A plain insert lets ServiceNow default the set's `application` to the API session's current app, so `--scope` was silently ignored and the set landed in whatever scope the session was in (TenonHQ/Dovetail#231). Update sets therefore route through the atomic, scope-correct `createUpdateSet` server op (`POST /api/cadso/dovetail_core/createUpdateSet`) and the created set is read back: if its `application` does not match the requested scope the command exits non-zero, naming the requested vs. actual scope and the set's sys_id, so a mis-scoped set is never reported as success.

- `--scope` decides the application. It is **required** with `--ci`; interactively it is confirmed in the summary.
- Only `name` and `description` map onto the op; other `--field` values are ignored with a warning.
- An in-progress set with the same name already in that scope is refused (exit 1) rather than duplicated.
- The set is created, not activated — the success line prints its sys_id; use `npx dove switchUpdateSet --sysId <sys_id> -s <scope>` (or `npx dove createUpdateSet`, which creates and activates in one step).

## Plugins

Dovetail's build pipeline is plugin-driven. Each plugin is an npm package implementing `run(context, content, options) => Promise<PluginResults>`. Shipped plugins live in sibling packages (`@tenonhq/dovetail-typescript-plugin`, `-babel-plugin`, `-webpack-plugin`, `-sass-plugin`, `-eslint-plugin`, `-prettier-plugin`, `-babel-preset-servicenow`, `-babel-plugin-remove-modules`).

## Related packages

| Package | Purpose |
|---|---|
| `@tenonhq/dovetail-types` | Shared `Sinc.*` + `SN.*` type namespaces |
| `@tenonhq/dovetail-schema` | ServiceNow table schema fetcher |
| `@tenonhq/dovetail-dashboard` | Update-set dashboard web UI |
| `@tenonhq/dovetail-servicenow` | Platform helpers + `dove-sn` build-flow CLI |
| `@tenonhq/dovetail-sawmill` | Cross-instance update-set retrieve/preview/commit |
| `@tenonhq/dovetail-mcp` | Read-only MCP server (ClickUp, Gmail, Calendar, ServiceNow) |

## Full spec

See [`docs/dovetail-platform-spec.md`](../../docs/dovetail-platform-spec.md) for the complete architecture, type system, REST API contract, build pipeline, and sync mechanism.
