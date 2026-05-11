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
npx sinc-sn add-choices \
  --table x_cadso_core_event \
  --column state \
  --update-set 0083c3bb33d003507b18bc534d5c7b6d \
  --choices "delivered=Delivered,failed=Failed,expired=Expired"

# JSON payload form (recommended for >5 choices)
npx sinc-sn add-choices --from-json ./choices.json
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

## Roadmap

Same package will grow to cover the rest of the `sinch-dlr-manual-steps`
patterns: indexes (`sys_db_object_ix`), table properties (`accessible_from`),
`sys_trigger` creation, `sys_property` creation. Pattern stays identical —
query to diff, write through the Dovetail REST API, report per-row actions.
