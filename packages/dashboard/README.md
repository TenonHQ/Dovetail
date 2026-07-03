# @tenonhq/dovetail-dashboard

Web-based UI for managing ServiceNow update sets across scopes, with optional ClickUp task integration.

## What It Does

- Displays all configured scopes from `dove.config.js`
- Lists in-progress update sets per scope
- Lets you select, create, close, and clear update sets per scope
- Persists selections to `.dove-update-sets.json` — **`dove push` and `dove watch` honor these selections** via the `pushWithUpdateSet` REST endpoint
- Optional ClickUp integration: select a task, then either activate update sets manually per scope or use **Start Task** to move the ClickUp status, create every scope's update set, and cut a working branch in one click

## Setup

### Prerequisites

- Node.js 20+
- A configured Dovetail project with `dove.config.js` and `.env`

### Environment Variables

Add these to your project's `.env`:

| Variable            | Required | Default | Description                                       |
| ------------------- | -------- | ------- | ------------------------------------------------- |
| `SN_INSTANCE`       | Yes      | —       | ServiceNow instance name (e.g. `tenonworkstudio`) |
| `SN_USER`           | Yes      | —       | ServiceNow username                               |
| `SN_PASSWORD`       | Yes      | —       | ServiceNow password                               |
| `DASHBOARD_PORT`    | No       | `3456`  | Local server port                                 |
| `CLICKUP_API_TOKEN` | No       | —       | ClickUp personal API token (enables task sidebar) |
| `CLICKUP_TEAM_ID`   | No       | —       | ClickUp team ID (auto-detected if omitted)        |

### Running

```bash
# From your Dovetail project directory
dove dashboard

# Custom port (useful for multiple sessions)
dove dashboard --port 3457
```

This starts an Express server and opens `http://localhost:3456` (or your custom port) in your browser.

Port precedence: `--port` flag > `DASHBOARD_PORT` env var > default `3456`.

## How It Integrates with Push

When you select an update set for a scope in the dashboard, it saves the mapping to `.dove-update-sets.json`:

```json
{
  "x_cadso_core": {
    "sys_id": "abc123def456",
    "name": "DH | DEV-526 | Core | Automation program phase 1"
  }
}
```

The core Dovetail push logic (`appUtils.ts:pushRec`) reads this file on every push. If an update set is mapped for the record's scope, it routes the push through `/api/cadso/dovetail/pushWithUpdateSet` — ensuring the change lands in the correct update set. This works for both `dove push` and `dove watch`.

## ClickUp Integration

When `CLICKUP_API_TOKEN` is configured, a "Tasks" button appears in the header. Clicking it opens a sidebar where you can filter tasks by status (default: "in progress") and click a task card to select it as the active task.

**Selecting a task is deliberately cheap and reversible.** It only writes local dashboard state (`.dove-active-task.json`) — it does not touch ClickUp, ServiceNow, or git. This lets you browse and pick a task without side effects. On select, the dashboard:

- Fetches your ClickUp profile (`GET /user`) to read your `initials`
- Reads the task's ClickUp `custom_id` (the `DEV-###` you see in the UI, not ClickUp's internal task ID)
- Sanitizes the task name into a short description
- Generates and stores the update-set base name, but does **not** create anything yet

### Update-set naming

Every update set the dashboard creates on your behalf follows one scope-aware format:

```
{devInitials} | {DEV-ID} | {App} | {shortDesc}
```

Example: `DH | DEV-526 | Core | Automation program phase 1`

`{App}` is derived per-scope from a label map (`x_cadso_journey`→Journey, `x_cadso_core`→Core, `x_cadso_automate`→Automate, `x_cadso_text_spoke`→Text, `x_cadso_email_spok`→Email; any other scope is title-cased from its name). Because the App segment is scope-specific, **a task with work spanning multiple scopes gets a differently-named update set per scope** — not one shared name reused everywhere (the old `CU-{taskId} — {task name}` behavior).

### Start Task — the one-click "I'm starting this" action

Once a task is selected, the active-task banner shows a **Start Task** button. This is the single deliberate action that turns "I'm looking at this ticket" into "I'm working on this ticket." Clicking it runs three steps, in order, and reports the outcome of each in a toast:

