# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Dovetail is a powerful development tool that enables modern ServiceNow development workflows. It provides bidirectional synchronization between your local development environment and ServiceNow instances, allowing developers to use modern tools like Git, TypeScript, Babel, and Webpack while working with ServiceNow code.

## Essential Commands

### Installation and Setup

```bash
# Node.js v22 LTS required
nvm use 22

# Create project and install as dev dependency
mkdir my-dovetail-project && cd my-dovetail-project
npm init
npm i -D @tenonhq/dovetail-core

# Initialize project (creates dove.config.js)
npx dove init

# Configure ServiceNow instance (creates .env — do not commit)
npx dove configure
```

### Development Commands

```bash
# Watch all scopes for changes and sync automatically
npx dove watch               # Multi-scope watch (aliases: w, watchAllScopes)
npx dove watch --port 3457   # Custom dashboard port (for multiple sessions)
npx dove watch --noDashboard # Watch without launching the dashboard

# Manual sync operations
npx dove push                # Push local changes to ServiceNow
npx dove refresh             # Refresh manifest and download new files
npx dove download <scope>    # Download a full scope from ServiceNow

# Build and deploy
npx dove build               # Build application files locally
npx dove deploy              # Deploy local build to ServiceNow

# Status and debugging
npx dove status              # Check sync status and instance info

# Scope and update set management
npx dove initScopes          # Initialize all scopes from config
npx dove createUpdateSet     # Create a new update set
npx dove switchUpdateSet     # Switch to an existing update set
npx dove listUpdateSets      # List in-progress update sets
npx dove currentUpdateSet    # Show the current active update set
npx dove changeScope         # Change to a different scope
npx dove currentScope        # Show the current active scope

# Record management
npx dove create <table>      # Create a new record
npx dove delete <table>      # Delete a record

# Tools
npx dove dashboard           # Launch the Update Set Dashboard web UI
npx dove dashboard --port 3457  # Dashboard on custom port
npx dove schema pull         # Pull ServiceNow table schemas
npx dove init-claude         # Install Claude Code skills
npx dove task clear          # Deselect active task (removes .dove-active-task.json). Use when switching tasks or to avoid pushing to a stale task's update set
npx dove migrate             # Migrate an existing Sincronia project to Dovetail. Pass --apply to actually perform the migration; default is a dry-run plan.
npx dove clickup             # ClickUp task management (subcommands: tasks, task, create, update, comment, teams, setup, spaces, lists)
```

## Architecture

### Core Components

Dovetail is an npm-workspaces monorepo with 20 packages (all published under `@tenonhq/dovetail-*`):

- **dovetail-core** — CLI + core synchronization logic (the `dove` binary)
- **dovetail-types** — TypeScript type definitions
- **dovetail-babel-plugin** — Babel plugin
- **dovetail-babel-plugin-remove-modules** — Strips imports/exports for ServiceNow
- **dovetail-babel-preset-servicenow** — ServiceNow sanitizer preset
- **dovetail-typescript-plugin** — TypeScript compilation plugin
- **dovetail-webpack-plugin** — Webpack module bundling
- **dovetail-sass-plugin** — SASS/SCSS compilation
- **dovetail-eslint-plugin** — ESLint code quality
- **dovetail-prettier-plugin** — Prettier formatting
- **dovetail-clickup** — ClickUp API client for task management
- **dovetail-google-auth** — Shared Google OAuth2 authentication
- **dovetail-google-calendar** — Google Calendar API client
- **dovetail-gmail** — Gmail API client
- **dovetail-dashboard** — Update Set Dashboard web UI
- **dovetail-schema** — ServiceNow table schema fetcher
- **dovetail-servicenow** — ServiceNow platform helpers (dictionary, choices, update-set-aware writes)
- **dovetail-sawmill** — Sawmill REST client (update-set retrieve/preview/commit across instances)
- **dovetail-mcp** — MCP server exposing read-only ClickUp / Gmail / Calendar / ServiceNow tools
- **dovetail-claude-plans** — MCP server + CLI for Claude Code plans surfaced in the dashboard

### How It Works

1. **File Watching**: Monitors local files for changes
2. **Transformation**: Applies build pipelines (TypeScript, Babel)
3. **Synchronization**: Pushes/pulls changes to/from ServiceNow
4. **Manifest Management**: Tracks file mappings and configurations

## File Organization

