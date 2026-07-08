# Delete ServiceNow Records

## Task

$ARGUMENTS

## Instructions for Claude

### Directory Context

Dovetail commands can be run from two locations:

- **From `ServiceNow/` directory:** `npx sinc <command>`
- **From Craftsman root:** `npm run sinc:<command>` (proxy scripts)

The `delete` command requires running from the `ServiceNow/` directory directly, as it accepts flags and arguments that npm run scripts don't forward.

---

Help the user delete records from a ServiceNow instance using Dovetail's `delete` command. After deletion, local files and the manifest are automatically cleaned up.

### Command Syntax

```bash
npx dove delete <table> [name] [options]
```

### Options

| Flag           | Alias | Type    | Description                                      |
| -------------- | ----- | ------- | ------------------------------------------------ |
| `--scope`      | `-s`  | string  | Target scope (e.g., x_cadso_core)                |
| `--sysid`      |       | string  | Delete by sys_id directly (skip manifest lookup) |
| `--ci`         |       | boolean | Skip confirmation prompt                         |
| `--keep-local` |       | boolean | Keep local files after instance delete           |

### Examples

#### Delete by record name (interactive)

```bash
npx dove delete sys_script_include MyOldUtil
# Prompts for: scope (if not determinable), confirmation
```

#### Delete with scope

```bash
npx dove delete sys_script_include MyOldUtil --scope x_cadso_core
```

#### Delete by sys_id

```bash
npx dove delete sys_script_include --sysid abc123def456789012345678901234ab --scope x_cadso_core
```

#### Delete but keep local files

```bash
npx dove delete sys_script_include MyOldUtil --scope x_cadso_core --keep-local
```

#### CI/Automation mode (no prompts)

```bash
npx dove delete sys_script_include MyOldUtil --scope x_cadso_core --ci
```

### What Happens After Delete

1. **Record is deleted** from the ServiceNow instance via `api/cadso/dovetail/deleteRecord`
2. **Local files are removed** — the entire record directory (`src/<scope>/<table>/<name>/`) is deleted
3. **Manifest is updated** — the record entry is removed from `dove.manifest.<scope>.json`
4. If the table has no remaining records, the table entry is also removed from the manifest

### How sys_id Resolution Works

When you provide a **record name** (not `--sysid`):

1. The scope manifest (`dove.manifest.<scope>.json`) is loaded
2. The sys_id is looked up from `manifest.tables[table].records[name].sys_id`
3. If not found, an error is shown with a suggestion to use `--sysid`

### Common Table Names

| Table                    | Deletes               |
| ------------------------ | --------------------- |
| `sys_script_include`     | Script Include        |
| `sys_script`             | Business Rule         |
| `sys_ui_script`          | UI Script             |
| `sys_ui_page`            | UI Page               |
| `sys_ux_client_script`   | UX Client Script      |
| `sys_processor`          | Processor             |
| `sys_ws_operation`       | REST API Operation    |
| `sys_rest_message_fn`    | REST Message Function |
| `sys_ui_action`          | UI Action             |
| `sysevent_script_action` | Event Script Action   |

### Troubleshooting

- **"Record not found in manifest"** — The record isn't tracked locally. Use `--sysid` to delete by sys_id directly, or run `npx dove refresh` first
- **"Missing required fields: table, sys_id"** — Provide the table as the first argument and either a name or `--sysid`
- **"Record not found: table/sys_id"** — The record doesn't exist on the instance (may have been deleted already)
- **"Failed to delete record"** — Check permissions. The user may not have delete access to this table/scope
- **"Local cleanup failed"** — Record was deleted on instance but local files remain. Run `npx dove refresh` to sync
- **Deleted wrong record** — Records deleted from ServiceNow cannot be recovered unless they're in an update set that hasn't been committed. Check update set history
