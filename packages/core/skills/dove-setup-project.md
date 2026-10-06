# Set Up Dovetail Project

## Task
$ARGUMENTS

## Instructions for Claude

### Directory Context

Dovetail commands can be run from two locations:
- **From `ServiceNow/` directory:** `npx sinc <command>`
- **From Craftsman root:** `npm run sinc:<command>` (proxy scripts)

Available root scripts: `sinc:init`, `sinc:start`, `sinc:dev`, `sinc:build`, `sinc:deploy`, `sinc:push`, `sinc:refresh`, `sinc:status`

When this skill references `npx sinc <command>`, use `npm run sinc:<command>` if working from the Craftsman root. Configuration files (`dove.config.js`, `.env`, manifests) live in the `ServiceNow/` directory.

---

Help the user set up a new Dovetail project or add a new scope to an existing project.

### Determine the Scenario

1. **New project from scratch** -- No `dove.config.js` exists yet
2. **Add a new scope to existing project** -- `dove.config.js` exists, need to add scope config
3. **Re-initialize / reset** -- Project exists but needs fresh download

### Scenario 1: New Project

#### Prerequisites check
- Node.js v20 LTS installed (`node -v`)
- The Dovetail server scoped app is installed on the target ServiceNow instance

#### Initialize the project
```bash
mkdir my-servicenow-app && cd my-servicenow-app
npm init -y
npm i -D @tenonhq/dovetail-core
```

#### Run the init wizard
```bash
npx dove init
```
Prompts for: instance URL, username, password, and which scoped app to download.

#### Configure the build pipeline
Direct the user to use the `configure-pipeline` skill or help inline.

#### Set up `.env`
```
SN_USER=admin
SN_PASSWORD=your_password
SN_INSTANCE=your-instance.service-now.com
```
- Instance should NOT have `https://` prefix or trailing slash
- Optional: `DASHBOARD_PORT=3456`
- **Never commit `.env` to git**
- **Multiple instances?** Keep one file per instance (`.env.dev`, `.env.prod`) and pass `--env <path>` (alias `-e`) on any command: `npx dove push --env .env.prod`. `dove login --env .env.prod` writes credentials to that file too. Git-ignore the whole pattern (`.env*`).

#### Set up `.gitignore`
```
node_modules/
.env
build/
dove.manifest*.json
dovetail-debug-*.log
```

#### Start development
```bash
npx dove status              # confirm instance, scope, user
npx dove refresh             # pull the manifest + files
# ...edit files...
npx dove push --diff main    # push only what changed vs the branch
```
Sync is headless and explicit: `refresh` before you start, `push` when you are done. There is no always-on sync step in this flow.

### Scenario 2: Add a New Scope (Multi-Scope Setup)

#### Add the scope to `dove.config.js`
```javascript
module.exports = {
  sourceDirectory: "src",
  buildDirectory: "build",
  rules: [ /* ... */ ],
  scopes: {
    x_cadso_core: {
      sourceDirectory: "src/x_cadso_core"
    },
    x_cadso_work: {
      sourceDirectory: "src/x_cadso_work"
    }
  }
};
```

#### Download all scopes
```bash
npx dove initScopes
```
Creates per-scope manifest files (`dove.manifest.x_cadso_core.json`, etc.) and downloads files to each scope's source directory.

If hitting rate limits:
```bash
npx dove initScopes --delay 1000
```

#### Sync across all scopes
```bash
npx dove refresh                 # all declared scopes
npx dove refresh -s x_cadso_work # one scope
npx dove push --diff main        # one command for a multi-scope change
```
`push` reads each file's scope from its manifest and, when `.dove-update-sets.json` maps that scope to an update set (`createUpdateSet` / `switchUpdateSet` write the mapping), routes the record into that scope's set server-side. Map every scope you are about to touch first — the server session scope is only swapped once, to the first file's scope, so an unmapped second scope is the thing to avoid. Confirm with `npx dove currentUpdateSet --scope <scope>` before pushing.

#### Download a single scope
```bash
npx dove download x_cadso_core
```

### Scenario 3: Reset / Re-download

1. Back up any local changes (commit to git)
2. Run: `npx dove download <scope>` (destructive -- overwrites local files)
3. Or for all scopes: `npx dove initScopes`

### File Structure After Setup

```
project/
  .env                              # Credentials (git-ignored)
  dove.config.js                    # Build pipeline config
  dove.manifest.json                # Single-scope manifest
  dove.manifest.x_cadso_core.json   # Multi-scope manifest
  src/
    x_cadso_core/
      sys_script_include/
        MyScriptInclude/
          script.ts
      sys_ui_page/
        MyUIPage/
          html.html
          client_script.js
    x_cadso_work/
      ...
  build/                            # Built output (git-ignored)
  node_modules/                     # Dependencies (git-ignored)
```

### Commands Reference

| Command | Purpose |
|---------|---------|
| `npx dove init` | Interactive project setup |
| `npx dove initScopes` | Download all configured scopes |
| `npx dove download <scope>` | Download a specific scope (destructive) |
| `npx dove refresh` | Refresh manifest, download new files only |
| `npx dove push --diff <branch>` | Push only the files changed vs a branch (all scopes) |
| `npx dove push` | Push every local file (all scopes) |
| `npx dove status` | Show connected instance, scope, user |
