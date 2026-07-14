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
npx dove watch         # multi-scope watch + dashboard
npx dove push          # build + push current files
npx dove refresh       # pull manifest + new files (aliases: pull, r)
npx dove build         # local build only
npx dove deploy        # deploy built artifacts
npx dove dashboard     # update-set dashboard web UI
npx dove migrate       # migrate a Sincronia project to Dovetail (dry-run by default; --apply to write)
```

See [`UPDATE_SET_COMMANDS.md`](UPDATE_SET_COMMANDS.md) for the full update-set CLI surface.

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
