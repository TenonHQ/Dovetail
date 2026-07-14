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

The dev/prod fallbacks match the names documented in the committed
`Craftsman/.env.example`, so existing developer setups work out of the box.
Bare instance names (e.g. `TenonWorkStudio`) get `.service-now.com` appended
automatically.

```
SN_INSTANCE=tenonworkstudio.service-now.com
SN_USER=...
SN_PASSWORD=...
```

### Selecting a .env file per command

Every `dove-sn` command (and `dove-sn mcp`) loads `.env` from the current
directory by default. Point it at a different file to target another instance:

```bash
npx dove-sn view-flow --sys-id <id> --env .env.prod
npx dove-sn add-choices --env ../envs/workshop.env --table ... --column ...
```

`--env` (alias `--env-file`) wins over the `DOVETAIL_ENV_FILE` env var, which in
turn beats the default `.env`. Variables already present in the environment are
never overridden, so an exported `SN_INSTANCE` still takes precedence over the
file — handy for CI.

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

# Copy a flow / subflow (creates an INACTIVE DRAFT) via the Designer's Copy endpoint
npx dove-sn copy-flow --sys-id <sys_id> --name "My Copy"   # scope defaults to source's

# Create a NEW flow (type=flow) from scratch and PUBLISH it (grafts a template's trigger+action)
npx dove-sn create-flow --name "My Flow" --template <published_flow_sys_id> --scope <scope_sys_id> \
  --trigger-table customer_contact --log-message "hello"            # add --dry-run to preview

# Publish (compile the snapshot of) a flow / subflow after editing in the Designer
npx dove-sn publish-flow --sys-id <sys_id>             # scope defaults to the flow's

# Test a flow: validate (default, read-only) or actually run it
npx dove-sn test-flow --sys-id <sys_id> --inputs '{"phone":"+1555..."}'
npx dove-sn test-flow --sys-id <sys_id> --execute --confirm --inputs '{...}'  # runs it

# Edit a flow in place (rename / description / step inputs)
echo '{"rename":{"name":"New Name"},"patchStepInputs":[{"step":"Calculate SMS Send At","input":"send_rate","value":"5"}]}' > ops.json
npx dove-sn edit-flow --sys-id <sys_id> --from-json ops.json                          # dry-run (diff)
npx dove-sn edit-flow --sys-id <sys_id> --from-json ops.json --apply --update-set <id> # persist

# Edit a Custom Action Type's script and/or output variables, then republish (headless)
npx dove-sn edit-action --sys-id <action_type_sys_id> --scope <scope_sys_id> \
  --patch-script "grabHashData::grabRecipients"                                   # dry-run (diff)
npx dove-sn edit-action --sys-id <id> --scope <scope> --set-script ./script.js \
  --merge-outputs ./output-var.json --apply --update-set <id>                     # persist + publish

# Edit it STRUCTURALLY — several steps' scripts, step-level IO, pill wiring — in one publish
npx dove-sn edit-action --sys-id <id> --scope <scope> --from-json ops.json             # dry-run
npx dove-sn edit-action --sys-id <id> --scope <scope> --from-json ops.json \
  --apply --update-set <id>                                                            # publish + verify
```

### Editing an action type's steps (`--from-json`)

The flag form above patches the one auto-detected script. When you need to touch
more than one step — or the step's own inputs and outputs — pass an ops file:

```json
{
  "patchStepScripts": [
    { "step": "Parse Response", "scriptFile": "./parse-response.js" },
    { "step": "Handle Error", "patchScript": { "find": "gs.error", "replace": "gs.warn" } }
  ],
  "addStepOutputs": [
    { "step": "Parse Response", "name": "isRetryable", "label": "Is Retryable", "type": "boolean" }
  ],
  "addStepInputs": [
    {
      "step": "Handle Error",
      "name": "isRetryable",
      "type": "boolean",
      "pillFrom": { "step": "Parse Response", "output": "isRetryable" }
    }
  ]
}
```

- **`step`** is a step's `cid` **or** its label — an unknown ref fails with the list of steps that do exist.
- **`scriptFile`** is sugar for `setScript`, resolved **relative to the ops file**, so scripts can live beside it.
- **`addStepInputs[].pillFrom`** wires the input to another step's output. You never write the pill
  yourself — the correct format is `{{step[<source_cid>].<output>}}`, and getting it wrong does not
  fail the publish, it compiles a dead reference that reads `undefined` at runtime.
- Ops are **order-independent**: an input may pill from an output added in the same call. Everything
  lands in a **single** `/snapshot` POST.
- Adding IO is **idempotent** — a name that is already present is skipped with a warning, not duplicated.

Two behaviours worth knowing before you rely on this:

**It refuses to guess an entry shape.** A new `extended_inputs` / `extended_outputs` entry is built by
mirroring an existing sibling entry on the same step, because those entries carry more keys than the
four you supply and some are wrapped as `{value: x}` inconsistently. If the step has *no* existing
entry in that list, there is nothing to mirror and the command **errors out** rather than hand-author
an object that would corrupt the action. Author one entry in the Designer first, then re-run.

**It verifies the publish.** A `201` from `/snapshot` means the snapshot compiled — not that your edit
landed as intended. With `--apply`, the steps are read back from the instance and compared against what
was sent; a mismatch prints the diff and exits **2**.

`copy-flow` calls the Designer's own `POST /processflow/flow/{id}/copy` — a
complete, faithful clone created as an **inactive draft**. (Don't publish +
activate a copy of a triggered production flow unless you intend it to fire.)

`create-flow` mints a **brand-new** flow (`sys_hub_flow`, `type=flow`) from scratch
and **publishes** it: `POST /processflow/flow` initialises the envelope, the
trigger + action graph is grafted from a published template flow (`--template`,
ids remapped + values patched via `--trigger-table` / `--trigger-condition` /
`--log-message`), a `versioning/create_version` bookmark is written, then the
`/snapshot` POST compiles it. The result is a **published** flow — a published
triggered flow can fire on its trigger, so do NOT graft a production send template
you don't intend to fire (the `active` flag on the result reports whether it's
live). The
`POST /processflow/flow` create step is the crux: a Table-API / Dovetail
`createRecord` insert never initialises the processflow envelope, so its snapshot
POST silently no-ops (stays draft). Sequence reverse-engineered from Workflow
Studio HARs and validated live (2026-06-02, tenonworkstudio). Exit `0` published
or dry-run; `2` created-but-not-published.
### Create a table (with columns)

```bash
npx dove-sn create-table \
  --name x_cadso_core_error --label Error --scope x_cadso_core \
  --columns "Key:string:255, Severity:choice:50, First Seen On:datetime, Occurence Count:integer:5" \
  --number-prefix ERR --user-role x_cadso_core.user --update-set <sys_id> --dry-run --json
