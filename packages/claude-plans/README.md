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
