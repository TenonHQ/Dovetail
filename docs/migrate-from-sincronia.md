# Migrating from Sincronia to Dovetail

Sincronia has been renamed to Dovetail. The npm packages were republished under the `@tenonhq/dovetail-*` namespace, the CLI binary is now `dove`, and project artifacts (`sinc.config.js`, `sinc.manifest.json`, etc.) have been renamed to `dove.*` equivalents. Behavior is unchanged.

This guide explains how to migrate an existing Sincronia project. There is an automated tool that does most of the work for you.

## TL;DR

```bash
# 1. Install the new package as a devDependency
npm install --save-dev @tenonhq/dovetail-core

# 2. Run the migration tool (dry run first, then apply)
npx dove migrate
npx dove migrate --apply

# 3. (One time, per ServiceNow instance) re-import the renamed
#    Scripted REST API XML — see docs/dovetail-servicenow-migration.md
```

After step 2, your project's `sinc.*` files are renamed, your `package.json` scripts call `dove` instead of `sinc`, and `@tenonhq/sincronia-*` deps are bumped to their `@tenonhq/dovetail-*` equivalents. Run `npm install` to pull the new packages.

## What changes

| Before | After |
|---|---|
| `npm i -D @tenonhq/sincronia-core` | `npm i -D @tenonhq/dovetail-core` |
| `npx sinc <command>` | `npx dove <command>` |
| `sinc.config.js` | `dove.config.js` |
| `sinc.manifest.json` | `dove.manifest.json` |
| `sinc.manifest.<scope>.json` | `dove.manifest.<scope>.json` |
| `sinc.diff.manifest.json` | `dove.diff.manifest.json` |
| `.sinc-active-task.json` | `.dove-active-task.json` |
| `.sinc-update-sets.json` | `.dove-update-sets.json` |
| `.sinc-recent-edits.json` | `.dove-recent-edits.json` |
| `sincronia-debug-*.log` | `dovetail-debug-*.log` |
| `/api/cadso/claude/<op>` (ServiceNow API) | `/api/cadso/dovetail/<op>` |

Schemas are unchanged — only the filenames change.

## Backward compatibility window

Until the next major release of Dovetail:

- The `sinc` bin alias remains alongside `dove` and prints a one-line deprecation warning when invoked.
- The CLI accepts `sinc.config.js` if `dove.config.js` is not present, and similarly for the other `sinc.*` artifacts. A warning is logged.
- The `@tenonhq/sincronia-*` packages on npm have been published as deprecation shims that re-export from `@tenonhq/dovetail-*`.
- The Dovetail CLI requests `/api/cadso/dovetail/<op>` first; on 404 it retries against `/api/cadso/claude/<op>` and warns once.

The next major release removes the `sinc` aliases, drops the `sinc.*` filename fallbacks, and stops retrying the legacy `/api/cadso/claude/` API path. Run `dove migrate` and re-import the ServiceNow API XML before that release ships.

## Step-by-step

### 1. Update the npm dependency

```bash
npm install --save-dev @tenonhq/dovetail-core
```

If you depend on additional Dovetail packages directly (`@tenonhq/sincronia-types`, `@tenonhq/sincronia-clickup`, etc.), update each of them to the `@tenonhq/dovetail-*` equivalent. The migration tool does this automatically by rewriting `package.json`.

### 2. Run the migration tool

From your project root:

```bash
# Dry run — prints the plan, makes no changes
npx dove migrate

# Apply
npx dove migrate --apply
```

The tool:

- Renames `sinc.config.js` → `dove.config.js` if present
- Renames `sinc.manifest.json` → `dove.manifest.json`
- Renames every `sinc.manifest.<scope>.json` → `dove.manifest.<scope>.json`
- Renames `sinc.diff.manifest.json` → `dove.diff.manifest.json`
- Renames `.sinc-active-task.json`, `.sinc-update-sets.json`, `.sinc-recent-edits.json` → `.dove-*.json`
- Rewrites `package.json`: `@tenonhq/sincronia-*` deps → `@tenonhq/dovetail-*`, `sinc` script invocations → `dove`

If a `dove.*` file already exists alongside the legacy `sinc.*` file, that rename is skipped with a warning so you can resolve the conflict by hand.

### 3. Run `npm install`

If the migration tool updated `package.json`, install the new dependencies:

```bash
npm install
```

### 4. Update your scripts and editor configs

If you have shell scripts, CI definitions, IDE run configurations, or git hooks that invoke `npx sinc ...` outside of `package.json`, update them to call `npx dove ...`. The legacy `sinc` bin still works as a deprecated alias, but new automation should use `dove`.

### 5. Re-import the ServiceNow Scripted REST API XML

The server-side Scripted REST API was renamed from "Claude" (path `/api/cadso/claude/*`) to "Dovetail" (path `/api/cadso/dovetail/*`). Until you re-import the new XML on your ServiceNow instance, the Dovetail CLI will continue talking to the legacy `/api/cadso/claude/*` endpoints (with a one-time deprecation warning per session).

Detailed instructions: [docs/dovetail-servicenow-migration.md](dovetail-servicenow-migration.md).

## Verifying the migration

After applying:

```bash
# Should run cleanly with the new package
npx dove status

# Should resolve the renamed config + manifest files
npx dove watch
```

If you see deprecation warnings about `sinc.config.js` or `/api/cadso/claude/*`, the migration tool didn't touch one of the files (e.g. you had a `dove.*` sibling already) or the ServiceNow API hasn't been re-imported yet. Both are non-fatal during the deprecation window.

## Rolling back

If something breaks, both naming conventions still work simultaneously during the deprecation window. To roll back:

```bash
# Restore the legacy package
npm install --save-dev @tenonhq/sincronia-core@latest

# Rename the dove.* files back to sinc.*
mv dove.config.js sinc.config.js
mv dove.manifest.json sinc.manifest.json
# (and any other dove.* artifacts the tool created)
```

The legacy `@tenonhq/sincronia-core` package on npm is a shim that re-exports from `@tenonhq/dovetail-core`, so functionality stays the same — only the binary name (`sinc` vs `dove`) and filenames differ.

## Reporting issues

If `dove migrate` fails or leaves the project in an unexpected state, file an issue at https://github.com/tenonhq/dovetail/issues with:

- The command you ran (`npx dove migrate` vs `npx dove migrate --apply`)
- The full output of the command
- A directory listing of the project root before and after

The migration tool is intentionally narrow in scope — it does not touch source code, only project-root artifacts and `package.json`.
