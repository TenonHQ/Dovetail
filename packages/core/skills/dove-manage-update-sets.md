# Manage ServiceNow Update Sets

## Task
$ARGUMENTS

## Instructions for Claude

### Directory Context

Dovetail commands can be run from two locations:
- **From `ServiceNow/` directory:** `npx sinc <command>`
- **From Craftsman root:** `npm run sinc:<command>` (proxy scripts)

Available root scripts: `sinc:init`, `sinc:start`, `sinc:dev`, `sinc:build`, `sinc:deploy`, `sinc:push`, `sinc:refresh`, `sinc:status`

When this skill references `npx sinc <command>`, use `npm run sinc:<command>` if working from the Craftsman root. Note: commands with extra flags (e.g., `npx dove push --updateSet "name"`) require running from the `ServiceNow/` directory directly, as npm run scripts don't forward arguments.

---

Help the user manage ServiceNow update sets through Dovetail's CLI commands and dashboard.

### Available Commands

| Command | Purpose |
|---------|---------|
| `npx dove listUpdateSets` | List all in-progress update sets |
| `npx dove listUpdateSets --scope x_cadso_core` | List update sets for a specific scope |
| `npx dove createUpdateSet --name "FEAT-123 New Feature"` | Create and activate a new update set |
| `npx dove createUpdateSet --name "FEAT-123" --scope x_cadso_core --description "Feature description"` | Create with scope and description |
| `npx dove switchUpdateSet --name "FEAT-123"` | Switch to an existing update set (partial name match) |
| `npx dove switchUpdateSet --scope x_cadso_core` | Browse and select from a scope's update sets |
| `npx dove currentUpdateSet` | Show the currently active update set |
| `npx dove currentScope` | Show the currently active scope |
| `npx dove changeScope --scope x_cadso_work` | Switch to a different scope |

### Push with Update Set

Create a new update set as part of a push operation:

```bash
npx dove push --updateSet "FEAT-123 My Changes"
# or short form:
npx dove push --us "FEAT-123 My Changes"
```

This creates the update set, assigns it as current, and pushes all files into it.

### Web Dashboard

Dovetail includes a web dashboard for visual update set management:

```bash
npx dove dashboard
```

Launches at `http://localhost:3456` (configurable via `DASHBOARD_PORT` in `.env`). Features:
- All configured scopes with display names
- In-progress update sets per scope
- Create new update sets
- Close (complete) update sets
- Select active update set per scope

The dashboard reads scopes from `dove.config.js` and stores selections in `.dove-update-sets.json`.

### Multi-Scope Update Set Monitoring

When using `npx dove watchAllScopes`, update set status is automatically checked every 2 minutes. It warns if any scope is using the DEFAULT update set (a common mistake that puts changes in the wrong place).

### Recommended Workflow

1. **Before starting work:** Create a named update set for your feature/ticket:
   ```bash
   npx dove createUpdateSet --name "FEAT-123 Add User Dashboard" --scope x_cadso_core
   ```

2. **During development:** Use `npx dove dev` or `npx dove watchAllScopes`. Changes go into the active update set.

3. **Check status:** `npx dove currentUpdateSet` to verify you are in the right update set.

4. **When done:** Complete the update set in ServiceNow or via the dashboard.

5. **For deployment:** Use `npx dove push --us "RELEASE-1.0"` to push all changes into a clean update set.

### Common Issues

- **"No update set selected"** -- You are using the Default update set. Create or switch to a named one.
- **Changes going to wrong scope** -- In multi-scope mode, use `npx dove watchAllScopes` which auto-switches scopes. Single-scope `npx dove dev` only works for one scope.
- **Update set not found** -- Check the scope filter. Update sets are scope-specific.
