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

### Flow Designer identity (`SN_FLOW_*`)

`/api/now/processflow/*` — every Flow Designer authoring call (view/edit/clone/
publish an action, create/copy/publish a flow) — **cannot carry a REST API access
policy** on ServiceNow, so under API-key auth (`SN_API_KEY`) those calls 401. They
authenticate instead with a dedicated basic-auth identity used **only** for
processflow paths; every other path keeps the main identity:

| Field    | Preferred          | Dev fallback           | Prod fallback           |
|----------|--------------------|------------------------|-------------------------|
| User     | `SN_FLOW_USER`     | `SN_DEV_FLOW_USER`     | `SN_PROD_FLOW_USER`     |
| Password | `SN_FLOW_PASSWORD` | `SN_DEV_FLOW_PASSWORD` | `SN_PROD_FLOW_PASSWORD` |

- **Key mode + flow identity** → processflow requests go out as basic auth with the
  flow identity and **no** `x-sn-apikey` header; table/Dovetail requests keep the key.
- **Basic mode, no flow identity** → unchanged: processflow uses the main `SN_USER`.
- **Key mode, no flow identity** → a processflow call **throws before sending**, naming
  `SN_FLOW_USER` / `SN_FLOW_PASSWORD` (it would only 401). A half-set pair also throws.
- Programmatic: `createClient({ apiKey, flowUser, flowPassword })` — explicit config beats
  env. A config that pins the main identity (apiKey or user/password — e.g. one resolved
  from an `--env` file) takes the flow identity from the config only, never from
  `process.env`, so a per-call retarget can't borrow another instance's flow creds.
- `--env <file>` fully determines both identities: the `SN_FLOW_*` / `SN_DEV_FLOW_*` /
  `SN_PROD_FLOW_*` keys are connection keys, replaced (or cleared) from the file.

The flow password is never logged; errors name the variables, never their values.

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

# Retire values — a SOFT delete (sets inactive=true), never a row drop
npx dove-sn remove-choices \
  --table x_cadso_core_event \
  --column state \
  --update-set 0083c3bb33d003507b18bc534d5c7b6d \
  --values "expired,failed"

# Preview either verb — reads happen, NOTHING is written
npx dove-sn add-choices    --table ... --column ... --update-set ... --choices "..." --dry-run
npx dove-sn remove-choices --table ... --column ... --update-set ... --values  "..." --dry-run
```

`--dry-run` still resolves the field and the update set (so a mistyped column or a
closed update set fails exactly as it would live), then reports what the live run
would do without sending a single write. Rows are tagged `[would create]` /
`[would update]` / `[would deactivate]` — never `[created]` — and the header reads
`(DRY RUN — nothing written)`. The `--json` result carries `dryRun: true` and the
same `would-*` action values.

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

`remove-choices` takes the same `--from-json` form, with a `values` array in
place of `choices`.

### Removal semantics

- **Soft delete.** Sets `sys_choice.inactive = true`; the row is retained and
  the operation is reversible by re-adding the value. `sys_dictionary.choice` is
  left alone — retiring values does not un-make the column a choice field.
- **Idempotent.** `deactivated` (a live row was flipped) / `unchanged` (already
  inactive) / `missing` (no such value on the field). Re-running writes nothing.
- **Case-sensitive, with a hint.** `sys_choice.value` is case-sensitive, so
  `--values DELIVERED` does **not** match a stored `delivered` — it reports
  `missing`. When the field holds the same spelling in a different case, the row
  carries `nearMatches` (the stored spelling(s)) and the CLI prints
  `[missing] DELIVERED — no exact match; did you mean "delivered"? (choice values are case-sensitive)`.
  Matching is never case-folded: a field holding both `delivered` and
  `Delivered` treats them as two distinct values, and a request for either one
  touches only its own row.
- **Duplicates.** `sys_choice` has no uniqueness constraint on
  `(name, element, value, language)`, so a field can hold several live rows for
  one value. Every live row is deactivated, and `sysIds` lists all of them — a
  length above 1 is your signal the field needs cleaning up.
- **Inherited choices are not covered.** Matching is scoped to
  `sys_choice.name = <table>`, so a value defined on a *parent* table reports
  `missing` rather than being deactivated. Hiding one on a child table needs an
  override row this verb does not write.
- **Promotion.** ServiceNow captures the change as a single `Choice list` record
  for the whole column, not one per value — so promoting the update set moves
  the entire choice-list state for that column.

## Programmatic

```ts
import {
  createClient,
  addChoicesToField,
  removeChoicesFromField,
  ChoiceWriteError,
} from "@tenonhq/dovetail-servicenow";