npx dove-sn create-table --from-json ./table.json   # full spec from a file
```

`create-table` mints a **brand-new** table (`sys_db_object`) **with its columns**.
A table create is a privileged platform op — a REST / Dovetail `createRecord`
insert into `sys_db_object` **orphans** the table (a metadata row with no physical
table, no ACLs, no scope wiring). So this replays the Studio form save: a single
`POST /sys_db_object.do` (form-login session → `g_ck`) whose body embeds every
column as a `sys_dictionary` list-edit XML blob (one `<record operation="add">`
per column) plus the Application-Navigator module — yielding the real platform
graph + the physical table + seeded ACLs. Before the save it switches the form
session's **current application** to the target scope (the new table's scope is
governed by the session app, not a form field), so the table, columns, ACLs, and
module all land in `--scope`. Friendly column types are mapped to ServiceNow
internal types (`string` → `string_full_utf8`, Studio's real String type).

`--dry-run` returns the plan + the column XML + the projected graph with no session
and no writes. **Validated live 2026-06-13** (tenonworkstudio): a 6-column create
landed the correctly-scoped table, all columns, ACLs + role, the module, and the
full graph in the pinned update set, and a scoped insert round-tripped. Still: pin
`--update-set <sys_id>` and verify the `sys_update_xml` rows afterward. `--debug`
adds diagnostics (app-switch status, resolved column key, assigned sys_id) to the
result note. Ground truth (the HAR dissection) lives in the CTO repo's create-table
docs.

### Set a field on a record

Set scalar field value(s) on an **existing** data record, capture the change into
an update set, then read it back and verify.

```bash
# Target by sys_id
npx dove-sn set-field \
  --table x_cadso_core_metric_point_type --sys-id <sys_id> \
  --fields "order=20" --update-set <sys_id> --dry-run --json

# Or target by a query that resolves to EXACTLY one row
npx dove-sn set-field \
  --table x_cadso_core_metric_point_type --query "name=send_size" \
  --fields "order=20,label=Send Size" --update-set <sys_id>
```

`set-field` wraps the update-set-aware `pushWithUpdateSet` core op (update-set +
scope switching handled server-side, so no `sys_user_preference` is touched), then
re-queries the record and verifies each value landed. It **refuses** schema tables
(`sys_db_object` / `sys_dictionary`) — use `add-column` / `create-table` for those.
`--fields` is a comma-separated `key=value` map (values are sent as strings;
ServiceNow coerces); `--update-set` is required so the change is captured;
`--dry-run` reads the current values and prints the plan without writing. Exit
codes: `0` applied / dry-run, `1` bad args, `2` write landed but read-back did not
verify.

### Create a record

Insert **one** new data record, owned by an explicit scope and captured into an
update set, then read it back and verify.

```bash
npx dove-sn create-record \
  --table x_cadso_core_metric_point_type \
  --fields "name=avg_message_parts,label=Avg. Message Parts,order=35" \
  --scope x_cadso_core --update-set <sys_id> \
  --if-absent "name=avg_message_parts" --dry-run --json
```

`create-record` wraps the scope- and update-set-aware `createRecord` core op, which
switches the executing user's app scope + update set server-side, inserts, and
restores both — so the record is owned by the right app and the insert is captured
in the right update set. Like `set-field` it **refuses** schema tables and verifies
via read-back. `--scope` and `--update-set` are required; `--if-absent
"<encoded-query>"` makes re-runs idempotent (the insert is skipped when the query
already matches a row). Exit codes: `0` created / skipped-in-sync / dry-run, `1` bad
args, `2` write landed unverified (or skipped with drift). To **update** an existing
record instead, use `set-field`.

Both verbs are exported for programmatic use:

```ts
import { createClient, setField, createRecord } from "@tenonhq/dovetail-servicenow";