1. **ClickUp status → `in progress`** — a `PUT` to the ClickUp task, independent of whatever status filter you had selected in the sidebar.
2. **Per-scope update sets** — for every scope in `dove.config.js`, finds an existing in-progress update set matching the task (searched by the `DEV-ID` substring, not the full name, so a naming-format change doesn't orphan sets created under an older format) or creates one using the naming convention above. Reuses the same logic as the "Activate All" per-scope flow.
3. **Working branch** — cuts `dev/{git-username}/{DEV-ID}/{shortDesc}` in whatever repo checkout this dashboard process is running from (`git config user.name`, sanitized, supplies the username segment). If that branch already exists — e.g. you click Start Task again on the same ticket later — the dashboard switches to it instead of erroring.

**Scope note:** branch creation only happens in the repo the dashboard's `cwd` is inside (wherever you ran `dove dashboard` from). If a task's work spans two repos (e.g. a Mortise component and its ServiceNow-side records), Start Task only branches the one repo — the other still needs a manual branch.

If the ClickUp status update fails, Start Task stops there and reports the failure — it does not proceed to create update sets or a branch on an inconsistent state. Update-set and branch failures are reported per-item but don't block each other.

Active task state (including the resolved `devInitials`, `customId`, and `shortDesc`) is persisted to `.dove-active-task.json` and survives dashboard restarts.

## API Endpoints

### Update Set Management

| Method  | Path                           | Description                                                    |
| ------- | ------------------------------ | -------------------------------------------------------------- |
| `GET`   | `/api/scopes`                  | List configured scopes with display names and saved selections |
| `GET`   | `/api/update-sets/:scope`      | List in-progress update sets for a scope                       |
| `POST`  | `/api/update-set`              | Create a new update set                                        |
| `PATCH` | `/api/update-set/:sysId/close` | Mark an update set as complete                                 |
| `POST`  | `/api/select-update-set`       | Save scope-to-update-set mapping                               |
| `GET`   | `/api/config`                  | Return saved config and instance name                          |

### ClickUp Integration

| Method | Path                               | Description                                                                                                         |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/clickup/status`              | Check ClickUp configuration and active task                                                                         |
| `GET`  | `/api/clickup/tasks`               | Fetch tasks (query: `?statuses=in progress,review`)                                                                 |
| `GET`  | `/api/clickup/task/:taskId`        | Fetch single task details                                                                                           |
| `POST` | `/api/clickup/select-task`         | Set the active task (local state only — no ClickUp/ServiceNow/git side effects)                                     |
| `POST` | `/api/clickup/activate-scope`      | Find/create update set for one scope                                                                                |
| `POST` | `/api/clickup/activate-all-scopes` | Find/create update sets for all scopes                                                                              |
| `POST` | `/api/clickup/start-task`          | Set ClickUp status to in progress, find/create update sets for all scopes, and cut/switch the task's working branch |
| `POST` | `/api/clickup/deselect-task`       | Clear the active task                                                                                               |

## Persistence Files

| File                     | Purpose                         | Read By                              |
| ------------------------ | ------------------------------- | ------------------------------------ |
| `.dove-update-sets.json` | Scope-to-update-set mapping     | Dashboard, `dove push`, `dove watch` |
| `.dove-active-task.json` | Currently selected ClickUp task | Dashboard only                       |

Both files are written to the project root (CWD). Add them to `.gitignore`.

## Rate Limiting

The dashboard respects ServiceNow's 20 requests-per-second limit. When bulk operations (like "activate all scopes") approach the limit, requests are queued with backpressure rather than rejected.

## ServiceNow Dependencies

The dashboard uses two ServiceNow APIs:

- **Table API** (`/api/now/table/`) — standard CRUD for update sets and scopes
- **Dovetail Scripted REST API** (`/api/cadso/dovetail/changeUpdateSet`) — switches the active update set on the instance after activation

## Git Dependency (Start Task only)

The branch-creation step of Start Task shells out to the `git` CLI (`git config user.name`, `git checkout -b`/`git checkout`) in the dashboard process's `cwd`. Everything else in the dashboard works without git — this dependency only applies if you use Start Task. Run `dove dashboard` from inside the git checkout you want the branch cut in.