var client = createClient({});
var result = await addChoicesToField(client, { /* ... */ });

console.log(result.choices);
// [
//   { value: "delivered", label: "Delivered", sysId: "...", sysIds: ["..."], action: "created" },
//   { value: "failed",    label: "Failed",    sysId: "...", sysIds: ["..."], action: "created" }
// ]

var removed = await removeChoicesFromField(client, {
  table: "x_cadso_core_event",
  column: "state",
  updateSetSysId: "0083c3bb33d003507b18bc534d5c7b6d",
  values: ["expired"],
});
// removed.choices[0] -> { value: "expired", sysId: "...", sysIds: ["..."], action: "deactivated" }

// Plan without writing — identical reads, zero writes, `would-*` actions
var plan = await addChoicesToField(client, { /* ... */ dryRun: true });
// plan.dryRun -> true;  plan.choices[0].action -> "would-create" | "would-update" | "unchanged"
```

### Result shape

Both verbs return the **same `field` envelope**, so one consumer can format either:

```ts
interface ChoiceFieldRef {
  table: string;
  column: string;
  language: string;        // remove: the language matched; add: the default for choices without one
  scope: string;           // sys_scope sys_id of the dictionary record
  dictionarySysId: string;
}

interface AddChoicesResult {
  field: ChoiceFieldRef;
  dictionary: { choiceWas: ChoiceType; choiceNow: ChoiceType };  // add-only transition
  updateSet: { sysId: string; name: string };
  dryRun: boolean;
  choices: Array<ChoiceActionResult>;    // action: created | updated | unchanged | would-create | would-update
}

interface RemoveChoicesResult {
  field: ChoiceFieldRef;
  updateSet: { sysId: string; name: string };
  dryRun: boolean;
  choices: Array<ChoiceRemovalResult>;   // action: deactivated | unchanged | missing | would-deactivate
}                                        // + nearMatches?: string[] on a case-only "missing"
```

> **Breaking change (0.0.x).** Earlier releases returned
> `AddChoicesResult.dictionary: { sysId, scope, choiceWas, choiceNow }` and a
> `RemoveChoicesResult.field` without `scope`. The dictionary sys_id now lives at
> `field.dictionarySysId` on both verbs and `scope` at `field.scope`;
> `dictionary` keeps only the choice-type transition. Consumers reading
> `result.dictionary.sysId` or `result.dictionary.scope` must move to `result.field`.

Both verbs write one value at a time. If a write fails partway through they
throw a **`ChoiceWriteError`** carrying `completed` (the values that already
landed, in result shape), `failedValue` (the one that threw — its state on the
instance is unknown), and `cause` (the original error). Catch it rather than
re-querying the instance to work out how far the run got:

```ts
try {
  await removeChoicesFromField(client, params);
} catch (e) {
  if (e instanceof ChoiceWriteError) {
    console.error("already deactivated:", e.completed.map((r) => r.value));
    console.error("verify by hand:", e.failedValue);
  }
  throw e;
}
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

# Clone a Custom Action Type (every step + its step IO) into a scope and publish it
npx dove-sn clone-action --from <source_sys_id> --name "Send REST (Spoke)" \
  --scope x_cadso_email_spok --ops ops.json                                            # dry-run (plan)
npx dove-sn clone-action --from <source_sys_id> --name "Send REST (Spoke)" \
  --scope x_cadso_email_spok --ops ops.json --update-set <id> --confirm                # write + publish + verify

# Define an action type's inputs, outputs and steps (script + REST, pill-wired) like the Designer's Save
npx dove-sn define-action --sys-id <id> --scope x_cadso_email_spok --spec spec.json      # dry-run (diff)
npx dove-sn define-action --sys-id <id> --scope x_cadso_email_spok --spec spec.json \
  --update-set <id> --confirm --publish                                                # save + verify + publish
