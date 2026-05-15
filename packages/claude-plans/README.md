# @tenonhq/dovetail-claude-plans

MCP server + CLI that surfaces Claude Code plans and visual artifacts (markdown, Mermaid diagrams) in the Dovetail dashboard.

## What it does

Claude Code sessions push plans and artifacts via MCP stdio. Records land as JSON files under `~/.dovetail/claude-plans/`. The Dovetail dashboard watches that directory and renders the records live at `/claude-plans` — markdown via marked, diagrams via mermaid.js.

## Install

```bash
npm i -D @tenonhq/dovetail-claude-plans
```

The CTO repo's `.mcp.json` already wires this in via `npx -y @tenonhq/dovetail-claude-plans mcp`.

## MCP tools

| Tool | Purpose |
|---|---|
| `push_plan` | Create / update a plan |
| `update_plan_status` | DRAFT → APPROVED → EXITED |
| `get_plan` | Returns plan + nested artifacts |
| `list_recent_plans` | Newest first, status filter optional |
| `push_artifact` | Generic artifact (`kind: "markdown" \| "mermaid"`) |
| `push_diagram` | Convenience wrapper around `push_artifact` for Mermaid sources |

## Content formats

`push_plan` accepts three content formats — supply exactly one:

| Field | Format |
|---|---|
| `content_md` | Raw Markdown (rendered by marked.js) |
| `content_html` | Raw HTML (sanitized by DOMPurify) |
| `content_structured` | Zero-design JSON components (recommended) |

### `content_structured` — component library

Pass a `{ sections: [...] }` object. The server renders it to HTML using the dashboard's component CSS. Claude Code needs no HTML or CSS knowledge.

```json
{
  "sections": [
    { "type": "header", "title": "Deploy PR #42", "subtitle": "feature/auth → PROD" },
    { "type": "meta", "rows": [
      { "label": "Author", "value": "Daniel" },
      { "label": "Status", "value": "Approved", "badge": "success" }
    ]},
    { "type": "callout", "variant": "warning", "message": "Touches auth middleware." },
    { "type": "steps", "steps": [
      { "label": "DEV",  "status": "done" },
      { "label": "TEST", "status": "done" },
      { "label": "UAT",  "status": "active" },
      { "label": "PROD", "status": "pending" }
    ]},
    { "type": "checklist", "title": "Pre-deploy", "items": [
      { "label": "Tests pass", "done": true },
      { "label": "Migration run", "done": false }
    ]},
    { "type": "metrics", "items": [
      { "label": "Files changed", "value": "12" },
      { "label": "Tests", "value": "142 / 142", "sub": "all pass", "variant": "success" }
    ]}
  ]
}
```

**Section types:**

| Type | Required fields | Optional fields |
|---|---|---|
| `header` | `title` | `subtitle` |
| `meta` | `rows: [{label, value}]` | `title`, `rows[].badge` (`default\|success\|warning\|danger\|info`) |
| `callout` | `message` | `variant` (`info\|warning\|danger\|success`), `title` |
| `checklist` | `items: [{label, done}]` | `title`, `items[].note` |
| `steps` | `steps: [{label, status}]` | `title`, `steps[].note` (`done\|active\|pending\|error`) |
| `metrics` | `items: [{label, value}]` | `items[].sub`, `items[].variant` |
| `section` | `title` | — |
| `table` | `headers: string[]`, `rows: string[][]` | `title` |
| `text` | `content` | — |
| `code` | `content` | `title`, `lang` |

## CLI

```bash
dove-claude-plans list                # all plans, newest first
dove-claude-plans list --status DRAFT
dove-claude-plans exit <slug>         # flip to EXITED
dove-claude-plans exit-stale          # flip every DRAFT to EXITED (used by Claude Stop hook)
dove-claude-plans where               # print storage root
dove-claude-plans mcp                 # stdio MCP server (used by .mcp.json)
dove-claude-plans mcp --smoke         # list registered tools and exit (CI verification)
```

## Storage layout

```
~/.dovetail/claude-plans/
├── <plan-slug>.json
└── <plan-slug>/
    └── artifacts/
        └── <artifact-slug>.json
```

All writes are atomic (`.tmp` → rename) so the dashboard watcher never sees a torn file.

## Stop hook

Recommended addition to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "npx -y @tenonhq/dovetail-claude-plans exit-stale --quiet"
      }]
    }]
  }
}
```
