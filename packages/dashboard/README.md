# @tenonhq/dovetail-dashboard

Web-based UI for managing ServiceNow update sets across scopes, with optional ClickUp task integration.

## What It Does

- Displays all configured scopes from `dove.config.js`
- Lists in-progress update sets per scope
- Lets you select, create, close, and clear update sets per scope
- Persists selections to `.dove-update-sets.json` — **`dove push` and `dove watch` honor these selections** via the `pushWithUpdateSet` REST endpoint
- Optional ClickUp integration: select a task, auto-generate and activate update sets across all scopes

## Setup

### Prerequisites

- Node.js 20+
- A configured Dovetail project with `dove.config.js` and `.env`

### Environment Variables

Add these to your project's `.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SN_INSTANCE` | Yes | — | ServiceNow instance name (e.g. `tenonworkstudio`) |
| `SN_USER` | Yes | — | ServiceNow username |
| `SN_PASSWORD` | Yes | — | ServiceNow password |
| `DASHBOARD_PORT` | No | `3456` | Local server port |
| `CLICKUP_API_TOKEN` | No | — | ClickUp personal API token (enables task sidebar) |
| `CLICKUP_TEAM_ID` | No | — | ClickUp team ID (auto-detected if omitted) |

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
    "name": "CU-5029 — Feature Implementation"
  }
}
```

The core Dovetail push logic (`appUtils.ts:pushRec`) reads this file on every push. If an update set is mapped for the record's scope, it routes the push through `/api/cadso/dovetail/pushWithUpdateSet` — ensuring the change lands in the correct update set. This works for both `dove push` and `dove watch`.

## ClickUp Integration

When `CLICKUP_API_TOKEN` is configured, a "Tasks" button appears in the header. Clicking it opens a sidebar where you can:

1. Filter tasks by status (default: "in progress")
2. Select a task as the active task
3. Auto-generate update set names in the format `CU-{taskId} — {task name}`
4. Auto-activate all configured scopes — finds existing update sets or creates new ones

Active task state is persisted to `.dove-active-task.json` and survives dashboard restarts.

## API Endpoints

### Update Set Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/scopes` | List configured scopes with display names and saved selections |
| `GET` | `/api/update-sets/:scope` | List in-progress update sets for a scope |
| `POST` | `/api/update-set` | Create a new update set |
| `PATCH` | `/api/update-set/:sysId/close` | Mark an update set as complete |
| `POST` | `/api/select-update-set` | Save scope-to-update-set mapping |
| `GET` | `/api/config` | Return saved config and instance name |

### ClickUp Integration

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/clickup/status` | Check ClickUp configuration and active task |
| `GET` | `/api/clickup/tasks` | Fetch tasks (query: `?statuses=in progress,review`) |
| `GET` | `/api/clickup/task/:taskId` | Fetch single task details |
| `POST` | `/api/clickup/select-task` | Set the active task |
| `POST` | `/api/clickup/activate-scope` | Find/create update set for one scope |
| `POST` | `/api/clickup/activate-all-scopes` | Find/create update sets for all scopes |
| `POST` | `/api/clickup/deselect-task` | Clear the active task |

## Persistence Files

| File | Purpose | Read By |
|------|---------|---------|
| `.dove-update-sets.json` | Scope-to-update-set mapping | Dashboard, `dove push`, `dove watch` |
| `.dove-active-task.json` | Currently selected ClickUp task | Dashboard only |

Both files are written to the project root (CWD). Add them to `.gitignore`.

## Rate Limiting

The dashboard respects ServiceNow's 20 requests-per-second limit. When bulk operations (like "activate all scopes") approach the limit, requests are queued with backpressure rather than rejected.

## ServiceNow Dependencies

The dashboard uses two ServiceNow APIs:

- **Table API** (`/api/now/table/`) — standard CRUD for update sets and scopes
- **Dovetail Scripted REST API** (`/api/cadso/dovetail/changeUpdateSet`) — switches the active update set on the instance after activation