```

### Cloning an action type (`clone-action` / `action_clone`)

`clone-action` copies a Custom Action Type headlessly — **multi-step capable** — and
publishes the copy:

1. **Reads** (Table API only — `sn_build_agent` is never used) the parent
   `sys_hub_action_type_definition`, its `sys_hub_action_input` / `sys_hub_action_output`
   (`model_id` → parent), every `sys_hub_step_instance` (**`action`** → parent), and each
   step's `sys_hub_step_ext_input` / `sys_hub_step_ext_output` (`model_id` → step).
2. **Plans** fresh sys_ids for every record (old→new step map), the target scope,
   `name` = `--name`, `internal_name` = `--internal-name` or the slug of the name
   (lowercase, non-alphanumerics → `_`), `state = draft`, and strips system/snapshot
   fields (`master_snapshot`, `latest_snapshot`, `sys_update_name`, audit fields, …).
3. **Writes** the graph through Dovetail `createRecord`, pinned to `--update-set`, scope
   set per record.
4. **Publishes**: the SOURCE action's steps are fetched from
   `/processflow/action/action_types/{source}/step_instances`, each step's `action` and
   `sys_id` remapped onto the clone, `--ops` applied, then grafted onto the clone's model
   and POSTed to `/snapshot` — no steps fixture needed.
5. **Verifies** by reading the clone's steps back (script hash + step IO per step, plus
   the step count). A mismatch exits `1`.

`--scope` takes a scope **name** (resolved via `sys_scope`) or a 32-hex sys_id. The
clone is **idempotent** on `(name, scope)`: an existing match returns `unchanged` and
writes nothing. **Dry-run by default** — without `--confirm` it prints the plan (records
per table, step summary, the effect of every op) and writes nothing; `--update-set` is
required with `--confirm`. Exit `0` on success (incl. dry-run / unchanged), `1` on error.

`--ops` takes the same step ops as `edit-action --from-json`, plus **`setStepInputs`** —
set an **existing** step input's value (and its `display_value` when present), e.g. a
REST step's HTTP method. An unknown input fails with the list of inputs on that step:

```json
{
  "setStepInputs": [
    { "step": "REST Step", "input": "http_method", "value": "post" }
  ],
  "patchStepScripts": [
    { "step": "Parse Response", "patchScript": { "find": "v1", "replace": "v2" } }
  ],
  "addStepOutputs": [{ "step": "Parse Response", "name": "isRetryable", "type": "boolean" }],
  "addStepInputs": [
    { "step": "Handle Error", "name": "isRetryable", "type": "boolean",
      "pillFrom": { "step": "Parse Response", "output": "isRetryable" } }
  ]
}
```

The MCP tool **`action_clone`** takes the same inputs — `from`, `name`, `scope`,
`internalName`, `description`, `updateSetSysId`, `ops` (inline object), `confirm`,
`dryRun` — with the same dry-run-unless-`confirm:true` gate. `setStepInputs` is also
accepted by `edit-action` / `action_edit`.

### Defining an action type's body (`define-action` / `action_define`)

`define-action` authors a Custom Action Type's **action inputs, outputs and steps** —
script steps and REST steps, wired together with data pills — headlessly, the way
the Flow Designer's **Save** button does, and optionally publishes it.

```bash
npx dove-sn define-action --sys-id <action_sys_id> --scope x_cadso_email_spok \
  --spec spec.json                                                  # dry-run: the planned diff
npx dove-sn define-action --sys-id <action_sys_id> --scope x_cadso_email_spok \
  --spec spec.json --update-set <id> --confirm                      # save + verify
npx dove-sn define-action --sys-id <action_sys_id> --scope x_cadso_email_spok \
  --spec spec.json --update-set <id> --confirm --publish            # save + verify + publish
