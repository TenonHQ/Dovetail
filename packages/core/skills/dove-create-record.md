# Create ServiceNow Records

## Task

$ARGUMENTS

## Instructions for Claude

### Directory Context

Dovetail commands can be run from two locations:

- **From `ServiceNow/` directory:** `npx sinc <command>`
- **From Craftsman root:** `npm run sinc:<command>` (proxy scripts)

The `create` command requires running from the `ServiceNow/` directory directly, as it accepts flags and arguments that npm run scripts don't forward.

---

Help the user create new records on a ServiceNow instance using Dovetail's `create` command. After creation, the record is automatically pulled back and scaffolded locally.

### Command Syntax

```bash
npx dove create <table> [options]
```

### Options

| Flag      | Alias | Type    | Description                         |
| --------- | ----- | ------- | ----------------------------------- |
| `--name`  | `-n`  | string  | Record name                         |
| `--scope` | `-s`  | string  | Target scope (e.g., x_cadso_core)   |
| `--from`  | `-f`  | string  | Path to JSON file with field values |
| `--field` |       | array   | Inline field values (key=value)     |
| `--ci`    |       | boolean | Skip interactive prompts            |

### Examples

#### Create a Script Include (interactive)

```bash
npx dove create sys_script_include
# Prompts for: name, scope
```

#### Create with flags

```bash
npx dove create sys_script_include --name "MyNewUtil" --scope x_cadso_core
```

#### Create with inline field values

```bash
npx dove create sys_script_include \
  --name "MyNewUtil" \
  --scope x_cadso_core \
  --field active=true \
  --field access=public
```

#### Create from JSON file

```bash
npx dove create sys_script_include --from new-script.json --scope x_cadso_core
```

**JSON file format (`new-script.json`):**

```json
{
  "name": "MyNewUtil",
  "active": "true",
  "access": "public",
  "script": "var MyNewUtil = Class.create();\nMyNewUtil.prototype = {\n  initialize: function() {},\n  type: 'MyNewUtil'\n};"
}
```

#### Create a Business Rule

```bash
npx dove create sys_script --name "Validate Record" --scope x_cadso_automate
```

#### CI/Automation mode

```bash
npx dove create sys_script_include \
  --name "AutoCreated" \
  --scope x_cadso_core \
  --from record.json \
  --ci
```

### What Happens After Create

1. **Record is created** on the ServiceNow instance via the `api/cadso/dovetail/createRecord` endpoint
2. **GlideRecord** uses `initialize()` and `newRecord()` to ensure all default values are set
3. **Manifest is refreshed** for the target scope
4. **Local files are scaffolded** — directory, field files (script.js, etc.), and metaData.json
5. **You can immediately begin editing** the local files and push changes

### Update Set Integration

If the target scope has an active update set configured (via `.dove-update-sets.json` or the dashboard), the new record is created within that update set.

```bash
# Set up update set first
npx dove createUpdateSet --name "FEAT-123" --scope x_cadso_core

# Create record — automatically goes into FEAT-123 update set
npx dove create sys_script_include --name "NewFeature" --scope x_cadso_core
```

### Common Table Names

| Table                    | Creates                                    |
| ------------------------ | ------------------------------------------ |
| `sys_script_include`     | Script Include (server-side utility class) |
| `sys_script`             | Business Rule                              |
| `sys_ui_script`          | UI Script (client-side)                    |
| `sys_ui_page`            | UI Page                                    |
| `sys_ux_client_script`   | UX Client Script                           |
| `sys_processor`          | Processor                                  |
| `sys_ws_operation`       | REST API Operation                         |
| `sys_rest_message_fn`    | REST Message Function                      |
| `sys_ui_action`          | UI Action                                  |
| `sysevent_script_action` | Event Script Action                        |

### Troubleshooting

- **"Table name is required"** — Provide the table as the first argument: `npx dove create sys_script_include`
- **"Record name is required"** — Use `--name` flag or include `name` in the JSON file
- **"Scope is required in CI mode"** — Add `--scope x_cadso_core` when using `--ci`
- **"Failed to create record"** — Check that the `api/cadso/dovetail/createRecord` endpoint exists on the target instance
- **"Local sync failed"** — Record was created on instance. Run `npx dove refresh` to pull it manually
- **Record not in expected update set** — Verify `.dove-update-sets.json` has the correct scope mapping. Use `npx dove currentUpdateSet` to check
