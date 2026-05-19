# @tenonhq/dovetail-servicenow

ServiceNow platform helpers for Dovetail. The first shipped feature is
**`addChoicesToField`** — upserts `sys_choice` rows for a given `table.column`
and flips `sys_dictionary.choice` in one idempotent call, with every write
captured in the update set you pass in.

## Why

Adding choice values to a scoped ServiceNow field is a 3-part ritual:

1. Find the `sys_dictionary` row for `(table, column)` and set its `choice`
   field (0 = none, 1 = suggestion, **3 = dropdown w/ `-- None --`**).
2. Create one `sys_choice` row per value/label pair, with `sys_scope` matching
   the dictionary record.
3. Make sure your user's current update set points at the *right* update set
   (not Default), or the whole change set gets trapped.

This package collapses it into:

```ts
await addChoicesToField(client, {
  table: "x_cadso_core_event",
  column: "state",
  updateSetSysId: "0083c3bb33d003507b18bc534d5c7b6d",
  choices: [
    { value: "delivered", label: "Delivered" },
    { value: "failed",    label: "Failed" }
  ]
});
```

Writes go through the **Dovetail Scripted REST API** (`/api/cadso/dovetail/*`,
historically named "Claude" at `/api/cadso/claude/*`; the client falls back to
the legacy path on instances where the rename hasn't been imported yet). The
API pins every write to the supplied update set regardless of the REST user's
current preference, so re-running with the same inputs is safe — every row
comes back as `unchanged`.

## Install

```bash
npm install @tenonhq/dovetail-servicenow
```

Requires Node 20 LTS.

## Configure

Reads ServiceNow credentials from env vars in this order of precedence:

| Field    | Preferred       | Dev fallback        | Prod fallback        |
|----------|-----------------|---------------------|----------------------|
| Host     | `SN_INSTANCE`   | `SN_DEV_INSTANCE`   | `SN_PROD_INSTANCE`   |
| User     | `SN_USER`       | `SN_DEV_USERNAME`   | `SN_PROD_USERNAME`   |
| Password | `SN_PASSWORD`   | `SN_DEV_PASSWORD`   | `SN_PROD_PASSWORD`   |

The dev/prod fallbacks match the names already documented in
`Craftsman/CLAUDE.local.md`, so existing developer setups work out of the box.
Bare instance names (e.g. `TenonWorkStudio`) get `.service-now.com` appended
automatically.

```
SN_INSTANCE=tenonworkstudio.service-now.com
SN_USER=...
SN_PASSWORD=...
```

## CLI

```bash
# Inline form
npx dove-sn add-choices \
  --table x_cadso_core_event \
  --column state \
  --update-set 0083c3bb33d003507b18bc534d5c7b6d \
  --choices "delivered=Delivered,failed=Failed,expired=Expired"

# JSON payload form (recommended for >5 choices)
npx dove-sn add-choices --from-json ./choices.json
```

JSON payload shape:

```json
{
  "table": "x_cadso_core_event",
  "column": "state",
  "updateSetSysId": "0083c3bb33d003507b18bc534d5c7b6d",
  "choiceType": 3,
  "choices": [
    { "value": "delivered", "label": "Delivered" },
    { "value": "failed",    "label": "Failed" }
  ]
}
```

## Programmatic

```ts
import { createClient, addChoicesToField } from "@tenonhq/dovetail-servicenow";

var client = createClient({});
var result = await addChoicesToField(client, { /* ... */ });

console.log(result.choices);
// [
//   { value: "delivered", label: "Delivered", sysId: "...", action: "created" },
//   { value: "failed",    label: "Failed",    sysId: "...", action: "created" }
// ]
```

## Form, list & view layouts

The same query-to-diff, update-set-captured pattern now covers ServiceNow form
and list layouts. Four declarative, idempotent functions reconcile the `sys_ui_*`
tables — you describe the layout you want, the function writes only the delta.

| Function | What it sets | ServiceNow tables |
|----------|--------------|-------------------|
| `createView` | a named custom view | `sys_ui_view` |
| `setListLayout` | the columns of a list | `sys_ui_list`, `sys_ui_list_element` |
| `setFormLayout` | the sections + fields of a form | `sys_ui_form`, `sys_ui_form_section`, `sys_ui_section`, `sys_ui_element` |
| `setRelatedLists` | which related lists appear on a form | `sys_ui_related_list`, `sys_ui_related_list_entry` |

All four are **idempotent** (re-running reports every record `unchanged`),
**update-set-captured** (every create / update / delete lands in the update set
you pass — deletes pin the session update set first), and support **`dryRun`**
(plan the writes without performing them) and **`prune`** (default `true` —
delete records absent from your spec; pass `false` to only add / reorder).

An empty or omitted `view` targets the **Default view**. A named `view` that
does not exist yet is created automatically.

### CLI

```bash
# Create a custom view
npx dove-sn create-view --name sales_support --title "Sales Support" \
  --update-set 0083c3bb33d003507b18bc534d5c7b6d

# Set a list layout (inline columns, or --from-json)
npx dove-sn set-list-layout \
  --table x_cadso_automate_audience \
  --columns "number,name,state" \
  --update-set 0083c3bb33d003507b18bc534d5c7b6d \
  --dry-run

# Set a form layout (sections are nested — pass a JSON spec)
npx dove-sn set-form-layout --from-json ./form.json

# Set the related lists shown on a form
npx dove-sn set-related-lists \
  --table x_cadso_automate_audience \
  --related-lists "x_cadso_automate_audience_member.audience" \
  --update-set 0083c3bb33d003507b18bc534d5c7b6d
```

`set-form-layout` JSON payload shape:

```json
{
  "table": "x_cadso_automate_audience",
  "view": "",
  "updateSetSysId": "0083c3bb33d003507b18bc534d5c7b6d",
  "prune": true,
  "sections": [
    { "fields": ["name", "active", "description"] },
    { "caption": "Meta Data", "fields": ["created_by", "updated_on"] }
  ]
}
```

The first section is the **primary section** — omit its `caption`.

### Programmatic

```ts
import { createClient, setFormLayout, formatLayoutResult } from "@tenonhq/dovetail-servicenow";

var client = createClient({});
var result = await setFormLayout(client, {
  table: "x_cadso_automate_audience",
  view: "",
  updateSetSysId: "0083c3bb33d003507b18bc534d5c7b6d",
  sections: [
    { fields: ["name", "active"] },
    { caption: "Meta Data", fields: ["created_by"] }
  ]
});
console.log(formatLayoutResult("form layout", result));
```

## MCP server

`dove-sn mcp` runs a self-contained MCP stdio server exposing the write tools to
Claude Code and agents: `create_view`, `set_list_layout`, `set_form_layout`,
`set_related_lists`, and `add_choices_to_field`. It reads ServiceNow credentials
from the same env vars as the CLI.

```bash
npx dove-sn mcp --smoke   # list the registered tools and exit
npx dove-sn mcp           # run the stdio server (wire into .mcp.json)
```

`.mcp.json` entry:

```json
{ "mcpServers": { "dovetail-servicenow": { "command": "npx", "args": ["dove-sn", "mcp"] } } }
```

This server is separate from `@tenonhq/dovetail-mcp` (the read-only cross-system
aggregator) — `dovetail-servicenow`'s server is the ServiceNow **write** surface.

## Roadmap

The same query-to-diff pattern will continue across the rest of the
`sinch-dlr-manual-steps` work: indexes (`sys_db_object_ix`), table properties
(`accessible_from`), `sys_trigger` and `sys_property` creation.
