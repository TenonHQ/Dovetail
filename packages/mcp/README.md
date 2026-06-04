# @tenonhq/dovetail-mcp

MCP server exposing read tools for ClickUp / Gmail / Google Calendar / ServiceNow
plus **gated Phase-2 ClickUp writes**, backed by the existing Dovetail
integration packages. Gmail / Calendar / ServiceNow remain read-only.

ClickUp writes are gated by the **operator-controlled** `SINC_MCP_WRITES_ENABLE=1`
env flag — off by default, the server cannot write at all. When the flag is on,
each write call also requires `confirm:true`; without it the tool returns a
dry-run preview. `confirm:true` is a preview/speed-bump (the calling agent can
set it itself), not a human-in-the-loop checkpoint — the env flag is the real
boundary.

## Install

```bash
npm i @tenonhq/dovetail-mcp
```

Node 20 LTS required.

## Environment variables

The server reads `.env` of the **calling** project. It boots
even if some integrations are missing — calls to those tools just return a
clear "not configured" error.

| Variable                    | Required by                  |
|-----------------------------|------------------------------|
| `CLICKUP_API_TOKEN`         | All `clickup_*` tools        |
| `CLICKUP_TEAM_ID`           | Optional default for `clickup_list_tasks`/`clickup_search_tasks`/`clickup_get_team_sync` |
| `GOOGLE_CLIENT_ID`          | All `gmail_*` and `calendar_*` tools |
| `GOOGLE_CLIENT_SECRET`      | (same)                       |
| `GOOGLE_REFRESH_TOKEN`      | (same)                       |
| `SN_INSTANCE` (or `SN_DEV_INSTANCE`/`SN_PROD_INSTANCE`) | `servicenow_query_table` |
| `SN_USER` (or `SN_DEV_USERNAME`/`SN_PROD_USERNAME`) | (same)            |
| `SN_PASSWORD` (or `SN_DEV_PASSWORD`/`SN_PROD_PASSWORD`) | (same)         |
| `SINC_MCP_SN_TABLE_DENY`    | Override default deny list (comma-separated) |
| `SINC_MCP_SN_TABLE_OVERRIDE`| Allow specific denied tables (comma-separated) |
| `SINC_MCP_TELEMETRY_DISABLE`| `1`/`true` to skip telemetry writes |
| `SINC_MCP_TELEMETRY_PATH`   | Override `~/.dovetail-mcp/telemetry.jsonl` |
| `SINC_MCP_WRITES_ENABLE`    | `1` to enable the gated ClickUp write tools (off by default) |

> **OAuth scope warning:** Dovetail's existing Google refresh tokens are
> issued with **write-capable** scopes (`gmail.modify`, `calendar`).
> dovetail-mcp never imports Gmail/Calendar write functions (ESLint + the static
> scan block them), so it cannot write Gmail/Calendar even though the token
> could. (ClickUp writes are the one allowed write surface — see below.)
> Re-running `dovetail-google-auth` setup
> with `gmail.readonly` + `calendar.readonly` scopes is recommended for
> defence-in-depth and is tracked separately.

## Tools (16)

| Tool                            | Purpose                                        |
|---------------------------------|------------------------------------------------|
| `clickup_list_tasks`            | Tasks assigned to the authenticated user       |
| `clickup_get_task`              | Fetch a single task by ID                      |
| `clickup_search_tasks`          | Substring search across team tasks             |
| `clickup_get_team_sync`         | 7-stage pipeline JSON (Blocked → Ready for Release) |
| `clickup_update_task` 🔒        | **Gated write** — update name/markdown/status/priority |
| `clickup_set_custom_field` 🔒   | **Gated write** — set one custom-field value   |
| `clickup_create_task` 🔒        | **Gated write** — create a task in a list      |
| `clickup_link_tasks` 🔒         | **Gated write** — link two tasks               |
| `gmail_get_unread`              | Unread inbox emails                            |
| `gmail_get_starred`             | Starred emails                                 |
| `gmail_search`                  | Gmail query syntax                             |
| `gmail_get_action_required`    | Unread emails matching action-required patterns|
| `calendar_get_today`            | Today's events                                 |
| `calendar_get_week`             | Next 7 days                                    |
| `calendar_get_event`            | Single event by ID                             |
| `servicenow_query_table`        | Table API GET (deny-listed tables blocked)     |

ServiceNow deny-list (default): `sys_user_password`, `sys_user_token`,
`sys_credential`, `sys_secret`, `sys_user_grmember`, `sys_audit`. Override
per-table with `SINC_MCP_SN_TABLE_OVERRIDE=table_a,table_b`.

🔒 **Gated writes (Phase 2).** The four ClickUp write tools are inert unless
`SINC_MCP_WRITES_ENABLE=1` is set — that's the operator-controlled gate. When
on, calls return a dry-run preview unless `confirm:true` is passed; the
`confirm` flag is a preview affordance, not a human checkpoint (the calling
agent can set it itself). Target a custom ID (e.g. `DEV-225`) with
`customTaskIds:true` + `teamId`. Gmail, Calendar, and ServiceNow stay
read-only.