```

How it works (established from two captured Designer saves):

1. `GET /api/now/processflow/action/action_types/{id}` — the model (43 keys; `steps` is null).
2. `GET …/{id}/step_instances` — the real step graph.
3. Merge the spec. Existing steps keep their `cid`; new steps are built from the
   Designer's own step shape for that type (script / REST) with a fresh `cid`.
4. `PUT …/{id}` with the **full** model — the Designer's save is not a delta. Each
   step is sent in the Designer's 11-key shape (`DB_TYPE`, `cid`, `step_type_id`,
   `section`, `label`, `action`, `order`, `inputs`, `extended_inputs`,
   `extended_outputs`, `error_handling_type`).
5. Read the model + steps back and compare them with the plan (a mismatch exits `1`).
6. `--publish`: snapshot through the existing `publishActionType` path.

**Dry-run by default** — without `--confirm` it prints the planned diff (inputs,
outputs and steps added / changed / removed, with each step's input values) and makes
no write. **Idempotent** — a spec that is already in effect is `unchanged` and makes no
PUT. `--update-set` is optional; when given, the REST session is pinned to it before the
save and the publish. Exit `0` on success (incl. dry-run / unchanged), `1` on error or a
failed verify.

**The action shell must already exist.** Creating a brand-new empty action headlessly is
out of scope: make it with `clone-action` or in the Designer, then define its body here.

#### Spec

Every part is optional, so a spec can be a small incremental edit.

| Key | Shape | Notes |
|---|---|---|
| `action` | `{ name?, description?, access?: "public" \| "package_private" }` | `name` sets `name` + `displayName` |
| `inputs[]` | `{ name, label?, type?, mandatory?, choices?: [{value, label?}], default?, order?, maxLength?, remove? }` | Upsert by `name`. `type`: `string` (default) \| `choice` \| `boolean` \| `integer`. `choice` needs `choices`; `default` must be one of them. Changing an input's type makes ServiceNow mint a new variable record |
| `outputs[]` | `{ name, label?, type?, value?, remove? }` | Upsert by `name`. `value` is the pill the output is wired to. System outputs (`__action_status__`, `__dont_treat_as_error__`) cannot be named |
| `steps[]` | `{ ref, type: "script" \| "rest", label?, match?, remove?, errorHandling?, script?, inputs?, outputs?, values? }` | See below |

Steps:

- **Matching.** `match` (an existing step's cid or current label — use it to rename),
  else `label`, else position (the spec's Nth step against the action's Nth step, same
  type, flagged in the diff as `matched by order`). Unmatched steps are created and
  placed before the next existing step the spec lists after them (else appended).
  Existing steps are never reordered; `remove: true` deletes one.
- **`script`** (script steps) — the script body. On the CLI, `scriptFile` (relative
  to the spec file) is sugar for it.
- **`inputs`** (script steps) — the step's own input variables (`extended_inputs`):
  `{ "<name>": "<value or pill>" }` or `{ "<name>": { value?, type?, label?, mandatory?, remove? } }`.
- **`outputs`** (script steps) — the step's own output variables (`extended_outputs`):
  `[{ name, label?, type?, remove? }]`.
- **`values`** — the step type's own inputs by name (unknown names are an error that
  lists the valid ones). For a REST step: `connection` (`use_connection_alias`),
  `connection_alias` (a `sys_alias` sys_id — its display name is looked up — or
  `{ value, display }`), `override_base_url`, `base_url`, `resource_path`,
  `http_method` (`get` / `post` / `put` / `delete` …), `headers` and `query_params`
  (`[{ name, value }]` → the Designer's `ADV_NV` list), `body`, `request_type`,
  `connection_timeout`, `retry_policy`, … Booleans take `true` / `false`.
- **`errorHandling`** — `EVAL_ERRORS` (the default) or `NEXT_STEP` (continue on error).

Pills (in `values`, script `inputs` and `outputs[].value`):

| Pill | Means |
|---|---|
| `{{action.<input>}}` | an action input — must exist after the merge |
| `{{steps.<ref>.<output>}}` | another spec step's output — resolved to `{{step[<cid>].<output>}}`. Inside a step it must point at an **earlier** step |
| `{{step[<cid>].<output>}}` | the raw form — the cid must exist |

REST steps expose `status_code`, `response_body`, `response_headers`, `error_message`,
`error_code`, `response_stream`; a script step exposes its `outputs`. An **action
output is wired by putting the pill in the output's own `value`** (the Designer also
mirrors it into `display_value` and records the pill's label in `label_cache` — both
handled for you). Everything is checked before any write: unknown keys, names with `^`
or path characters (names must match `^[A-Za-z_][A-Za-z0-9_]*$`), an unknown step type,
an unknown step ref / action input / step output in a pill, and any pill the spec would
leave dangling (e.g. removing an input a step still reads).

Example — the complete body of *Email Service Request GET*:

```json
{
  "inputs": [
    { "name": "host", "type": "choice", "mandatory": true, "default": "api",
      "choices": [
        { "value": "api", "label": "API" },
        { "value": "storage_us_east4", "label": "US East 4" },
        { "value": "storage_us_west1", "label": "US West 1" },
        { "value": "storage_europe_west1", "label": "Europe West 1" }
      ] },
    { "name": "path", "type": "string", "mandatory": true },
    { "name": "content_type", "type": "string", "mandatory": false },
    { "name": "body", "type": "string", "mandatory": false }
  ],
  "steps": [
    { "ref": "guard", "type": "script", "label": "Guard", "match": "Gaurd",
      "scriptFile": "guard.js",
      "inputs": {
        "host_1": { "value": "{{action.host}}", "mandatory": true },
        "path_1": { "value": "{{action.path}}", "mandatory": true }
      },
      "outputs": [
        { "name": "base_url", "label": "Base URL", "type": "string" },
        { "name": "error", "label": "Error", "type": "string" }
      ] },
    { "ref": "call", "type": "rest", "label": "Call email service", "match": "REST step",
      "errorHandling": "NEXT_STEP",
      "values": {
        "connection": "use_connection_alias",
        "connection_alias": "956cc622c3ee4a1085b196c4e401317e",
        "override_base_url": true,
        "base_url": "{{steps.guard.base_url}}",
        "resource_path": "{{action.path}}",
        "http_method": "get",
        "headers": [{ "name": "Content-Type", "value": "{{action.content_type}}" }],
        "connection_timeout": "25000"
      } }
  ],
  "outputs": [
    { "name": "status_code", "label": "Status Code", "type": "string", "value": "{{steps.call.status_code}}" },
    { "name": "response_body", "label": "Response Body", "type": "string", "value": "{{steps.call.response_body}}" },
    { "name": "error", "label": "Error", "type": "string", "value": "{{steps.call.error_message}}" }
  ]
}
```

The MCP tool **`action_define`** takes `sysId`, `scope`, `spec` (inline — `script`, not
`scriptFile`), `updateSetSysId`, `publish`, `confirm`, `dryRun`, with the same
dry-run-unless-`confirm:true` gate.

Not yet covered (no Designer capture of the shape yet): step types other than script
and REST, reference / object / array variable types, and the action's error-status
conditions (`action_status_metadata`, which is carried through unchanged).

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
was sent: script **content** (hashed, so a same-length-but-different script can't pass) and each IO
entry's **name, type and value** — so an entry that landed with a mis-wired pill is caught, not just a
missing one. A mismatch prints the diff and exits **2**. When every op was a no-op, there is nothing to
read back and the round-trip is skipped.

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

### Add a unique index

Create a **single-column UNIQUE index** on an existing table, then read it back.

```bash
# Dry-run (the DEFAULT) - prints the plan, writes nothing and reads nothing
npx dove-sn add-index \
  --table x_cadso_journey_instance --columns occurrence_key --unique \
  --update-set <sys_id> --json

