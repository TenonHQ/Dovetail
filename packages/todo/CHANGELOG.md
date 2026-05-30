# Changelog — @tenonhq/dovetail-todo

## v0.0.1 — initial release

A drag-to-reorder priority TODO checklist for Claude Code and the Dovetail dashboard.

- **MCP stdio server (8 tools):** `todo_add`, `todo_list`, `todo_toggle`, `todo_update`, `todo_reorder`, `todo_move`, `todo_remove`, `todo_clear_done`. Run via `dove-todo mcp`.
- **CLI (`dove-todo`):** `list`, `add [--top]`, `done`/`undone`, `remove`, `clear-done`, `where`, plus `mcp [--smoke]`.
- **Store:** a single ordered `~/.dovetail/todos/todos.json` written atomically (tmp + rename). Array order is priority (index 0 = top). Override the location with `DOVE_TODO_DIR`.
- **Reorder safety:** `todo_reorder` requires `ids` to be a complete permutation of the current ids — missing, duplicate, or unknown ids are rejected so a stale view can't drop items.
- **Dashboard panel:** `@tenonhq/dovetail-dashboard` gains a `/todos` page (one-line input, checkboxes, drag-the-handle reorder) that reads/writes the same store through this package's storage layer and streams changes over SSE.
