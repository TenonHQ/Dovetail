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
```

Requires `SN_INSTANCE`, `SN_USER`, and `SN_PASSWORD` in your `.env` file.

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
└── sinc/                   # Tables from x_nuvo_dove scope
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