# Send it
npx dove-sn add-index \
  --table x_cadso_journey_instance --columns occurrence_key --unique \
  --update-set <sys_id> --confirm
```

The **only** headless lever for an index is `sys_dictionary.unique`. `sys_index` fails an
API-LEVEL ACL (HTTP 403) for every identity - and an ACL that refuses `GET` refuses `POST` -
while `sys_index_column` does not exist at all (HTTP 400 `Invalid table`). So `add-index`
patches the column's dictionary row through the update-set-aware write path and lets the
platform build the physical index off that flag.

Three consequences, each reported rather than hidden:

- **One column, unique only.** `unique` is a per-COLUMN flag, so a composite index has no
  dictionary lever. A multi-column request is **refused**, never narrowed to its first
  column - building a different index than the one asked for is the worst available
  outcome. `--unique` is required for the same reason. Composite and plain indexes stay
  platform-UI work.
- **Duplicates abort the run BEFORE it writes.** A unique index cannot build over repeated
  values, and ServiceNow fails that ALTER *silently* - leaving a dictionary row claiming
  `unique=true` with no index behind it (which is exactly what
  `x_cadso_core_metric_point.idempotency_key` looks like today). **EMPTY counts as a
  value**: a freshly added column that is empty on every existing row is one collision per
  row. Backfill first, index second. The scan is paged and capped, and a scan that hits
  that cap **aborts the same way** - an UNPROVEN scan is treated exactly like a proven
  collision, because writing on a column that was only read part-way is how this verb
  would manufacture that trap on a table too big for anyone to have checked.
- **Success is read back; uniqueness never is.** `status` is `created` only when a matching
  row was read back from the `v_db_index` view; a flag with no index is `failed`.
  `verified.indexPresent` is `null` - UNKNOWN, not `false` - when the view could not be
  read, because a blind instrument is not evidence of absence. And `v_db_index` carries no
  uniqueness field (every row reads `btree`, unique or not), so **`uniqueness-enforced` is
  listed in `unverified` on every status, success included**: only a duplicate-insert test
  proves enforcement.

`--update-set` is required on the live path and is checked before a client is built or a
single request goes out. Exit codes: `0` created / skipped / dry-run, `1` bad args, `2`
failed (the lying-row case included).

### List a table's indexes

```bash
npx dove-sn index-list --table x_cadso_automate_message_batch_recipient --json
```

Read-only: no form session, no writes. **`v_db_index` is the index read surface** - and
the only one. `sys_index` fails an API-LEVEL ACL (HTTP 403) for every identity including
admin, and `sys_index_column` does not exist at all (HTTP 400 `Invalid table`), so there
is no two-table index model to join and nothing to cross-check against.

Each row comes back as `{ name, columns, type, rawColumns }`. `columns` is the view's
bracketed `column_names` cell (`"[phone]"`, `"[a,b]"`) **parsed** into a list - never
substring-matched, because `"[owner_id]"` contains `"owner"`. `type` is `access_method`.

**Uniqueness is not readable.** `v_db_index` has no uniqueness field, so a unique index
and an ordinary one are indistinguishable in it: `unique` is left **absent** rather than
guessed, and `uniqueness-enforced` is reported in `unverified` on every result. Only a
duplicate-insert test proves enforcement. An empty result more likely means the table name
is wrong than that the table is unindexed - every physical table has a `PRIMARY`.

### Create an index (composite and non-unique included)

> **A DATABASE INDEX IS A PHYSICAL, PER-INSTANCE CHANGE. IT IS NOT CAPTURED IN AN UPDATE
> SET AND DOES NOT TRAVEL WITH A PROMOTION.** Re-run `index-create` against every
> environment that needs the index (dev, test, uat, staging, prod). There is deliberately
> no `--update-set` - passing one is an error, not a silent no-op.

```bash
# Dry-run (the DEFAULT) - sends nothing and reads nothing
npx dove-sn index-create --table x_cadso_journey_instance --columns state,created_on