```
Dovetail/
├── packages/                          # npm workspace packages (20 packages)
│   ├── core/                          # CLI + core sync logic
│   ├── types/                         # TypeScript definitions
│   ├── babel-plugin/                  # Babel plugin
│   ├── babel-plugin-remove-modules/   # Import/export removal
│   ├── babel-preset-servicenow/       # ServiceNow sanitizer
│   ├── typescript-plugin/             # TypeScript plugin
│   ├── webpack-plugin/                # Webpack plugin
│   ├── sass-plugin/                   # SASS/SCSS plugin
│   ├── eslint-plugin/                 # ESLint plugin
│   ├── prettier-plugin/               # Prettier plugin
│   ├── clickup/                       # ClickUp API client
│   ├── google-auth/                   # Shared Google OAuth2 authentication
│   ├── google-calendar/               # Google Calendar API client
│   ├── gmail/                         # Gmail API client
│   ├── dashboard/                     # Update Set Dashboard UI
│   ├── schema/                        # ServiceNow schema fetcher
│   ├── servicenow/                    # ServiceNow platform helpers
│   ├── sawmill/                       # Sawmill update-set retrieve/preview/commit client
│   ├── mcp/                           # MCP server for read-only integrations
│   └── claude-plans/                  # Claude Code plans MCP + dashboard
├── docs/                              # QA documentation
├── Scripts/                           # Release pipeline + version bump scripts
├── CHANGELOG.md                       # Release history
├── tsconfig.json                      # TypeScript configuration
├── package.json                       # Root package (npm workspaces)
└── README.md                          # Main documentation
```

## Releasing

Packages publish to npm **automatically** — there is no manual `npm publish`
step and no separate version-bump PR.

- **Trigger** — every merge to `main` that touches `packages/**` runs the
  `.github/workflows/publish.yml` workflow.
- **What ships** — only the packages whose files changed in that merge, built
  and published in dependency order.
- **Gate** — the whole monorepo must build (`tsc`) and pass its test suites
  first; any failure publishes nothing.
- **Versioning** — patch-bumped automatically. The published version is
  `max(package.json version, npm-latest + 1 patch)`, so two racing merges can
  never collide. For a minor/major release, edit the package's `version` in
  your PR and CI will honor it.
- **After publish** — CI commits the `postpublish` version bumps back to `main`
  as a `chore(release): … [skip ci]` commit and cuts a git tag + GitHub
  Release per package.

Orchestration lives in `Scripts/` — see [`Scripts/PUBLISHING.md`](Scripts/PUBLISHING.md).
To preview a merge without shipping, run the **Publish packages** workflow
manually (`dry_run` defaults to on) or locally:

```bash
node Scripts/publish-on-merge.js --dry-run
```

## Config Architecture

**`dove.config.js` is the single source of truth.** There are no hidden defaults.

- `defaultOptions.ts` exports empty objects — it was intentionally cleared. Do not add defaults back.
- The `_` prefix convention: keys starting with `_` are config directives, not table names.
  - `includes._tables` — whitelist of tables to sync (only these get written to disk)
  - `includes._scopes` — per-scope overrides (additional tables, field type overrides)
  - `excludes._tables` — tables to explicitly exclude
- Non-prefixed keys in `includes` are table names with field type overrides (e.g. `sys_ux_macroponent: { composition: { type: "json" } }`)
- Client-side filtering enforces the whitelist — ServiceNow returns all tables in a scope, but only `_tables` entries get written to disk
- Legacy default excludes (26 tables removed during overhaul) are preserved in Claude memory for reference

## Development Guidelines

### Configuration Files

#### dove.config.js

```javascript
module.exports = {
  sourceDirectory: "src",
  buildDirectory: "build",
  includes: {
    _tables: ["sys_script_include", "sys_script", ...],
    sys_ux_macroponent: { composition: { type: "json" } },
    _scopes: {
      x_cadso_automate: {
        _tables: ["x_cadso_core_setting"],  // additional tables for this scope
      }
    }
  },
  excludes: { _tables: [] },
  scopes: {
    x_cadso_core: { sourceDirectory: "src/x_cadso_core" },
  }
};
```

#### dove.manifest.json

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

### Synced Table Types

Dovetail synchronizes 16 ServiceNow table types:

`sys_script_include`, `sys_script`, `sys_ui_script`, `sys_ui_page`, `sys_ux_client_script`, `sys_processor`, `sys_ws_operation`, `sys_rest_message_fn`, `sys_ui_action`, `sys_security_acl`, `sysevent_script_action`, `sys_ux_macroponent`, `sys_ux_event`, `sys_ux_client_script_include`, `sys_ux_screen`, `sys_script_fix`