## Run

```bash
# stdio transport (intended use under an MCP client like Claude Code)
npx @tenonhq/dovetail-mcp

# Smoke check — list tools and exit, no transport
npx @tenonhq/dovetail-mcp --smoke
```

## Wiring into Claude Code

Add the server entry to `.claude/mcp.json` in the consuming project:

```jsonc
{
  "mcpServers": {
    "dovetail": {
      "command": "npx",
      "args": ["-y", "@tenonhq/dovetail-mcp"]
    }
  }
}
```

Until the package is published, point at a local build instead:

```jsonc
{
  "mcpServers": {
    "dovetail": {
      "command": "node",
      "args": ["/absolute/path/to/Dovetail/packages/dovetail-mcp/dist/server.js"]
    }
  }
}
```

Tools are deferred-by-default — they appear in `ToolSearch` but their schemas
load on demand. Per the CTO `CLAUDE.md` MCP policy, hoist to always-loaded
only after telemetry shows >30% session usage.

## Agent doc additions

Add a one-liner to each consuming agent's prompt:

- `task-manager.md`: "ClickUp `clickup_*` MCP tools (under the `dovetail`
  server) are available for live task queries instead of the cron'd
  `context/clickup-tasks.md`."
- `cto-briefer.md`: "Live data: `gmail_*`, `calendar_*`, `clickup_*` MCP tools
  on the `dovetail` server. Prefer them over the cron'd context markdown when
  freshness matters."
- `decision-advisor.md`: "Calendar / ClickUp MCP tools on the `dovetail`
  server are available for context-rich reasoning."

## Telemetry

Every tool call appends one JSON line to `~/.dovetail-mcp/telemetry.jsonl`
(file mode `0600`, dir mode `0700`):

```jsonl
{"ts":"2026-05-08T17:30:00.000Z","tool":"clickup_list_tasks","args":{"teamId":"123"},"durationMs":420,"success":true}
{"ts":"2026-05-08T17:30:01.000Z","tool":"gmail_search","args":{"query":"from:alice"},"durationMs":250,"success":true}
```

### Redaction

- `body` / `html` / `text` / `content` keys → `"[REDACTED:body]"`.
- Token-bearing keys (`token`, `password`, `refresh_token`, `access_token`,
  `client_secret`, `apiKey`, `api_key`, `clickup_api_token`, `authorization`,
  `auth`) → `"[REDACTED]"`.
- Email-shaped strings → `first3***@domain.tld`.
- Free-form strings >200 chars → `sha256:<first 12 hex>`.
- Query strings (`query`, `q`, `sysparm_query`, `subjectPatterns`, `labels`,
  `statuses`) are kept verbatim — they're operational signal.

Disable with `SINC_MCP_TELEMETRY_DISABLE=1`. Override the path with
`SINC_MCP_TELEMETRY_PATH=/tmp/foo.jsonl`. Rotate manually for v1.

## Write-surface enforcement

Writes are confined to **one declared module** — `src/tools/clickup-write.ts` —
which may use only the ClickUp write functions. Every other tool module stays
read-only. Three layers enforce this:

1. **Imports.** Read tool modules import only read functions; the write module
   imports only `createTask` / `updateTask` / `setCustomField` / `linkTask`.
2. **ESLint** (`.eslintrc.json` `no-restricted-imports`) blocks write imports
   from `dovetail-clickup` / `dovetail-gmail` / `dovetail-google-calendar` /
   `dovetail-servicenow`, with a scoped `overrides` entry that permits the
   ClickUp writes **only** in `clickup-write.ts` (Gmail/Calendar/SN still banned
   even there).
3. **Static scan test** (`src/tests/readonly-imports.test.ts`) reads every
   `src/tools/*.ts` and asserts no forbidden write symbol appears — including
   `client.claude.*` (the ServiceNow write namespace). The lone exception is the
   declared write module's ClickUp allowlist (`WRITE_MODULE_ALLOW`); a new file
   cannot opt itself in.

At runtime, writes are gated by the operator-controlled `SINC_MCP_WRITES_ENABLE=1`
flag (see "Gated writes" above). A per-call `confirm:true` switches the tool
from preview to apply; it is *not* a human checkpoint — the calling agent can
satisfy it itself, so it functions as a preview affordance, not a second factor.

## Troubleshooting

- **"ClickUp is not configured — Missing required environment variables …"**
  Set `CLICKUP_API_TOKEN`. The server boots without it; only `clickup_*` calls
  fail until it's set.
- **"Google authentication failed (… ). Your refresh token may be expired or
  revoked."** Re-run `npm run setup` in `@tenonhq/dovetail-google-auth`.
- **"Table 'X' is in the default deny list."** Add the table to
  `SINC_MCP_SN_TABLE_OVERRIDE` (comma-separated) only after confirming the
  read is intentional.
