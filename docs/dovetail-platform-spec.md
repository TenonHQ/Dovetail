# Dovetail: Complete Platform Specification

> **Purpose:** This document describes Dovetail in enough detail that a software engineer or AI agent with zero prior context could implement the full system from scratch.
>
> **Audience:** Claude Code agents, developers onboarding to the project, or anyone building a compatible implementation.
>
> **Last updated:** 2026-04-08

---

## Table of Contents

1. [What Dovetail Is](#1-what-dovetail-is)
2. [Architecture Overview](#2-architecture-overview)
3. [Type System](#3-type-system)
4. [The Init System](#4-the-init-system)
5. [Configuration System](#5-configuration-system)
6. [ServiceNow REST API Contract](#6-servicenow-rest-api-contract)
7. [Build Pipeline](#7-build-pipeline)
8. [Sync Mechanism](#8-sync-mechanism)
9. [CLI Command Reference](#9-cli-command-reference)
10. [Integration Packages](#10-integration-packages)
11. [Design Principles](#11-design-principles)
12. [Current State vs. Roadmap](#12-current-state-vs-roadmap)
13. [Appendices](#13-appendices)

---

## 1. What Dovetail Is

### The Problem

ServiceNow stores application code (scripts, styles, UI components) inside database records. Developers edit code through a browser-based IDE (Studio) that lacks Git, TypeScript, linting, modern bundling, or any of the tooling a professional JavaScript developer expects. This makes ServiceNow development slow, error-prone, and disconnected from modern engineering practices.

### The Solution

Dovetail is a bidirectional synchronization tool that lets developers:

1. **Write code locally** using any editor, with full access to Git, TypeScript, Babel, Webpack, SASS, ESLint, and Prettier
2. **Build code through a configurable plugin pipeline** before it reaches ServiceNow (e.g., TypeScript compilation, import/export stripping for ServiceNow's Rhino engine)
3. **Push transformed code to ServiceNow** via REST API, with update set tracking and multi-scope support
4. **Pull code from ServiceNow** to establish or refresh the local file tree

The key insight is **asymmetric source code**: the code developers write (TypeScript with imports) is not the code that runs on ServiceNow (plain JavaScript with no modules). Dovetail manages this transformation transparently.

### Dual Purpose

Dovetail has evolved beyond a dev tool. It now serves two roles:

1. **Developer tool** — The `dove` CLI for ServiceNow file synchronization, build pipelines, update set management, and record CRUD
2. **Integration platform** — A collection of npm packages (`@tenonhq/dovetail-*`) that give Claude Code programmatic access to external systems: ServiceNow, ClickUp, Gmail, Google Calendar. Each package wraps one external service with typed clients, API methods, and LLM-friendly formatters.

### Monorepo Structure

Dovetail is a **Lerna monorepo** with **19 packages** published under the `@tenonhq/dovetail-*` npm scope. The CLI binary is `dove`, shipped from `@tenonhq/dovetail-core`.

**Runtime requirements:** Node.js 20 LTS, npm workspaces.

---

## 2. Architecture Overview

### 2.1 Package Taxonomy

Dovetail's 19 packages fall into four categories:

#### Core Layer

| Package | Purpose |
|---|---|
| `dovetail-core` | CLI engine, command routing, file watching, sync orchestration, plugin discovery. Ships the `dove` binary. |
| `dovetail-types` | TypeScript type definitions (`Sinc.*` and `SN.*` namespaces). No runtime code. |
| `dovetail-schema` | Fetches ServiceNow table schemas via REST API, organizes by application/scope, outputs JSON. |

#### Build Pipeline Plugins

Each plugin transforms source code before it's pushed to ServiceNow. All follow the same interface: `run(context, content, options) => Promise<PluginResults>`.

| Package | What It Does |
|---|---|
| `dovetail-typescript-plugin` | TypeScript type-checking and transpilation. Reads `tsconfig.json`. |
| `dovetail-babel-plugin` | Babel transformation wrapper. Applies user-configured Babel transforms. |
| `dovetail-babel-plugin-remove-modules` | Strips `import`/`export` statements for ServiceNow's Rhino engine. Preserves `@keepModule` tagged imports. Converts `export default` to raw declarations. |
| `dovetail-babel-preset-servicenow` | Babel preset that wraps `babel-plugin-remove-modules`. Single entry point for ServiceNow code sanitization. |
| `dovetail-webpack-plugin` | Webpack module bundling. Uses in-memory filesystem. Outputs single `bundle.js`. |
| `dovetail-sass-plugin` | SASS/SCSS compilation to CSS. |
| `dovetail-eslint-plugin` | ESLint linting. Fails build if errors found. Does not transform code. |
| `dovetail-prettier-plugin` | Prettier formatting. Resolves `.prettierrc` from file location. |

#### Integration Packages

Each wraps one external service with typed clients, API methods, and formatters.

| Package | Service | Auth |
|---|---|---|
| `dovetail-clickup` | ClickUp API v2 (tasks, comments, workspaces) | `CLICKUP_API_TOKEN` |
| `dovetail-google-auth` | Shared Google OAuth2 layer | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| `dovetail-gmail` | Gmail API (read, search, triage, archive) | Peer dep on `google-auth` |
| `dovetail-google-calendar` | Google Calendar API (events, agenda) | Peer dep on `google-auth` |

#### UI

| Package | Purpose |
|---|---|
| `dovetail-dashboard` | Express.js web UI for update set management with ClickUp task integration. Port 3456 by default. Launched by `dove dashboard` or embedded in `dove watch`. |

#### Platform Helpers & Action Layer

| Package | Purpose |
|---|---|
| `dovetail-servicenow` | ServiceNow platform helpers using the Dovetail Scripted REST API. Includes `addChoicesToField` (sys_choice + sys_dictionary upsert, update-set-aware) and the `buildFlow` CLI Phase 1 (`dove-sn` binary) for Custom Action Type + Subflow authoring. |
| `dovetail-sawmill` | Sawmill REST client — retrieve, preview, and commit update sets across instances. Powers cross-environment code movement. |
| `dovetail-mcp` | MCP stdio server (read-mostly) exposing 16 tools wrapping ClickUp, Gmail, Calendar, and ServiceNow reads, plus 4 ClickUp writes gated by `SINC_MCP_WRITES_ENABLE=1`. Telemetry written to `~/.dovetail-mcp/telemetry.jsonl` (redacted). Full catalog: [`claude-operating-guide.md`](claude-operating-guide.md). |

### 2.2 Dependency Graph

```
                    dovetail-types
                         |
           +-------------+------------------+
           |             |                   |
     dovetail-core  [all plugins]   [integrations]
           |                                |
     +-----+-----+              +----------+----------+
     |           |              |          |           |
  schema    clickup      google-auth   gmail      calendar
     |           |              |          |           |
     |      (runtime)     (standalone)  (peer)      (peer)
     |           |              +-----+----+           |
     |           |                    +----------------+
     |           |
  dashboard -----+ (standalone, no dovetail deps)
```

**Rules:** No circular dependencies. Google packages share auth via peer dependency. Plugins are fully independent of each other. Dashboard has no dovetail package dependencies (standalone Express app).

### 2.3 Package Pattern

Every integration package follows this structure:

```
packages/{name}/
  src/
    types.ts        # Type definitions
    client.ts       # API client factory + methods
    formatter.ts    # Output formatters (markdown, LLM-friendly)
    index.ts        # Public exports (re-exports from above)
  package.json
  tsconfig.json
  README.md
```

Build plugins follow a simpler pattern:

```
packages/{name}/
  src/
    index.ts        # Exports { run: PluginFunc }
  package.json
  tsconfig.json
```

Init-capable packages additionally export `{ sincPlugin: InitPlugin }` from their index.

### 2.4 Entry Point Chain

```
index.ts (shebang: #!/usr/bin/env node)
  -> main()
    -> bootstrap.ts: init()
      -> config.ts: loadConfigs()        # Find dove.config.js, load manifest, set paths
      -> dotenv: load .env               # Credentials into process.env
      -> commander.ts: initCommands()    # Register all yargs commands
        -> yargs parses argv
          -> commands.ts / specific command handler
```

### 2.5 Monorepo Tooling

| Aspect | Value |
|---|---|
| Package manager | Lerna 0.4.2-alpha.6 + npm workspaces |
| Build target | TypeScript ES2022, strict mode |
| Node requirement | 20 LTS (engines field) |
| Publishing | Public npm under `@tenonhq` scope |
| Versioning | Independent per-package |
| CI | Azure Pipelines (build/test) + GitHub Actions (CodeQL, PR-ClickUp sync) |

---

## 3. Type System

The `@tenonhq/dovetail-types` package (`packages/types/index.d.ts`) defines all shared interfaces. These are the load-bearing contracts. Every package depends on them.

### 3.1 Sinc Namespace (Framework Types)

```typescript
export namespace Sinc {

  // === Command Arguments ===

  interface SharedCmdArgs {
    logLevel: string;
  }

  interface CmdDownloadArgs extends SharedCmdArgs {
    scope: string;
  }

  interface PushCmdArgs extends SharedCmdArgs {
    target?: string;
    diff: string;
    scopeSwap: boolean;
    updateSet: string;
    ci: boolean;
  }

  interface BuildCmdArgs extends SharedCmdArgs {
    diff: string;
  }

  interface WatchCmdArgs extends SharedCmdArgs {
    noDashboard: boolean;
    port?: number;
  }

  // === Configuration ===

  interface Config {
    sourceDirectory: string;
    buildDirectory: string;
    rules?: PluginRule[];
    includes?: TablePropMap;
    excludes?: TablePropMap;
    tableOptions: ITableOptionsMap;
    refreshInterval: number;
  }

  interface ScopedConfigsMap {
    [scope: string]: Config;
  }

  interface ScopedConfig extends Config {
    scopes?: ScopedConfigsMap;
  }

  interface ITableOptionsMap {
    [table: string]: ITableOptions;
  }

  interface ITableOptions {
    displayField?: string;
    differentiatorField?: string | string[];
    query: string;
  }

  interface FieldConfig {
    type: SN.FileType;
  }

  interface FieldMap {
    [fieldName: string]: FieldConfig;
  }

  interface TablePropMap {
    [key: string]: boolean | FieldMap | string[] | { [scope: string]: any };
  }

  // === Plugin System (Build Pipeline) ===

  interface PluginRule {
    match: RegExp;
    plugins: PluginConfig[];
  }

  interface PluginConfig {
    name: string;
    options: { [property: string]: any };
  }

  interface Plugin {
    run: PluginFunc;
  }

  interface PluginFunc {
    (context: FileContext, content: string, options: any): Promise<PluginResults>;
  }

  interface PluginResults {
    success: boolean;
    output: string;
  }

  type TransformResults = {
    success: boolean;
    content: string;
  };

  // === File Context (Unit of Work) ===

  interface FileSyncParams {
    filePath: string;
    name: string;
    tableName: string;
    targetField: string;
    ext: string;
  }

  interface FileContext extends FileSyncParams {
    sys_id: string;
    scope: string;
    fileContents?: string;
  }

  // === Init Plugin System ===

  interface InitPlugin {
    name: string;
    displayName: string;
    description: string;
    login?: InitLoginHook[];
    configure?: InitConfigureHook[];
    initialize?: (context: InitContext) => Promise<void>;
  }

  interface InitLoginHook {
    envKey: string;
    prompt: {
      type: "input" | "password";
      message: string;
      mask?: string;
    };
    validate?: (value: string, context: InitContext) => Promise<true | string>;
    instructions?: string[];
    required?: boolean;
  }

  interface InitConfigureHook {
    key: string;
    label: string;
    run: (context: InitContext) => Promise<any>;
  }

  interface InitContext {
    env: Record<string, string>;
    answers: Record<string, any>;
    rootDir: string;
    hasConfig: boolean;
    inquirer: any;
    chalk: any;
  }

  // === Push/Build Results ===

  interface PushResult {
    success: boolean;
    message: string;
  }

  interface BuildResult extends PushResult {}

  interface BuildRecord {
    result: Sinc.PromiseResult<Record<string, string>>;
    summary: string;
    context: Sinc.FileContext;
  }

  interface BuildableRecord {
    table: string;
    sysId: string;
    fields: Record<string, Sinc.FileContext>;
  }

  interface RecBuildFail {
    success: false;
    message: string;
  }

  interface RecBuildSuccess {
    success: true;
    builtRec: Record<string, string>;
  }

  type RecBuildRes = RecBuildFail | RecBuildSuccess;

  // === Utilities ===

  interface ServerRequestConfig {
    url: string;
    data: string;
    method: string;
  }

  interface LoginAnswers {
    instance: string;
    username: string;
    password: string;
  }

  interface AppSelectionAnswer {
    app: string;
  }

  interface DiffFile {
    changed: Array<string>;
  }

  type RecordContextMap = Record<string, FileContext>;
  type TableContextTree = Record<string, RecordContextMap>;
  type AppFileContextTree = Record<string, TableContextTree>;

  type SuccessPromiseResult<T> = { status: "fulfilled"; value: T };
  type FailPromiseResult = { status: "rejected"; reason: any };
  type PromiseResult<T> = SuccessPromiseResult<T> | FailPromiseResult;

  interface SNAPIResponse<T> {
    result: T;
  }
}
```

### 3.2 SN Namespace (ServiceNow Types)

```typescript
export namespace SN {

  // === Manifest Structure ===

  interface AppManifest {
    tables: TableMap;
    scope: string;
  }

  interface TableMap {
    [tableName: string]: TableConfig;
  }

  interface TableConfig {
    records: TableConfigRecords;
  }

  interface TableConfigRecords {
    [name: string]: MetaRecord;
  }

  interface MetaRecord {
    files: File[];
    name: string;
    sys_id: string;
  }

  interface File {
    name: string;
    type: FileType;
    content?: string;
  }

  interface Field {
    name: string;
    type: string;
  }

  interface Record {
    sys_id: string;
  }

  interface TableAPIResult {
    result: Record[];
  }

  type FileType = "js" | "css" | "xml" | "html" | "scss" | "txt" | "json";

  interface TypeMap {
    [type: string]: string;
  }

  // === Bulk Download ===

  interface MissingFileTableMap {
    [tableName: string]: MissingFileRecord;
  }

  interface MissingFileRecord {
    [sys_id: string]: File[];
  }

  // === ServiceNow Entities ===

  interface ScopeObj {
    scope: string;
    sys_id: string;
  }

  interface App {
    scope: string;
    displayName: string;
    sys_id: string;
  }

  interface UserRecord { sys_id: string; }
  interface UserPrefRecord { sys_id: string; }
  interface ScopeRecord { sys_id: string; }
  interface UpdateSetRecord { sys_id: string; }
}

export type TSFIXME = any;
```

---

## 4. The Init System

The init system bootstraps a new Dovetail project through an 8-phase interactive wizard. It is plugin-driven: each installed `@tenonhq/dovetail-*` package can hook into the init flow.

### 4.1 Two Entry Points

| Command | Purpose |
|---|---|
| `dove init` | Full 8-phase setup wizard (plugin discovery, login, config, download) |
| `dove login [plugin]` | Credential-only flow. Supports `--instance`, `--user`, `--password` for non-interactive mode. |

Both share the same plugin infrastructure defined in `packages/core/src/initSystem/`.

### 4.2 Plugin Discovery (`discovery.ts`)

The `discoverPlugins()` function scans the filesystem for init-capable packages:

**Search locations (in order):**
1. `./node_modules/@tenonhq/` (current project)
2. `../../node_modules/@tenonhq/` (monorepo hoisted)
3. Parent directories up to 3 levels (capped traversal)

**Discovery criteria:**
- Directory name starts with `dovetail-`
- Skips: `dovetail-core`, `dovetail-types`, `dovetail-dashboard`, `dovetail-schema`
- Package must `require()` successfully
- Must export `pkg.sincPlugin` object with `.name` and `.displayName` properties

**Returns:** `Sinc.InitPlugin[]` — array of discovered external plugins.

### 4.3 Init Flow (8 Phases)

Orchestrated by `runInit()` in `packages/core/src/initSystem/orchestrator.ts`.

#### Phase 1: Banner + Plugin Discovery

```
1. Print "Dovetail Setup" header
2. Call discoverPlugins()
3. List detected packages (core is always present)
```

#### Phase 2: Plugin Selection

```
1. If external plugins found: show checkbox prompt (inquirer)
   - Each choice shows: displayName + " — " + description
   - None checked by default
2. Core plugin is ALWAYS included (not a choice — automatic)
3. Returns: [corePlugin, ...selectedExternalPlugins]
```

#### Phase 3: Build InitContext

```typescript
function buildInitContext(plugins: Sinc.InitPlugin[]): Sinc.InitContext {
  // 1. Set rootDir to process.cwd()
  // 2. Read existing .env via dotenv.parse (if exists)
  // 3. For each env key declared by plugins' login hooks:
  //    - If key exists in process.env but NOT in .env, copy it over
  //    - (This allows CI/CD to pass credentials via environment)
  // 4. Check if dove.config.js exists in rootDir
  // 5. Return { env, answers: {}, rootDir, hasConfig, inquirer, chalk }
}
```

**Key behavior:** The context only inherits process.env values for keys that plugins explicitly declare. No hardcoded allowlist.

#### Phase 4: Login Phase

For each selected plugin, calls `runLoginPhase(plugin, context)`.

**Core plugin (retry loop):**
```
1. collectLoginHooks() — prompts for SN_INSTANCE, SN_USER, SN_PASSWORD
   - Shows instructions if hook provides them
   - Non-password fields show existing value as default
   - Required fields validated for non-empty
2. Run per-hook validation (if hook.validate defined)
   - On failure: show error, prompt "Try again?", clear password, restart
3. validateCoreLogin(context):
   - Normalize instance URL (strip https://, trailing slashes)
   - Create snClient with credentials
   - Call client.getAppList() to test connection
   - Returns true or specific error message:
     - ENOTFOUND: "Could not resolve instance URL"
     - 401/403: "Authentication failed — check username and password"
     - ECONNREFUSED: "Connection refused"
     - Other: raw error message
4. On success: print "Connected to {instance}", return
5. On failure: show error, prompt "Try again?"
   - If no: throw "Login cancelled"
   - If yes: clear password, loop back to step 1
```

**Non-core plugins (no retry):**
```
1. collectLoginHooks() — prompts for plugin-specific env keys
2. Run per-hook validation
3. On failure: throw "Validation failed for {envKey}"
```

#### Phase 5: Save .env

```
1. Collect all env keys declared by plugins (login hooks + configure hooks)
2. Filter to only keys that have values in context.env
3. writeEnvVars(): merge-write to .env file
   - Uses regex-based line replacement (preserves existing values for other keys)
   - Never destructive — only adds/updates declared keys
4. Set process.env for immediate use in subsequent phases
```

#### Phase 6: Config Phase

```
1. If dove.config.js exists:
   - Prompt: "Use current config" or "Update config"
   - If "keep": return (no changes)
2. If updating or no config:
   - Currently a stub: prints "Coming soon" message
   - Future: wizard for scopes, tables, fields, special scope tables/fields
```

#### Phase 7: Configure Phase

For each selected plugin, runs its `configure` hooks.

**Core plugin configure hook:**
```
1. Create snClient with credentials from context.env
2. Call client.getAppList() — returns SN.App[]
3. Show inquirer list prompt with available scoped apps
4. Store selected scope in context.answers.selectedScope
5. Store full app list in context.answers.apps
```

**External plugin configure hooks:** Each hook's `run(context)` is called. Return value stored in `context.answers[hook.key]`.

#### Phase 8: Initialize Phase

For each selected plugin, calls `plugin.initialize(context)` if defined.

**Core plugin initialize:**
```
1. Write dove.config.js (if doesn't exist):
   - Uses ConfigManager.getDefaultConfigFile() template
   - If exists: preserves current config
2. Reload configs via ConfigManager.loadConfigs()
3. Check for existing manifest (dove.manifest.{scope}.json):
   - If exists: prompt "Re-download files?"
   - If user says no: skip download, return
4. Download application files:
   a. Create snClient with credentials
   b. Call client.getManifest(scope, config, withFiles=true)
   c. normalizeManifestKeys() — re-key records by display name (handles duplicates)
   d. processManifest() — write files to disk:
      - For each table in manifest:
        - For each record in table:
          - Create directory: src/{table}/{record_name}/
          - For each file in record:
            - Write file: src/{table}/{record_name}/{field_name}.{type}
          - Write metaData.json with timestamps
      - Strip content from manifest (keep structure only)
      - Write dove.manifest.{scope}.json
5. Print summary: "{N} tables, {M} records downloaded"
```

**Error handling:** If a plugin's `initialize()` throws, the error is logged but init continues with remaining plugins. The summary reports "completed with errors".

#### Phase 9: Summary

```
1. If any plugin failed: "Setup completed with errors. Review the output above."
2. If all succeeded: "Setup complete! Run dove watch to start."
```

### 4.4 Login Flow (`runLogin`)

The `dove login` command supports targeted and non-interactive login:

**Flags:**
| Flag | Purpose |
|---|---|
| `[plugin]` | Plugin name to login to. Core aliases: "core", "servicenow", "sn" |
| `--all` | Login to all detected integrations |
| `--instance` | ServiceNow instance URL (non-interactive) |
| `--user` | ServiceNow username (non-interactive) |
| `--password` | ServiceNow password (non-interactive) |

**Non-interactive mode:** If `--instance`, `--user`, and `--password` are all provided and only core is being logged in, skip prompts entirely — validate directly and save.

### 4.5 Core Plugin Definition (`corePlugin.ts`)

```typescript
const corePlugin: Sinc.InitPlugin = {
  name: "core",
  displayName: "ServiceNow",
  description: "Connect to your ServiceNow instance",
  login: [
    {
      envKey: "SN_INSTANCE",
      prompt: { type: "input", message: "ServiceNow instance (e.g., mycompany.service-now.com):" },
      required: true,
    },
    {
      envKey: "SN_USER",
      prompt: { type: "input", message: "Username:" },
      required: true,
    },
    {
      envKey: "SN_PASSWORD",
      prompt: { type: "password", message: "Password:", mask: "*" },
      required: true,
    },
  ],
  configure: [
    {
      key: "selectedScope",
      label: "Select application scope",
      run: async (context) => {
        // Fetch app list, show picker, return selected scope
      },
    },
  ],
  initialize: async (context) => {
    // Write config, download manifest, write files
  },
};
```

### 4.6 Writing a New Init Plugin

To make any `@tenonhq/dovetail-*` package discoverable by `dove init`:

1. Export `sincPlugin: Sinc.InitPlugin` from the package's index
2. Define `login` hooks with `envKey` (the env var to store) and `prompt` config
3. Optionally define `configure` hooks for post-login configuration
4. Optionally define `initialize(context)` for file/config setup
5. Install the package in the user's project: `npm i -D @tenonhq/dovetail-{name}`
6. Run `dove init` — it will be auto-discovered

---

## 5. Configuration System

### 5.1 Design Principle

**`dove.config.js` is the single source of truth.** There are no hidden defaults.

The file `defaultOptions.ts` exports empty objects — this is intentional. It was cleared during a config overhaul. Do not add defaults back. All configuration must be explicit in `dove.config.js`.

### 5.2 Config Shape

```typescript
// Sinc.ScopedConfig (extends Sinc.Config)
module.exports = {
  sourceDirectory: "src",           // Where local source files live
  buildDirectory: "build",          // Where built files go (for dove build)
  refreshInterval: 30,              // Seconds between manifest refresh cycles

  rules: [                          // Build pipeline rules (first match wins)
    {
      match: /\.ts$/,               // Regex matched against file path
      plugins: [
        { name: "@tenonhq/dovetail-typescript-plugin", options: { transpile: true } },
        { name: "@tenonhq/dovetail-babel-plugin", options: {} },
      ]
    },
    {
      match: /\.scss$/,
      plugins: [
        { name: "@tenonhq/dovetail-sass-plugin", options: {} },
      ]
    }
  ],

  includes: {
    // _tables directive: whitelist of tables to sync (only these get written to disk)
    _tables: [
      "sys_script_include",
      "sys_script",
      "sys_ui_script",
      "sys_ui_page",
      "sys_ux_client_script",
      "sys_processor",
      "sys_ws_operation",
      "sys_rest_message_fn",
      "sys_ui_action",
      "sys_security_acl",
      "sysevent_script_action",
      "sys_ux_macroponent",
      "sys_ux_event",
      "sys_ux_client_script_include",
      "sys_ux_screen",
      "sys_script_fix",
    ],

    // Non-prefixed keys: table names with field type overrides
    sys_ux_macroponent: {
      composition: { type: "json" },   // Override field type (default would be "js")
    },

    // _scopes directive: per-scope table overrides
    _scopes: {
      x_cadso_automate: {
        _tables: ["x_cadso_core_setting"],  // Additional tables for this scope only
      }
    }
  },

  excludes: {
    _tables: [],                    // Explicit exclusion list
  },

  tableOptions: {                   // Per-table query/display settings
    sys_script_include: {
      displayField: "name",
      differentiatorField: "sys_id",
      query: "active=true",
    }
  },

  scopes: {                         // Multi-scope support
    x_cadso_core: { sourceDirectory: "src/x_cadso_core" },
    x_cadso_work: { sourceDirectory: "src/x_cadso_work" },
    x_cadso_automate: { sourceDirectory: "src/x_cadso_automate" },
  },
};
```

### 5.3 Directive Convention

Keys starting with `_` are **config directives**, not table names:

| Directive | Location | Purpose |
|---|---|---|
| `includes._tables` | Top-level includes | Whitelist of tables to sync. Only these tables get written to disk. ServiceNow returns all tables in a scope — client-side filtering enforces this whitelist. |
| `includes._scopes` | Top-level includes | Per-scope overrides. Each scope key can have its own `_tables` (additional tables) and field type overrides. |
| `excludes._tables` | Top-level excludes | Explicit exclusion list. Tables here are never synced even if in `_tables`. |

Non-`_` keys in `includes` are table names with field type overrides. Tables with field overrides are implicitly added to the whitelist.

### 5.4 Config Resolution for a Scope

When resolving config for scope `x_cadso_automate`:

1. Start with global `_tables` whitelist
2. Union with scope-specific `_tables` from `includes._scopes.x_cadso_automate._tables`
3. Deep merge field overrides (scope-specific wins on conflict)
4. Remove any tables in `excludes._tables`
5. Tables with explicit field overrides are implicitly included
6. Result: `{ tables, fieldOverrides, apiIncludes, apiExcludes }`

### 5.5 Config Loading (`config.ts`)

`loadConfigs()` runs at bootstrap:

1. Search up directory tree for `dove.config.js` (current dir, then parent dirs)
2. Load via dynamic `import()` (supports ES module config)
3. Set module-level state: source path, build path, manifest paths
4. Load manifest file(s): `dove.manifest.json` (single-scope) or `dove.manifest.{scope}.json` (multi-scope)
5. Resolve `.env` path relative to config location

### 5.6 Multi-Scope Support

The `scopes` key in config maps scope names to per-scope configuration with at minimum `sourceDirectory`. Each scope gets:

- Its own source directory: `src/{scope_name}/`
- Its own manifest file: `dove.manifest.{scope}.json`
- Its own update set tracking
- Independent table whitelist (union of global + scope-specific `_tables`)

### 5.7 Default Config Template

Generated by `getDefaultConfigFile()` when `dove init` creates a new project:

```javascript
module.exports = {
  sourceDirectory: "src",
  buildDirectory: "build",
  rules: [],
  excludes: {},
  includes: {},
  tableOptions: {},
  refreshInterval: 30,
};
```

---

## 6. ServiceNow REST API Contract

Dovetail communicates with ServiceNow through two REST APIs: a custom Dovetail-specific API and a custom "Claude" API for update set operations.

### 6.1 Dovetail Scripted REST API (`/api/cadso/dovetail/`)

Custom endpoints installed on the ServiceNow instance, scoped to the Dovetail application.

| Method | Endpoint | Request | Response | Purpose |
|---|---|---|---|---|
| GET | `/getAppList` | — | `{ result: SN.App[] }` | List available scoped applications |
| POST | `/getManifest/{scope}` | `{ includes, excludes, tableOptions, withFiles }` | `{ result: SN.AppManifest }` | Download file tree for a scope. `withFiles=true` includes file content. |
| POST | `/bulkDownload` | `{ missingFiles: SN.MissingFileTableMap, tableOptions }` | `{ result: SN.TableMap }` | Download specific missing files (used by refresh) |
| GET | `/getCurrentScope` | — | `{ result: SN.ScopeObj }` | Get current application scope |
| POST | `/pushATFfile` | `{ sys_id, content }` | `{ result: ... }` | Push ATF test file content |

### 6.2 Claude Scripted REST API (`/api/cadso/claude/`)

Global-scoped endpoints for update set and record management.

| Method | Endpoint | Params/Body | Purpose |
|---|---|---|---|
| GET | `/changeScope` | Query: `scope` (scope name, e.g., `x_cadso_core`) | Switch application scope on instance |
| GET | `/currentUpdateSet` | Query: `scope` (optional — temporarily switches scope before reading) | Get active update set |
| GET | `/changeUpdateSet` | Query: `sysId` (direct) OR `name` + `scope` (lookup by name, most recent in-progress) | Switch active update set |
| POST | `/pushWithUpdateSet` | Body: `{ update_set_sys_id, table, record_sys_id, fields }` | Update a record within a specified update set. Saves/restores previous update set. |
| POST | `/createRecord` | Body: `{ table, fields }` (required), `{ sys_id, scope, update_set_sys_id }` (optional) | Create new record. Supports explicit `sys_id` for cross-instance moves. |
| POST | `/deleteRecord` | Body: `{ table, sys_id }` | Delete record. Returns display name on success. |

**Notes:**
- All POST endpoints accept and return `application/json`
- Update set operations save and restore the previous update set to avoid side effects
- Web service definition sys_id: `b8a9db8d33d7a6107b18bc534d5c7b7b`
- Auth: requires authentication + `snc_internal_role`

### 6.3 Standard Table API

Dovetail also uses ServiceNow's built-in Table API for supporting operations:

| Purpose | Method | Endpoint |
|---|---|---|
| Update record field | PATCH | `/api/now/table/{table}/{sys_id}` |
| List update sets | GET | `/api/now/table/sys_update_set?sysparm_query=state=in progress` |
| Create update set | POST | `/api/now/table/sys_update_set` |
| Lookup scope sys_id | GET | `/api/now/table/sys_scope?sysparm_query=scope={name}` |
| Lookup user sys_id | GET | `/api/now/table/sys_user?sysparm_query=user_name={name}` |

### 6.4 HTTP Client (`snClient.ts`)

The ServiceNow REST client is built on Axios with these features:

| Feature | Detail |
|---|---|
| Authentication | Basic auth (username/password) |
| Session management | Cookie jar support (persistent session across requests) |
| Rate limiting | 20 requests per second maximum |
| Retry logic | 3 retries, 3 seconds between attempts |
| Base URL | `https://{instance}.service-now.com/` |
| Response format | All responses wrapped in `{ result: T }` |

**Instance normalization:** Strips `https://`, `http://`, trailing slashes, and `.service-now.com` suffix. Only the instance name is stored (e.g., `mycompany`). The full URL is reconstructed at request time.

---

## 7. Build Pipeline

### 7.1 How It Works

When a file is pushed to ServiceNow (via `dove push` or `dove watch`), it passes through a configurable plugin pipeline before reaching the instance:

1. **Match:** The file path is tested against `rules` in `dove.config.js`. First matching rule wins.
2. **Execute:** Plugins in the matched rule execute sequentially. Output of one becomes input of the next.
3. **Push:** Final output is sent to ServiceNow via REST API.

If no rule matches, the file is pushed as-is (no transformation).

### 7.2 PluginManager

The `PluginManager` (singleton) handles plugin loading and execution:

- `determinePlugins(filePath)` — matches file path against rules, returns `PluginConfig[]`
- `runPlugins(fileContext, content)` — loads each plugin from `node_modules/{name}` via dynamic import, calls `plugin.run(context, content, options)` sequentially
- Plugins are loaded lazily (first use) and cached

### 7.3 Plugin Interface

Every build plugin exports:

```typescript
export async function run(
  context: Sinc.FileContext,  // File metadata: path, table, field, sys_id, scope
  content: string,            // File content (or output of previous plugin)
  options: any                // Plugin-specific options from dove.config.js
): Promise<Sinc.PluginResults> {
  return {
    success: boolean,  // false = build failure, file not pushed
    output: string,    // Transformed content (input for next plugin or final push)
  };
}
```

### 7.4 Typical Pipeline

```
Source (.ts)  ->  TypeScript Plugin  ->  Babel Plugin  ->  Remove Modules  ->  Output (.js)  ->  ServiceNow
Source (.scss) ->  SASS Plugin  ->  Output (.css)  ->  ServiceNow
Source (.js)  ->  (no rules match)  ->  Push as-is  ->  ServiceNow
```

### 7.5 What Each Plugin Does

| Plugin | Input | Output | Failure Condition |
|---|---|---|---|
| **typescript-plugin** | `.ts` file | Transpiled `.js` (if `transpile: true`) or type-checked `.ts` | Type errors |
| **babel-plugin** | `.js`/`.jsx` file | Babel-transformed `.js` | Babel transform error |
| **babel-plugin-remove-modules** | `.js` with imports/exports | `.js` with imports/exports stripped. `export default` becomes raw declaration. `@keepModule` comment preserves specific imports. | Parse error |
| **babel-preset-servicenow** | `.js` file | ServiceNow-compatible `.js` (wraps remove-modules as preset) | Parse error |
| **webpack-plugin** | `.js` with module imports | Single bundled `.js` via in-memory webpack. Accepts `webpackConfig`, `configGenerator`, or auto-loads `webpack.config.js`. | Webpack build error |
| **sass-plugin** | `.scss`/`.sass` file | Compiled `.css` | SASS compilation error |
| **eslint-plugin** | Any `.js`/`.ts` file | Unchanged source (lint is validation-only) | Any ESLint errors |
| **prettier-plugin** | Any file | Formatted source. Resolves `.prettierrc` from file location. | Prettier error |

---

## 8. Sync Mechanism

### 8.1 Manifest System

The manifest is the bridge between local file paths and ServiceNow records. It maps `table/record/field` to `sys_id`.

**File:** `dove.manifest.{scope}.json` (or `dove.manifest.json` for single-scope)

**Structure:**

```json
{
  "tables": {
    "sys_script_include": {
      "records": {
        "MyScriptInclude": {
          "sys_id": "abc123def456...",
          "name": "MyScriptInclude",
          "files": [
            { "name": "script", "type": "js" }
          ]
        }
      }
    }
  },
  "scope": "x_cadso_core"
}
```

**Key property:** The manifest stores structure only (no file content). Content is stripped after download and lives only in local files.

### 8.2 File Structure on Disk

After `dove init` or `dove download`, local files are organized as:

```
project_root/
  dove.config.js
  dove.manifest.x_cadso_core.json
  dove.manifest.x_cadso_work.json
  .env                              # credentials (git-ignored)
  src/
    x_cadso_core/                   # sourceDirectory from scopes config
      sys_script_include/
        MyScriptInclude/
          script.ts                 # field content (source version)
          metaData.json             # record metadata + timestamps
        AnotherScript/
          script.ts
      sys_ui_page/
        MyPage/
          html.html
          client_script.js
          processing_script.js
      sys_ux_macroponent/
        MyComponent/
          composition.json
    x_cadso_work/
      sys_script_include/
        WorkHelper/
          script.ts
  build/                            # generated by dove build
    x_cadso_core/
      sys_script_include/
        MyScriptInclude/
          script.js                 # transformed version
```

### 8.3 Download Flow (`dove download <scope>`)

```
1. Resolve config for scope (whitelist, field overrides, table options)
2. Call client.getManifest(scope, config, withFiles=true)
   - ServiceNow returns ALL tables in scope
   - Client-side filtering: keep only _tables whitelist entries
3. normalizeManifestKeys()
   - Re-key records by display name instead of sys_id
   - Handle duplicate names (append suffix)
4. processManifest()
   - For each table in manifest:
     - For each record in table:
       - Create directory: src/{scope}/{table}/{record_name}/
       - For each file in record:
         - Write file: src/{scope}/{table}/{record_name}/{field_name}.{type}
       - Write metaData.json
   - Uses progress bar for visual feedback
5. Strip content from manifest (keep structure, remove file contents)
6. Write dove.manifest.{scope}.json
7. Print summary: "{N} tables, {M} records"
```

### 8.4 Refresh Flow (`dove refresh`)

Refresh is an incremental download — only fetches files that are missing locally.

```
1. Call client.getManifest(scope, config, withFiles=false)
   - Structure only, no file content
2. findMissingFiles()
   - Compare manifest against local disk
   - Build MissingFileTableMap of files that exist in manifest but not on disk
3. If missing files found:
   - Call client.bulkDownload(missingFiles, tableOptions)
   - Write new files to disk
   - Update manifest
4. If no missing files: "Everything is up to date"
```

### 8.5 Push Flow (`dove push`)

```
1. Determine files to push:
   - Default: all files in source directory
   - With --diff <branch>: only files changed vs. that branch (git diff)
2. For each file, resolve FileContext:
   - Look up in manifest: table, record name, sys_id, field, scope
   - Skip files not in manifest (warn)
3. groupAppFiles()
   - Group by record (table + sys_id)
   - A single record may have multiple fields (e.g., script + html)
4. If --scopeSwap: auto-switch scope on instance via REST API
5. If --updateSet: create or switch to named update set
6. For each record (3 parallel):
   - Build through plugin pipeline (5 parallel builds)
   - Push via client.updateRecord() or client.pushWithUpdateSet()
   - On failure: retry up to 3 times, 3s between attempts
7. Report: success/failure counts
```

### 8.6 Watch Flow (`dove watch` / MultiScopeWatcher)

```
1. Load config, enumerate scopes from scopes key
2. For each scope:
   - Load manifest
   - Start chokidar file watcher on sourceDirectory
   - Watch for: add, change events (not delete)
3. On file change (debounced 300ms):
   - Resolve file to FileContext via manifest
   - Build through plugin pipeline
   - Push to ServiceNow
   - Log result
4. Optionally launch dashboard (Express server on port 3456)
   - Skip with --noDashboard flag
   - Custom port with --port flag
5. Periodic: monitor update set state
6. Ctrl+C: graceful shutdown (close watchers, kill dashboard)
```

### 8.7 Concurrency Constants

| Operation | Concurrency Limit |
|---|---|
| Table processing (download) | 2 parallel |
| Record processing (download) | 5 parallel |
| File writing (download) | 10 parallel |
| Push operations | 3 parallel |
| Build operations | 5 parallel |
| Push retries | 3 attempts, 3 second wait |

### 8.8 Synced Table Types

Dovetail synchronizes 16 ServiceNow table types:

`sys_script_include`, `sys_script`, `sys_ui_script`, `sys_ui_page`, `sys_ux_client_script`, `sys_processor`, `sys_ws_operation`, `sys_rest_message_fn`, `sys_ui_action`, `sys_security_acl`, `sysevent_script_action`, `sys_ux_macroponent`, `sys_ux_event`, `sys_ux_client_script_include`, `sys_ux_screen`, `sys_script_fix`

---

## 9. CLI Command Reference

All commands are registered via yargs in `packages/core/src/commander.ts`. The binary is `dove` .

### Core Sync Commands

| Command | Aliases | Description | Key Flags |
|---|---|---|---|
| `watch` | `w`, `watchAllScopes` | Watch all scopes for changes and sync | `--noDashboard`, `--port <n>` |
| `refresh` | `r` | Download new files since last refresh | `--logLevel` |
| `push [target]` | — | Push local files to ServiceNow | `--diff <branch>`, `--updateSet <name>`, `--clickup <id>`, `--ci` |
| `download <scope>` | — | Download entire scope from ServiceNow | `--logLevel` |
| `build` | — | Build locally without pushing | `--diff <branch>` |
| `deploy` | — | Deploy build directory to instance | `--logLevel` |

### Init & Auth

| Command | Description | Key Flags |
|---|---|---|
| `init` | Full setup wizard (discover, login, config, download) | `--logLevel` |
| `login [plugin]` | Authenticate with ServiceNow and/or integrations | `--all`, `--instance`, `--user`, `--password` |

### Record Management

| Command | Description | Key Flags |
|---|---|---|
| `create <table>` | Create a new record | `--name`, `--scope`, `--from <json>`, `--field key=value`, `--ci` |
| `delete <table> [name]` | Delete a record | `--scope`, `--sysid`, `--ci`, `--keepLocal` |

### Update Set Management

| Command | Description | Key Flags |
|---|---|---|
| `createUpdateSet` | Create new update set and switch to it | `--name`, `--description`, `--scope`, `--clickup <id>`, `--skipDescription`, `--skipScope` |
| `switchUpdateSet` | Switch to existing update set | `--name`, `--scope` |
| `listUpdateSets` | List in-progress update sets | `--scope` |
| `currentUpdateSet` | Show current active update set | `--scope` |

### Scope Management

| Command | Description | Key Flags |
|---|---|---|
| `changeScope` | Change to a different scope | `--scope` |
| `currentScope` | Show current active scope | — |
| `initScopes` | Initialize all scopes from config | `--delay <ms>` |

### Tools

| Command | Description | Key Flags |
|---|---|---|
| `dashboard` | Launch Update Set Dashboard web UI | `--port <n>` |
| `schema pull` | Fetch ServiceNow table schemas | `--output <dir>`, `--scope` |
| `init-claude` | Install Claude Code skills to `.claude/commands/` | `--force` |

### ClickUp Subcommands (`dove clickup ...`)

| Subcommand | Description | Key Flags |
|---|---|---|
| `tasks` | List my tasks grouped by status | `--team`, `--status` |
| `task <id>` | Get task details | — |
| `create <list-id>` | Create task (interactive) | — |
| `update <task-id>` | Update task (interactive) | — |
| `comment <task-id> <msg>` | Add comment to task | — |
| `teams` | List workspaces/teams | — |
| `setup` | Configure ClickUp API token | — |
| `spaces` | List spaces in workspace | `--team` |
| `lists <space-or-folder>` | List lists in folder/space | — |

---

## 10. Integration Packages

### 10.1 ClickUp (`@tenonhq/dovetail-clickup`)

**Purpose:** ClickUp API v2 client for task management.

**Auth:** `CLICKUP_API_TOKEN` env var.

**Exports:**
- **Client:** `createClient(config): AxiosInstance`
- **Read:** `getTask`, `listMyTasks`, `listTeamTasks`, `getTeams`, `getSpaces`, `getFolders`, `getLists`, `getSpaceLists`, `getListTasks`, `findListByName`
- **Write:** `createTask`, `updateTask`, `updateTaskStatus`, `deleteTask`, `addComment`
- **Formatters:** `formatForClaude` (LLM-optimized), `formatTaskDetail`, `formatTaskSummary`, `formatTeamSync` (full team board as markdown)
- **Utilities:** `parseClickUpIdentifier` (extract ID from URL)
- **Init Plugin:** `sincPlugin` — adds ClickUp token setup to `dove init`

**Used by:** CTO operating system scripts (`clickup-sync.ts`), GitHub Actions PR workflow, `dove` CLI commands, dashboard UI.

### 10.2 Google Auth (`@tenonhq/dovetail-google-auth`)

**Purpose:** Shared OAuth2 authentication for all Google integrations.

**Auth:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`

**Exports:**
- `createGoogleAuth(config)` — Returns authenticated auth object
- `configFromEnv()` — Load credentials from environment
- `handleAuthError(error, context)` — Standardized error handling

**Token management:** Auto-refresh via refresh token. Setup script walks through OAuth consent flow.

### 10.3 Gmail (`@tenonhq/dovetail-gmail`)

**Purpose:** Gmail API client for email operations.

**Peer dependency:** Requires `@tenonhq/dovetail-google-auth`.

**Exports:**
- **Client:** `createGmailClient(auth)`
- **Read:** `getUnread`, `getStarred`, `searchEmails`, `getThread`, `getVipEmails`, `getActionRequired`
- **Write:** `archiveEmail`, `labelEmail`, `markAsRead`, `markAsUnread`, `moveToTrash`, `starEmail`, `unstarEmail`
- **Formatters:** `formatDigest` (daily digest markdown), `formatThread`, `formatEmailSummary`
- **Utilities:** `parseGmailIdentifier`

**Used by:** `gmail-digest.js` script, morning brief pipeline.

### 10.4 Google Calendar (`@tenonhq/dovetail-google-calendar`)

**Purpose:** Google Calendar API client for event management.

**Peer dependency:** Requires `@tenonhq/dovetail-google-auth`.

**Exports:**
- **Client:** `createCalendarClient(auth)`
- **Read:** `getTodayEvents`, `getUpcomingEvents`, `getEvent`, `searchEvents`
- **Write:** `createEvent`, `updateEvent`, `deleteEvent`
- **Formatters:** `formatDailyAgenda` (markdown agenda), `formatEvent`

**Used by:** `calendar-sync.js` script, morning brief pipeline.

### 10.5 Dashboard (`@tenonhq/dovetail-dashboard`)

**Purpose:** Express.js web UI for update set + ClickUp task management.

**Not a library** — standalone server, no exports. Spawned by `dove dashboard` or embedded in `dove watch`.

**API endpoints:**
- `GET /api/scopes` — List configured scopes with selected update sets
- `GET /api/update-sets/:scope` — List in-progress update sets for scope
- `POST /api/update-set` — Create new update set
- `PATCH /api/update-set/:sysId/close` — Close update set
- `POST /api/select-update-set` — Save scope-to-update-set mapping
- `GET /api/recent-edits` — Recent file changes
- `GET /api/clickup/status` — ClickUp config check
- `GET /api/clickup/tasks` — List tasks by status
- `POST /api/clickup/select-task` — Set active task
- `POST /api/clickup/activate-scope` — Create/find update set for scope from task
- `POST /api/clickup/activate-all-scopes` — Activate all scopes for active task

**Persistence:** JSON files (`.dove-update-sets.json`, `.dove-active-task.json`, `.dove-recent-edits.json`).

**Rate limiting:** 100 req/15 min per IP on recent edits endpoint. 20 RPS on ServiceNow API calls.

**Default port:** 3456 (configurable via `DASHBOARD_PORT` env or `--port` flag).

### 10.6 Schema (`@tenonhq/dovetail-schema`)

**Purpose:** Fetch and organize ServiceNow table schemas.

**Exports:**
- `pullSchema(options): Promise<SchemaIndex>` — Main orchestrator
- `fetchSchema()` — Query ServiceNow for table definitions
- `organizeSchema()` — Structure by application/scope
- `groupByApplication()` — Group tables by owning app

**Output:** JSON schema files organized by application, with an index file.

---

## 11. Design Principles

These principles govern all Dovetail development. They are non-negotiable.

### The 6 Rules

1. **Every package is Claude Code's interface to an external system.** Design APIs for programmatic consumption first, human CLI second. Formatters produce LLM-friendly markdown.

2. **Read + Write, with gates.** Packages expose both read and write operations. High-risk writes (deploy to prod, send to clients, delete data) require human confirmation — enforced by the consuming layer (CTO operating system), not by Dovetail itself.

3. **One package, one service.** No package wraps multiple external systems. Cross-service orchestration happens in consuming code (scripts, CLI commands, Claude Code), not inside packages.

4. **Convention over configuration.** New packages follow the established pattern (`types.ts`, `client.ts`, `formatter.ts`, `index.ts`). Plugin discovery is runtime, not hardcoded. This is what makes the monorepo scale.

5. **npm-first distribution.** Packages are published to npm and consumed as dependencies — not imported via relative paths to the monorepo. This makes them available to GitHub Actions, the CTO operating system, and any future consumer.

6. **Env-based credentials.** All auth goes through environment variables. No interactive auth flows at runtime (except initial setup scripts via `dove init`).

### Implementation Constraints

- **`dove.config.js` is the single source of truth** — no hidden defaults, no fallback values baked into code
- **`_` prefix convention** — config keys starting with `_` are directives, not table names
- **Client-side filtering** — ServiceNow returns everything; the whitelist is enforced locally
- **No circular dependencies** between packages
- **No optional chaining (`?.`)** — ES6 only
- **Node.js scripts over shell scripts** — easier to read, maintain, and debug
- **Functions accept single object parameter** instead of multiple positional arguments

---

## 12. Current State vs. Roadmap

### 12.1 Package Inventory

| Package | Version | Status |
|---|---|---|
| `dovetail-core` | 0.0.75 | Stable |
| `dovetail-types` | 0.0.13 | Stable |
| `dovetail-dashboard` | 0.0.9 | Stable |
| `dovetail-schema` | 0.0.5 | Stable |
| `dovetail-clickup` | 0.0.5 | Stable |
| `dovetail-google-auth` | 0.0.6 | Stable |
| `dovetail-gmail` | 0.0.5 | Stable |
| `dovetail-google-calendar` | 0.0.5 | Stable |
| `dovetail-typescript-plugin` | 0.0.7 | Stable |
| `dovetail-babel-plugin` | 0.0.6 | Stable |
| `dovetail-babel-plugin-remove-modules` | 0.0.6 | Stable |
| `dovetail-babel-preset-servicenow` | 0.0.6 | Stable |
| `dovetail-webpack-plugin` | 0.0.6 | Stable |
| `dovetail-sass-plugin` | 0.0.7 | Stable |
| `dovetail-eslint-plugin` | 0.0.6 | Stable |
| `dovetail-prettier-plugin` | 0.0.7 | Stable |

**Note:** Monorepo source is always 1 patch version ahead of npm due to postpublish auto-bump.

### 12.2 Planned Packages

| Package | Purpose | Priority |
|---|---|---|
| `dovetail-deploy` | Environment management, update set promotion (DEV -> TEST -> UAT -> STAGING -> PROD), conflict detection, rollback | High |
| `dovetail-atf` | ServiceNow Automated Test Framework execution and result reporting | High |
| `dovetail-certification` | App Store certification readiness checks (ACL gaps, naming conventions, prohibited APIs) | Medium |
| `dovetail-slack` | Team notifications, customer channel monitoring | Medium |
| `dovetail-servicenow-health` | Instance performance metrics, node health | Medium |
| `dovetail-hubspot` | Sales pipeline data | Low |

### 12.3 Known Technical Debt

| Item | Impact | Effort |
|---|---|---|
| Lerna 0.4.2-alpha.6 (ancient alpha) | Blocks Node 22 upgrade, modern workspace features | 2-3 days |
| Node 20 -> 22 migration | Node 20 EOL Oct 2026. Blocked by Lerna upgrade. | 4-5 days |
| Test coverage gaps | Core has minimal tests. Plugin packages have zero tests. | Ongoing |
| `TSFIXME` / `any` types | Loose typing in command handlers | 2-3 days |
| `var` usage in init/login code | Should be `const`/`let` | 1 day |
| Dashboard has no auth | Works for local dev, won't scale to team/remote use | Scope TBD |
| Azure Pipelines still configured | Should consolidate to GitHub Actions only | 1 day |
| 9 optional chaining (`?.`) violations | ES6-only rule | 1 day |

---

## 13. Appendices

### Appendix A: Full dove.config.js Example

```javascript
module.exports = {
  sourceDirectory: "src",
  buildDirectory: "build",
  refreshInterval: 30,

  rules: [
    {
      match: /\.ts$/,
      plugins: [
        {
          name: "@tenonhq/dovetail-typescript-plugin",
          options: { transpile: true },
        },
        {
          name: "@tenonhq/dovetail-babel-plugin",
          options: {},
        },
        {
          name: "@tenonhq/dovetail-babel-preset-servicenow",
          options: {},
        },
      ],
    },
    {
      match: /\.js$/,
      plugins: [
        {
          name: "@tenonhq/dovetail-babel-preset-servicenow",
          options: {},
        },
      ],
    },
    {
      match: /\.scss$/,
      plugins: [
        {
          name: "@tenonhq/dovetail-sass-plugin",
          options: {},
        },
      ],
    },
  ],

  includes: {
    _tables: [
      "sys_script_include",
      "sys_script",
      "sys_ui_script",
      "sys_ui_page",
      "sys_ux_client_script",
      "sys_processor",
      "sys_ws_operation",
      "sys_rest_message_fn",
      "sys_ui_action",
      "sys_security_acl",
      "sysevent_script_action",
      "sys_ux_macroponent",
      "sys_ux_event",
      "sys_ux_client_script_include",
      "sys_ux_screen",
      "sys_script_fix",
    ],
    sys_ux_macroponent: {
      composition: { type: "json" },
    },
    _scopes: {
      x_cadso_automate: {
        _tables: ["x_cadso_core_setting"],
      },
    },
  },

  excludes: {
    _tables: [],
  },

  tableOptions: {},

  scopes: {
    x_cadso_core: { sourceDirectory: "src/x_cadso_core" },
    x_cadso_work: { sourceDirectory: "src/x_cadso_work" },
    x_cadso_automate: { sourceDirectory: "src/x_cadso_automate" },
    x_cadso_contacts: { sourceDirectory: "src/x_cadso_contacts" },
    x_cadso_forms: { sourceDirectory: "src/x_cadso_forms" },
  },
};
```

### Appendix B: Writing a New Integration Package

Step-by-step guide for adding a new `@tenonhq/dovetail-*` package:

1. **Create package directory:**
   ```
   mkdir packages/{name}
   mkdir packages/{name}/src
   ```

2. **Create `package.json`:**
   ```json
   {
     "name": "@tenonhq/dovetail-{name}",
     "version": "0.0.1",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": {
       "build": "tsc",
       "postpublish": "node ../../Scripts/bump-version.js"
     },
     "dependencies": {},
     "peerDependencies": {}
   }
   ```

3. **Create `tsconfig.json`:**
   ```json
   {
     "extends": "../../tsconfig.json",
     "compilerOptions": {
       "outDir": "dist",
       "rootDir": "src"
     },
     "include": ["src/**/*"]
   }
   ```

4. **Implement the package pattern:**
   - `src/types.ts` — TypeScript interfaces for the external service
   - `src/client.ts` — Client factory + API methods
   - `src/formatter.ts` — Output formatters (markdown for humans, LLM-friendly for Claude Code)
   - `src/index.ts` — Re-export everything

5. **Optional: Add init plugin support:**
   ```typescript
   // src/plugin.ts
   import { Sinc } from "@tenonhq/dovetail-types";

   export const sincPlugin: Sinc.InitPlugin = {
     name: "{name}",
     displayName: "{Display Name}",
     description: "What this integration does",
     login: [
       {
         envKey: "{SERVICE}_API_TOKEN",
         prompt: { type: "password", message: "API token:", mask: "*" },
         required: true,
       },
     ],
   };
   ```

6. **Add to monorepo:** The package is auto-discovered by Lerna via the `packages/*` workspace glob.

7. **Publish:** `cd packages/{name} && npm publish --access public`

### Appendix C: Environment Variables Reference

| Variable | Package | Purpose |
|---|---|---|
| `SN_INSTANCE` | core | ServiceNow instance name (e.g., `mycompany`) |
| `SN_USER` | core | ServiceNow username |
| `SN_PASSWORD` | core | ServiceNow password |
| `CLICKUP_API_TOKEN` | clickup | ClickUp API v2 personal token |
| `CLICKUP_TEAM_ID` | clickup | Default ClickUp workspace/team ID |
| `GOOGLE_CLIENT_ID` | google-auth | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | google-auth | Google OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | google-auth | Google OAuth2 refresh token |
| `DASHBOARD_PORT` | dashboard | Express server port (default: 3456) |

All credentials are stored in `.env` at the project root. This file must be git-ignored.

---

*This document describes Dovetail as of v0.0.75 (core). Update it as packages ship or architecture changes.*
