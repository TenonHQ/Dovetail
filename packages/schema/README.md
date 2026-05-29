# @tenonhq/dovetail-schema

ServiceNow table schema fetcher and organizer for Dovetail. Reads scopes from your `dove.config.js` and fetches all custom table definitions for those scopes from your ServiceNow instance.

## Usage via Dovetail CLI

```bash
# Fetch schemas for all scopes defined in dove.config.js
dove schema pull

# Fetch schema for a single scope
dove schema pull --scope x_cadso_work

# Custom output directory
dove schema pull --output ./tables

# Also save an immutable, timestamped snapshot (labelled)
dove schema pull --scope x_cadso_journey --snapshot pre-release

# List stored snapshots for the current instance
dove schema snapshots

# Compare two schema versions and report severity-ranked drift
dove schema diff --from pre-release --to live --scope x_cadso_journey
dove schema diff --from ./Tables --to live --scope x_cadso_journey --format json
```

Requires `SN_INSTANCE`, `SN_USER`, and `SN_PASSWORD` in your `.env` file.

## Snapshots & drift diff

`dove schema diff` compares two versions of a schema and classifies every
difference by severity, exiting non-zero when anything **BREAKING** is found —
so it can gate CI.

A `--from`/`--to` **ref** is any of:

- `live` — a fresh pull from the current instance (into a temp dir)
- a snapshot **label** or directory name (resolved under `.snapshots/<instance>/`)
- a **directory path** — e.g. a committed baseline tree (`--from ./Tables`)

Defaults: `--from` = newest snapshot for the current instance, `--to` = `live`.

### Breakage taxonomy

| Change | Severity |
|---|---|
| Table removed · field removed · field retyped · `max_length` shrunk · field newly mandatory · reference retargeted | **BREAKING** (exit 1) |
| `default_value` changed | **WARN** |
| Table/field added · `max_length` grew · field now optional · label changed | **INFO** |

The diff is **structured** (not textual) and immune to format noise: `type` and
`reference` are coerced from either a string or a legacy `{link,value}` object,
and `inherited_from` / `created_at` / `generated_at` are ignored. This lets an
older object-shaped baseline diff cleanly against a current string-shaped pull.

```
$ dove schema diff --from ./Tables --to live --scope x_cadso_journey
Schema drift: tenonworkstudio.service-now.com
  from  ./Tables              (2025-08-10T04:28:39.062Z)
  to    live                  (2026-05-29T16:56:28.255Z)
  scope x_cadso_journey

BREAKING (6)
  ✖ field retyped       x_cadso_journey_action.table        "string" → "table_name"
  ✖ field removed       x_cadso_journey_flow.description
  ...
WARN (1)
  ⚠ default changed     x_cadso_journey_version.enrollment_frequency   "once" → "every"
INFO (14)
  + table added         x_cadso_journey_blueprint
  ...

6 breaking, 1 warning, 14 info  →  exit 1
```

### Snapshot storage

Snapshots are immutable copies of a pull, written under the output dir:

```
schema/.snapshots/<instance>/<ISO-timestamp>[__label]/
  <app>/<table>.json   # frozen copy of the pulled tree
  index.json
  snapshot.json        # manifest: instance, label, created_at, scopes, total_tables
```

**Recommended:** gitignore `schema/.snapshots/` (ephemeral local/CI artifacts)
and keep **one** committed baseline tree (e.g. `schema/baseline/` or `Tables/`)
as the stable `--from` target. Refreshing the baseline then becomes an
intentional, reviewable PR. Add to the consuming repo's `.gitignore`:

```
schema/.snapshots/
```

### CI drift gate (example)

```yaml
# Fail the build if live schema has drifted from the committed baseline.
- run: npx dove schema diff --from ./schema/baseline --to live --scope x_cadso_journey
  # exit 1 on any BREAKING change
```

Scopes are read from the `scopes` object in your `dove.config.js`:

```javascript
module.exports = {
  // ...
  scopes: {
    x_cadso_work: { sourceDirectory: "src/x_cadso_work" },
    x_cadso_core: { sourceDirectory: "src/x_cadso_core" },
    // Add more scopes here — they will be picked up automatically
  },
};
```

## Usage as Library

```typescript
import { pullSchema, fetchSchema, organizeSchema } from "@tenonhq/dovetail-schema";

// Full pipeline: fetch + organize
const index = await pullSchema({
  instance: "your-instance.service-now.com",
  username: "admin",
  password: "password",
  outputDir: "./schema",
  scopes: ["x_cadso_work", "x_cadso_core"],
});

// Or step-by-step
const schema = await fetchSchema({
  instance: "your-instance.service-now.com",
  username: "admin",
  password: "password",
  outputDir: "./schema",
  scopes: ["x_cadso_work"],
});

const index = await organizeSchema({
  schema,
  outputDir: "./schema",
  instance: "your-instance.service-now.com",
  scopes: ["x_cadso_work"],
});
```

### Snapshot + diff API

```typescript
import {
  writeSnapshot,
  listSnapshots,
  resolveSnapshotDir,
  readSchemaTree,
  diffSchemas,
  formatDiff,
} from "@tenonhq/dovetail-schema";

// Persist an immutable snapshot of a freshly-pulled tree
await writeSnapshot({ outputDir: "./schema", index, label: "pre-release", now: new Date().toISOString() });

// Diff two trees (snapshot, baseline, or live pull)
const from = await readSchemaTree({ dir: "./Tables", scope: "x_cadso_journey" });
const to = await readSchemaTree({ dir: "./schema", scope: "x_cadso_journey" });
const diff = diffSchemas({ from, to, fromRef: "baseline", toRef: "live", scope: "x_cadso_journey" });
console.log(formatDiff(diff, { format: "text" }));
process.exitCode = diff.exit_code; // non-zero on BREAKING
```

## Output Structure

```
schema/
├── index.json              # Master index of all tables and scopes
├── work/                   # Tables from x_cadso_work scope
│   ├── _summary.json
│   ├── x_cadso_work_project.json
│   └── ...
├── core/                   # Tables from x_cadso_core scope
│   ├── _summary.json
│   └── ...
└── dove/                   # Tables from x_nuvo_dove scope
    └── ...
```

Application directory names are derived from scope names by stripping the vendor prefix (`x_{vendor}_`).

## Table Schema Format

Each table JSON file contains:

```json
{
  "table_name": "x_cadso_work_project",
  "label": "Project",
  "scope": "x_cadso_work",
  "parent": "task",
  "hierarchy": ["x_cadso_work_project", "task"],
  "created_at": "2025-08-10T04:28:39.043Z",
  "field_count": 113,
  "fields": [
    {
      "name": "short_description",
      "label": "Short description",
      "type": "string",
      "max_length": "160",
      "mandatory": false,
      "reference": "",
      "default_value": "",
      "inherited_from": "task"
    }
  ]
}
```

## Index Format

The `index.json` master index includes the scopes that were fetched:

```json
{
  "instance": "your-instance.service-now.com",
  "generated_at": "2025-08-10T04:28:39.043Z",
  "total_tables": 131,
  "scopes": ["x_cadso_work", "x_cadso_core", "x_nuvo_sinc"],
  "applications": [
    {
      "name": "work",
      "table_count": 38,
      "tables": ["x_cadso_work_project", "x_cadso_work_task"]
    }
  ]
}
```
