# @tenonhq/dovetail-todo

A drag-to-reorder **priority TODO checklist** for Claude Code + the Dovetail dashboard.
One-line items, list order **is** priority (top = work on this next), and a checklist
that drives focus. Ships an MCP stdio server and a `dove-todo` CLI; the
`@tenonhq/dovetail-dashboard` `/todos` panel renders the same store live.

Modeled on `@tenonhq/dovetail-claude-plans`: MCP + CLI + local JSON store + dashboard panel.

## Storage

A single ordered file, written atomically (tmp + rename) so a reorder lands as one
consistent write the dashboard's watcher picks up:

```
~/.dovetail/todos/todos.json     # { schema_version, items[], updated_at }
```

The `items` array is the source of truth for priority — index `0` is the top
priority. Override the location with `DOVE_TODO_DIR`.

## MCP tools (8)

| Tool | Purpose |
|---|---|
| `todo_add` | Add a one-line item (`position: "top" \| "bottom"`, default bottom) |
| `todo_list` | List items in priority order (`include_done: false` to hide done) |
| `todo_toggle` | Check/uncheck (`done?` to set explicitly, omit to flip) |
| `todo_update` | Edit an item's text |
| `todo_reorder` | Persist a full priority order — `ids` must be a permutation of current ids |
| `todo_move` | Move one item to an index (clamped) |
| `todo_remove` | Delete an item |
| `todo_clear_done` | Remove every completed item |

`todo_reorder` rejects any missing, duplicate, or unknown id so a stale view can't
silently drop items.

## CLI

```bash
dove-todo mcp [--smoke]      # run the MCP stdio server (used by .mcp.json)
dove-todo list [--all]       # priority order; --all includes done
dove-todo add [--top] <text> # add a one-line item
dove-todo done <id>          # mark done   (undone <id> to reverse)
dove-todo remove <id>        # delete
dove-todo clear-done         # drop all completed
dove-todo where              # print the storage root
```

## Register as an MCP server

```json
{
  "mcpServers": {
    "todo": {
      "command": "npx",
      "args": ["-y", "@tenonhq/dovetail-todo", "mcp"],
      "env": {
        "DOVE_DASHBOARD_URL": "${DOVE_DASHBOARD_URL}"
      }
    }
  }
}
```

`DOVE_DASHBOARD_URL` (optional, default `http://localhost:3456`) sets the deep link
`todo_add` returns. The dashboard panel lives at `<dashboard>/todos`.

## License

GPL-3.0