See [ServiceNow/CLAUDE.md](../ServiceNow/CLAUDE.md) for the full table inventory.

### Build Pipeline Configuration

Dovetail supports modern JavaScript tooling via dedicated plugin packages:

- **TypeScript**: Full type checking and transpilation (`@tenonhq/dovetail-typescript-plugin`)
- **Babel**: Modern JavaScript syntax support (`@tenonhq/dovetail-babel-plugin`)
- **Babel Remove Modules**: Strips imports/exports for ServiceNow compatibility (`@tenonhq/dovetail-babel-plugin-remove-modules`)
- **Babel Preset ServiceNow**: Sanitizes code for the ServiceNow platform (`@tenonhq/dovetail-babel-preset-servicenow`)
- **Webpack**: Module bundling and optimization (`@tenonhq/dovetail-webpack-plugin`)
- **SASS**: SASS/SCSS stylesheet compilation (`@tenonhq/dovetail-sass-plugin`)
- **ESLint**: Code quality enforcement (`@tenonhq/dovetail-eslint-plugin`)
- **Prettier**: Code formatting (`@tenonhq/dovetail-prettier-plugin`)

### Plugin System

Create custom plugins for build transformations:

```javascript
module.exports = {
  name: "my-plugin",
  transform: async (source, path) => {
    // Transform source code
    return transformedSource;
  }
};
```

## Action Layer & Specialized Subsystems

Beyond the sync engine + build plugins, Dovetail ships a small action layer for programmatic ServiceNow work and cross-system reads. These are the packages Claude Code agents reach for most often.

### V2 Flow Designer Values Codec

`packages/core/src/flowDesigner/values.ts` — `decodeV2Values` and `encodeV2Values` for Flow Designer V2 storage blobs (base64-encoded gzip JSON). Round-trip tested against real ServiceNow fixtures. Use these when reading or writing `sys_hub_flow` step values programmatically; do not hand-roll base64/gzip.

### `@tenonhq/dovetail-servicenow`

ServiceNow platform helpers, layered on top of the Dovetail Scripted REST API:

- **`addChoicesToField`** — upserts `sys_choice` + `sys_dictionary` rows. Update-set-aware (pins writes to a target update set), idempotent.
- **`buildFlow` CLI (`dove-sn` binary, Phase 1)** — orchestrator for Custom Action Type + Subflow authoring. Validates specs → clones templates → verifies artifacts → triggers publication. `createBranch` is currently `NotImplemented`. Exit codes: `0` (done), `2` (needs UI publish), `3-5` (escalations). See `packages/servicenow/README.md`.

### `@tenonhq/dovetail-sawmill`

Sawmill REST client — retrieve, preview, and commit update sets across instances. Powers cross-environment code movement (dev → test → UAT → prod).

### `@tenonhq/dovetail-mcp`

MCP stdio server, **Phase 1 read-only**. Exposes 12 tools wrapping ClickUp, Gmail, Calendar, and ServiceNow reads for Claude Code. Read-only enforced via import denylist + ESLint + symbol-scan tests. Telemetry at `~/.dovetail-mcp/telemetry.jsonl` (redacted). Phase 2 (gated writes) and Phase 3 (high-blast-radius writes) deferred.

## Integration Points

### ServiceNow Connection

- Uses REST API for synchronization
- Supports multiple instance configurations
- Handles authentication securely
- Manages scope-based permissions

### Server-Side REST API ("Dovetail", formerly "Claude")

Dovetail's server-side operations are exposed via a **global-scoped Scripted REST API** named **"Dovetail"** on ServiceNow. The API was previously named "Claude" with base path `/api/cadso/claude/`; the client falls back to that legacy path on instances where the rename has not been imported yet (see [docs/dovetail-servicenow-migration.md](../docs/dovetail-servicenow-migration.md)).

- **Base path:** `/api/cadso/dovetail/` (legacy: `/api/cadso/claude/`)
- **Web service definition sys_id:** `b8a9db8d33d7a6107b18bc534d5c7b7b` (unchanged across the rename)
- **Scope:** Global
- **Auth:** Requires authentication + `snc_internal_role`

#### Operations