var client = createClient({});
var r = await setField({
  client: client,
  table: "x_cadso_core_metric_point_type",
  sysId: "<sys_id>",
  fields: { order: "20" },
  updateSetSysId: "<sys_id>"
});
console.log(r.status, r.verified); // "applied" true
```

### Invoke an arbitrary REST operation

Invoke any authenticated ServiceNow REST operation — an application's own
Scripted REST endpoints (`sys_ws_operation` at `/api/<scope>/<service>/<resource>`)
included — with GET, POST, PUT or DELETE. This is the transport primitive for
operations the fixed verbs can't express, and the only surface with PUT/DELETE
coverage (a verification harness that cleans up after itself needs the DELETE).

```bash
# Dry-run — the DEFAULT: echoes method + path + body, sends NOTHING
npx dove-sn invoke-rest --method DELETE \
  --path /api/x_cadso_core/testkit/resource/<sys_id>

# Send for real
npx dove-sn invoke-rest --method PUT \
  --path /api/x_cadso_core/testkit/resource/<sys_id> \
  --body '{"name":"updated"}' --confirm --json
```

`invoke-rest` is **dry-run by default** — nothing is sent without `--confirm`
(`--dry-run` forces a dry-run even with it). On send the response passes through
**verbatim** as `{ httpStatus, ok, body }`: non-2xx responses are returned, not
thrown, so the operation's own error contract survives (the transport still
retries 429/5xx first). The path must be instance-relative and start with
`/api/`. **Bodies are never printed in human output** — request or response,
dry-run or sent: method, path and status only. The structured `--json` result
is the one channel that carries them (a dry-run's `requestBody` echo lives
there). Exit codes: `0` dry-run or 2xx, `1` bad args, `2` sent but non-2xx.

Programmatic: `invokeRest({ method, path, body, confirm })` is exported, and the
client gained `now.put` / `now.delete` / `now.invoke` (the latter returns
`{ status, body }` verbatim) alongside the existing `now.get` / `now.post`.

`test-flow` defaults to **validate** — a safe pre-flight (published? inputs match
declared variables?) that never runs the flow; `--execute --confirm` runs it via
the server-side FlowAPI runner (deploy `resources/runFlow.md` first).

`edit-flow` defaults to a **dry-run** diff. With `--apply`: rename/description are
written to `sys_hub_flow` through the update-set-aware API (so `--update-set` is
**required** for those), while `patchStepInputs` ride a snapshot recompile (the
`/snapshot` POST persists step input values but NOT top-level flow fields).
Step-input persistence via the snapshot POST is verified for action types but is
**best-effort for flows** — after the recompile, `edit-flow` reads the model back
and **warns** if a value didn't actually persist, so a no-op never reports as a
silent success.

`edit-action` edits a **published Custom Action Type** headlessly: it GETs the
model, fetches the steps from `.../{id}/step_instances` (the model GET returns
`steps:null`), patches the script step input (`--patch-script "<find>::<replace>"`
or `--set-script <file>`) and/or merges output-variable definitions
(`--merge-outputs <json>`, matched by `name`), grafts the steps back, and POSTs
`/snapshot` to recompile — the same snapshot POST `publishActionType` uses, which
persists step input values back to `sys_variable_value`. It deliberately avoids
the Designer's model PUT, whose client-side step transform is unsafe to
hand-reconstruct. Dry-run (diff) by default; `--apply` republishes, and
`--update-set <id>` pins the capture into a chosen update set.

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
`set_related_lists`, `add_choices_to_field`, the schema verbs `create_table` /
`add_column`, the record-write verbs `set_field` (update scalar fields on an
existing record) and `create_record` (insert one record) — both update-set-captured
and read-back-verified — `host_assets` (deploy a built dist/), plus the Flow Designer
tools `flow_view` (read a flow/subflow's step graph), `action_view` (read an action
type's model), `action_edit` (structurally edit a published action type — per-step
scripts, step-level inputs/outputs, data-pill wiring — dry-run by default, and the
publish is read back and verified), `flow_publish` (compile a flow/subflow snapshot), `flow_copy`
(copy a flow as an inactive draft), `flow_create` (create a NEW flow from scratch +
publish, grafting a template), `flow_test` (validate or run a flow), and
`flow_edit` (patch a flow), plus `invoke_rest` (invoke an arbitrary authenticated
REST operation — Scripted REST included — with GET/POST/PUT/DELETE; dry-run by
default, response passed through verbatim, bodies never logged). It reads
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
`docs/servicenow-flow-designer-headless-authoring.md` in the Craftsman repo.

## Roadmap

The same query-to-diff pattern will continue across the rest of the
`sinch-dlr-manual-steps` work: indexes (`sys_db_object_ix`), table properties
(`accessible_from`), `sys_trigger` and `sys_property` creation.
