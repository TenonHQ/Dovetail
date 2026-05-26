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
| `push_artifact` | Generic artifact (`kind: "markdown" \| "mermaid" \| "prompt-cycle"`) |
| `push_diagram` | Convenience wrapper around `push_artifact` for Mermaid sources |
| `delete_plan` | Permanently remove a plan and all its artifacts |
| `get_handoff_bundle` | Compose a paste-ready resume payload from a plan + its artifacts |
| `push_question` | (v2) Park a question on a plan so it can be answered later |
| `record_answer` | (v2) Answer a previously-pushed question by id |
| `get_answers` | (v2) Read the plan's Q&A list, with optional `answered` / `stage` filters |

### v2 Q&A on plans (additive)

Plans can carry an optional `questions: PlanQuestion[]` field. Each `PlanQuestion` has:

```ts
{
  id: string;            // server-assigned, format q_<8-hex>
  question: string;
  header?: string;       // short chip label, mirrors AskUserQuestion
  options?: string[];    // suggested answers
  stage?: string;        // free-form pipeline stage tag, e.g. "research", "plan", "tests"
  asked_by?: string;     // agent / session label
  asked_at: string;      // ISO-8601
  answer?: string;       // absent until record_answer is called
  answered_by?: string;
  answered_at?: string;
}
```

Round-trip:

```
push_question  →  PlanQuestion { id: "q_4a3f9c12", ... }
record_answer  →  PlanQuestion { id, answer, answered_at, ... }
get_answers    →  { plan_slug, questions: PlanQuestion[] }
```

v1 plan records (no `questions` field) round-trip through every v1 tool unchanged; `get_answers` returns an empty list against them, and `push_question` initializes the array on first call.

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
| `tags` | `items: [{label}]` | `title`, `items[].color` (`green\|blue\|cyan\|sage\|warm\|yellow\|purple\|orange\|red\|teal`) |
| `timeline` | `events: [{label}]` | `title`, `events[].time`, `events[].note`, `events[].status` (`done\|active\|pending\|error`) |
| `progress` | `items: [{label, value}]` | `title`, `items[].max` (default `100`), `items[].variant` (`success\|warning\|danger\|info`) |
| `people` | `items: [{name}]` | `title`, `items[].sublabel`, `items[].color` (`blue\|emerald\|deep-emerald\|neon\|orange\|purple\|pink\|earthy`) |
| `quote` | `text` | `cite` |

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
