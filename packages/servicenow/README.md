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

# View a flow / subflow's compiled step graph (read-only, headless)
npx dove-sn view-flow --sys-id 327c53bfc33e3250d4ddf1db05013135
npx dove-sn view-flow --sys-id <sys_id> --json --raw   # structured + full model

# View a Custom Action Type's model (inputs/outputs)
npx dove-sn view-action --sys-id <action_type_sys_id> --scope <scope_sys_id>

# Publish (compile the snapshot of) a flow / subflow after editing in the Designer
npx dove-sn publish-flow --sys-id <sys_id>             # scope defaults to the flow's

# Test a flow: validate (default, read-only) or actually run it
npx dove-sn test-flow --sys-id <sys_id> --inputs '{"phone":"+1555..."}'
npx dove-sn test-flow --sys-id <sys_id> --execute --confirm --inputs '{...}'  # runs it

# Edit a flow in place (rename / description / step inputs), then publish
echo '{"rename":{"name":"New Name"},"patchStepInputs":[{"step":"Calculate SMS Send At","input":"send_rate","value":"5"}]}' > ops.json
npx dove-sn edit-flow --sys-id <sys_id> --from-json ops.json            # dry-run (diff)
npx dove-sn edit-flow --sys-id <sys_id> --from-json ops.json --apply    # publish the edit
```

`test-flow` defaults to **validate** — a safe pre-flight (published? inputs match
declared variables?) that never runs the flow. `--execute --confirm` runs it via
the server-side FlowAPI runner (deploy `resources/runFlow.md` first); running a
flow can cause real side effects. `edit-flow` defaults to a **dry-run** diff;
`--apply` re-publishes the patched model via the snapshot endpoint.

`view-flow` reads `GET /api/now/processflow/flow/{id}` — the Designer's own model
endpoint — and prints the ordered, nesting-aware action + flow-logic step graph
plus the flow variables. This works for the integration user with plain basic
auth; the raw `sys_hub_flow_snapshot` Table API 404 is a row-level restriction on
the working snapshot, not a barrier. `publish-flow` POSTs the model back to
`.../flow/{id}/snapshot`, recompiling the current design (a write).

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

`dove-sn mcp` runs a self-contained MCP stdio server exposing the tools to
Claude Code and agents: `create_view`, `set_list_layout`, `set_form_layout`,
`set_related_lists`, `add_choices_to_field`, plus the Flow Designer tools
`flow_view` (read a flow/subflow's step graph), `action_view` (read an action
type's model), `flow_publish` (compile a flow/subflow snapshot), `flow_test`
(validate or run a flow), and `flow_edit` (patch a flow + publish). It reads
ServiceNow credentials from the same env vars as the CLI.

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

## Publishing a Custom Action Type

`publishActionType` compiles the `sys_hub_flow_snapshot` for a Custom Action Type
— the step that makes it draggable in the Flow Designer palette. This replays the
Designer's **Publish** button, which is a plain REST call that **works with basic
auth** (no session cookie, CSRF token, or `sn_build_agent` role):

```
GET  /api/now/processflow/action/action_types/{sysId}?sysparm_transaction_scope={scope}
       -> 200, the full action-type model EXCEPT `steps` (always returns null)
POST /api/now/processflow/action/action_types/{sysId}/snapshot?sysparm_transaction_scope={scope}
       body = the model with a `steps` array grafted in
       -> 201 Created (compiles the snapshot; also persists step input values
          back to sys_variable_value)
```

This is the **real** snapshot compiler and supersedes `triggerPublication` for
action types — that function ships in degraded mode (it only sets
`status="published"` and polls, because the snapshot trigger was unknown when it
was written). `triggerPublication` is retained for back-compat and the subflow path.

```ts
import { createClient, publishActionType } from "@tenonhq/dovetail-servicenow";

var client = createClient({});
var result = await publishActionType({
  client: client,
  sysId: "60e6743e33814bd07b18bc534d5c7b9e",      // sys_hub_action_type_definition
  scopeSysId: "cd61acbbc3c85a1085b196c4e40131bd",  // sysparm_transaction_scope
  steps: require("./fixtures/my-action.steps.json") // see caveat below
});
// { status: "published", httpStatus: 201, snapshotSysId?: "..." }
```

### Steps-fixture caveat (required)

The GET returns **`steps: null`** even for an already-published action — the
Designer assembles `steps` client-side from the step records. So to publish you
**must supply a `steps` fixture** via `params.steps`. Each step's `action` field
is remapped to the target `sysId` automatically. If you omit `steps` and the
fetched model has no usable `steps` array, `publishActionType` throws with a clear
message. For a faithful clone, capture the source action's `steps` from a HAR of
the Publish call and store it as a fixture beside your driver.

Full recipe and the 6-record action-type graph:
`docs/servicenow-flow-designer-headless-authoring.md` in the CTO repo.

## Roadmap

The same query-to-diff pattern will continue across the rest of the
`sinch-dlr-manual-steps` work: indexes (`sys_db_object_ix`), table properties
(`accessible_from`), `sys_trigger` and `sys_property` creation.