# Send it
npx dove-sn index-create \
  --table x_cadso_journey_instance --columns state,created_on --confirm --json
```

This is what `add-index` cannot do. `sys_dictionary.unique` - the only record-shaped lever
- is **per-column and unique-only**, so composite and plain indexes have no record path at
all. `index-create` instead replays the platform's own index-creator form
(`sys_action=create_index`, `sysparm_index_table`, `sysparm_fields`,
`sysparm_unique_index_SKIP`) over a form-login session. That contract is lifted from the
instance's shipped `index_creator_information` UI macro, not from a guess, and the POST
target is taken from the rendered page's own `<form action>`.

- **Dry-run by default.** Without `--confirm` nothing is sent *and nothing is read*;
  `--dry-run` forces a plan even with `--confirm`.
- **Idempotent.** On the live path `v_db_index` is read first, and an index over *exactly*
  these columns short-circuits to `already-exists` with no form session and no write.
  Column **order** is part of an index's identity - `[a,b]` is not `[b,a]`.
- **`--name` is refused.** The platform's form has no name input; ServiceNow names the
  index itself. Reporting a name the instance does not carry would be a lie, so the
  created index's *real* name is returned in `name` instead.
- **The read-back is the proof.** After the POST the index is polled for in `v_db_index`
  (default 10 checks, 3 s apart - a build on a populated table is asynchronous). If it
  never appears the status is `failed`: a form processor returning a page is not evidence
  an ALTER ran, and a unique index cannot build over duplicate values (EMPTY counts).
- **Uniqueness is still never claimed.** `uniqueness-enforced` stays in `unverified` on
  every status.

**Requires a username+password identity that can form-log-in.** An instance on
API-key-only auth, SSO or MFA rejects the form login however valid the API key is; the
verb fails at the session with that diagnosis rather than a mystery 302, and no `.do`
replay (including `create-table`'s) can work in that state.

Exit codes: `0` created / already-exists / dry-run, `1` bad args, `2` failed.

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

### Delete a record

Delete **one** existing data record by table + sys_id, pinned to an update set,
with the record read back **before** (so the dry-run shows exactly what would go,
and a missing record is an error rather than a "successful" delete of nothing) and
**after** (success is never reported until the record is confirmed gone).

```bash
# Dry-run (the default) — prints the record snapshot, deletes nothing
npx dove-sn delete-record \
  --table x_cadso_core_metric_point_type --sys-id <32-hex sys_id> \
  --update-set <sys_id>

# Apply — deletes, then reads back and verifies the record is gone
npx dove-sn delete-record \
  --table x_cadso_core_metric_point_type --sys-id <32-hex sys_id> \
  --update-set <sys_id> --apply --json
```

`delete-record` wraps the core `deleteRecord` op. It is **dry-run by default** —
nothing is deleted without `--apply` (`--dry-run` wins if both are given). `--sys-id`
must be a 32-character lowercase hex id and `--table` a plain table name; both are
validated before any network call. `--update-set` is **required** so a delete is never
routed to the session's default update set silently
([#297](https://github.com/TenonHQ/Dovetail/issues/297)) — note that until #297 ships
server-side, the op ignores `update_set_sys_id` and captures into the session
current-app set; the client sends it regardless so callers are ready the moment the
server honours it. Like its siblings it **refuses** schema tables (`sys_db_object` /
`sys_dictionary`). Exit codes: `0` deleted / dry-run, `1` bad args or no such record,
`2` the delete returned but the record is **still present** on read-back.

All three verbs are exported for programmatic use:

```ts
import { createClient, setField, createRecord, deleteRecord } from "@tenonhq/dovetail-servicenow";

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