| Method | Path | Name | Description |
|--------|------|------|-------------|
| `GET` | `/changeScope` | Change Scope | Switches current application scope. Query param: `scope` (scope name, e.g. `x_cadso_core`). |
| `GET` | `/currentUpdateSet` | Current Update Set | Returns the current update set. Optional query param: `scope` (temporarily switches scope before reading). |
| `GET` | `/changeUpdateSet` | Change Update Set | Switches the active update set. Query params: `sysId` (direct), or `name` + `scope` (lookup by name within scope, most recent in-progress). |
| `POST` | `/pushWithUpdateSet` | Push with Update Set | Updates a record within a specified update set. Body: `{ update_set_sys_id, table, record_sys_id, fields }`. Saves/restores the previous update set around the operation. |
| `POST` | `/createRecord` | Dovetail - Create Record (legacy: Sinc - Create Record) | Creates a new record. Body: `{ table, fields }` (required), `{ sys_id, scope, update_set_sys_id }` (optional). Supports cross-instance moves via explicit `sys_id` and scope targeting. |
| `POST` | `/deleteRecord` | Dovetail - Delete Record (legacy: Sinc - Delete Record) | Deletes a record. Body: `{ table, sys_id }`. Returns the display name of the deleted record on success. |

#### Notes

- All POST operations accept and return `application/json`.
- Update set operations save and restore the previous update set to avoid side effects.
- The `createRecord` endpoint supports setting a specific `sys_id` via `setNewGuidValue()` for cross-instance record moves.
- Source XML export is stored at: `Downloads/sys_ws_operation (web_service_definition=b8a9db8d33d7a6107b18bc534d5c7b7b)*.xml`

### Related Directories

- **ServiceNow/** - Main application code synced by Dovetail
- **ServiceNowTypes/** - TypeScript definitions for ServiceNow APIs
- **Tables/** - Database schema definitions

## Common Tasks

### Setting Up New Project

1. Install as dev dependency: `npm i -D @tenonhq/dovetail-core`
2. Initialize configuration: `npx dove init`
3. Configure instance: `npx dove configure`
4. Set up manifest: `npx dove pull --scope x_cadso_core`
5. Start development: `npx dove watch` (watches all configured scopes)

### Managing Multiple Scopes

```bash
# Watch all scopes simultaneously
npx dove watch

# Work with specific scope
npx dove push --scope x_cadso_work

# Refresh specific scope
npx dove refresh --scope x_cadso_core
```

### Debugging Sync Issues

1. Check debug logs: `dovetail-debug-*.log`
2. Verify manifest: `npx dove status`
3. Test connection: `npx dove test-connection`
4. Review diffs: `npx dove diff`

### Handling Conflicts

- Use `npx dove diff` to review changes
- Back up before major operations
- Use `--force` flag carefully
- Maintain clean Git history

## Best Practices

### Development Workflow

1. **Pull First**: Always `npx dove refresh` before starting work
2. **Watch Mode**: Use `npx dove watch` during development
3. **Commit Often**: Regular Git commits for version control
4. **Test Locally**: Validate changes before pushing
5. **Document Changes**: Update manifests and documentation

### Performance Optimization

- Use selective scope watching
- Configure ignore patterns
- Optimize build plugins
- Cache ServiceNow responses

### Security Considerations

- Never commit credentials
- Use environment variables
- Rotate passwords regularly
- Limit scope permissions

## Troubleshooting

### Common Issues

1. **Authentication Failures**
   - Verify credentials in environment variables
   - Check instance URL format
   - Confirm user permissions

2. **Sync Conflicts**
   - Review `dove.manifest.json`
   - Check for concurrent edits
   - Use `npx dove diff` to investigate

3. **Build Errors**
   - Verify Node.js version (22 LTS)
   - Check plugin configurations
   - Review TypeScript settings

4. **Performance Issues**
   - Reduce watched scopes
   - Optimize build pipeline
   - Clear cache if needed

## Design Document

The comprehensive Dovetail design document lives at [`docs/dovetail-platform-spec.md`](docs/dovetail-platform-spec.md). It covers:

- **What Dovetail is** — Integration platform and Claude Code's action layer (not just a SN dev tool)
- **What we built** — Detailed breakdown of all 19 packages, APIs, and usage
- **What we intend to build** — Automated deployment pipeline, ATF test execution, app certification prep, cross-environment code movement
- **Design principles** — Package pattern, read+write with gates, npm-first distribution
- **Technical debt** — test coverage, typing gaps (Lerna removed + Node 22 done in Phase 0)

Read this before making architectural decisions or adding new packages.

## Notes

- **Version Requirement**: Node.js v22 LTS required
- **Instance Access**: Requires admin or developer role
- **Manifest Files**: Critical for tracking synchronization
- **Async Nature**: All operations are asynchronous
- **Rate Limiting**: Respect ServiceNow API limits