### Publish an app to the Store / application repository / an update set

Publish a scoped application to the **ServiceNow Store**, the **company
application repository**, and/or **into a new update set** — headlessly, with
each publish's progress tracker polled to completion.

```bash
# Dry-run — the DEFAULT: resolves the app, prints the plan, publishes NOTHING
npx dove-sn publish-app --app x_cadso_filter --version 6.0.20260716 --target both

# Publish for real (store, then repo, same version)
npx dove-sn publish-app --app x_cadso_filter --version 6.0.20260716 \
  --target both --dev-notes "July release" --confirm --json

# Release flow on an instance WITHOUT the sn_cicd plugin: publish to the company
# repository over the UI uploader, then capture the app into a dated update set.
npx dove-sn publish-app --app x_cadso_filter --version 6.0.20260729 \
  --target repo-ui,update-set --update-set-description 20260729 --confirm --json
```

**Store publish is EXTERNALLY VISIBLE on the ServiceNow Store — treat
`--target store --confirm` as a release.** `publish-app` is dry-run by default:
without `--confirm` it prints the resolved plan and exits `1` (a deliberate
refusal). `--target` takes one target, a comma-separated list, or `both` (an
alias for `store,repo`); targets run **in the order given** and short-circuit on
the first failure.

The targets ride different transports:

- **store** replays the `sys_app` form's upload flow (`xmlhttp.do` +
  `sn_appauthor.ScopedAppUploaderAJAX`) over a form-login session — basic auth
  alone no-ops there. It needs the Store account credentials in the loaded env
  file as `SN_STORE_USERNAME` / `SN_STORE_PASSWORD`. The password is **never
  accepted as a flag** and never appears in output, dry-run previews included.
- **repo** uses the supported CI/CD REST API (`POST /api/sn_cicd/app_repo/publish`
  + `GET /api/sn_cicd/progress/{id}`) over basic auth. The API user needs the
  `sn_cicd` role (or admin).
- **repo-ui** reaches the *same* company repository as `repo`, but over the UI
  uploader (`sysparm_publish_to_store=false`) instead of REST. Use it when the
  instance has no CI/CD plugin — `tenonworkshop`, for instance, has no `sn_cicd`
  scope and no `app_repo` service, so `repo` 404s there while `repo-ui` works.
  It needs no Store credentials.
- **update-set** publishes the app *into a newly created update set* via the
  two-call `com.snc.apps.AppsAjaxProcessor` flow (`createUpdateSet` →
  `publishToUpdateSet`). There is no REST equivalent. `--update-set-name`
  defaults to the app's name (the dialog's field is readonly, so that is what
  the UI submits); `--update-set-description` is conventionally the release date
  stamp `YYYYMMDD`, which makes a whole release one query
  (`sys_update_set` where `description=20260729`). `--include-data` maps to the
  dialog's "Include demo data" box and defaults **off**, matching the value the
  UI actually puts on the wire.

Ordering matters when you combine them: the repo publish is what bumps
`sys_app.version`, so put it **before** `update-set` if you want the set
captured at the new version.

`--app` accepts a scope name, `sys_app` sys_id, or app name; `--version` must be
above the currently published version. The result carries the progress-tracker
id, per-step states ("Packaging application", "Uploading application"), the
Store `appLink`, and the update-set sys_id — for the `update-set` target that is
recorded as soon as the set is created, so it survives a later failure and you
can always find (or delete) the set. Exit codes: `0` published or dry-run, `1`
bad args/unconfirmed, `2` failed/timeout. Programmatic:
`publishApp({ app, version, target, confirm })`.

### Export an update set (or a whole app) to importable XML

Produce the `<unload>` document the implementation team imports on a customer
instance — with every secret value replaced by `__SET_DURING_INSTALL__`.

```bash
# An update set. assemble mode is READ-ONLY: nothing on the instance changes.
npx dove-sn export-update-set --update-set 0123456789abcdef0123456789abcdef \
  --out ./tenon-core.xml

# A whole app: publish into a new set, then export it. Dry-run first (default).
npx dove-sn export-app --app x_cadso_automate --out ./automate.xml
npx dove-sn export-app --app x_cadso_automate --out ./automate.xml --confirm

# A document exported some other way
npx dove-sn strip-secrets --in ./exported.xml --out ./safe.xml
npx dove-sn strip-secrets --in ./exported.xml --report      # what would be stripped
```

**Secret stripping is not optional.** There is no `--no-strip` flag on any of
these verbs, and no field in the MCP schemas that disables it. This matters
because an unload carries field *values*: on tenonworkstudio, completed update
sets hold filled-in values for `password2` system properties and
`oauth_entity.client_secret`, several of them in sets that shipped to a
customer. A field is exempted only by a reviewed entry in the rules file.

The rule is enumerable, in four layers:

| Layer | Covers |
|---|---|
| L1 type | `password` / `password2` fields, restricted to tables an update set can capture (`update_synch=true`), resolved through `super_class`. Refreshed from the live dictionary per run, with a committed baseline as the fallback. |
| L2 conditional / explicit | `sys_properties.value` when the property's `type` is a password type; named exceptions such as `x_cadso_core.google_translate_api_key`, which holds an API key in a *string* column. |
| L3 JSON | secrets nested inside a JSON blob field, stripped in place. |
| L4 heuristic | a field that merely *looks* secret. **Never stripped silently and never assumed safe** — the run fails and names it, until a human records it in the rules file as a strip rule or as `notSecret` with a reason. |

Override the rules with `--rules <file>`; the JSON is merged over the built-ins,
and the only subtractive key is `notSecret`, which requires a reason:

```json
{
  "notSecret": [
    { "table": "x_cadso_core_thing", "field": "webhook_token", "reason": "public identifier, not a credential" }
  ],
  "fieldRules": [
    { "id": "thing-signing-key", "table": "x_cadso_core_thing", "field": "signing_key", "reason": "inbound webhook HMAC key" }
  ]
}
```

Two more things refuse to produce a file rather than produce a wrong one: a
record count that does not match the set, and the documented **in-progress
empty 200** from `export_update_set.do` (the servlet streams a document only for
a *complete* set, and app-publish leaves the set in progress). After stripping,
the output is re-read and verified; a secret that somehow survived fails the run.

`export-update-set --mode complete` marks the set complete on the instance
first — a real write, so it needs `--confirm`. `export-app` publishes ~1000+
records into a new update set and is dry-run by default. Neither is the Store
publish; that is `publish-app`, which is externally visible.

Exit codes: `0` exported or dry-run, `1` bad args/unconfirmed, `2`
failed/timeout. Programmatic: `exportUpdateSet({ updateSet, mode })`,
`exportApp({ app, confirm })`, `stripSecrets(xml, rules)`. MCP:
`update_set_export` (read-only in assemble mode) and `app_export`.

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
`add_column` / `add_index` (a single-column unique index via `sys_dictionary.unique`,
read back from the `v_db_index` view - uniqueness enforcement is always reported
unverified) / `index_list` (read-only: a table's database indexes from `v_db_index`,
the only index read surface - `sys_index` is API-level-ACL 403 and `sys_index_column`
does not exist) / `index_create` (create an index, composite and non-unique included, by
replaying the platform index-creator form; dry-run by default, idempotent, read back from
`v_db_index` - and **not** captured in an update set, because a database index is a
physical per-instance change), the record-write verbs `set_field` (update scalar fields on an
existing record), `create_record` (insert one record) and `delete_record` (delete one
record — dry-run by default, `confirm:true` to apply, `updateSetSysId` required, the
record read back before AND after so success is only reported once it is confirmed
gone) — all update-set-captured and read-back-verified — `host_assets` (deploy a built
dist/), plus the Flow Designer
tools `flow_view` (read a flow/subflow's step graph), `action_view` (read an action
type's model), `action_edit` (structurally edit a published action type — per-step
scripts, step-level inputs/outputs, data-pill wiring — dry-run by default, and the
publish is read back and verified), `action_clone` (clone an action type — every step
and its step IO — into a scope and publish + verify it; dry-run by default),
`action_define` (define an existing action type's inputs, outputs and script/REST
steps with data-pill wiring, the way the Designer's Save does; dry-run by default,
idempotent, read back and verified, optional publish),
`flow_publish` (compile a flow/subflow snapshot), `flow_copy`
(copy a flow as an inactive draft), `flow_create` (create a NEW flow from scratch +
publish, grafting a template), `flow_test` (validate or run a flow), and
`flow_edit` (patch a flow), plus `invoke_rest` (invoke an arbitrary authenticated
REST operation — Scripted REST included — with GET/POST/PUT/DELETE; dry-run by
default, response passed through verbatim, bodies never logged) and `app_publish`
(publish a scoped app to the ServiceNow Store and/or the application repository;
dry-run by default, Store credentials env-only — they never transit tool
arguments). It reads ServiceNow credentials from the same env vars as the CLI.

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
`dovetail-mcp` intentionally does **not** get `delete_record` (or any other ServiceNow
write): record writes — create, set, delete — live on `dove-sn mcp` only, where every
one is update-set-pinned, dry-run-gated and read-back-verified.

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
