# Manage Dovetail Table Includes, Excludes, and Options

## Task

$ARGUMENTS

## Instructions for Claude

### Directory Context

Dovetail commands can be run from two locations:

- **From `ServiceNow/` directory:** `npx sinc <command>`
- **From Craftsman root:** `npm run sinc:<command>` (proxy scripts)

Available root scripts: `sinc:init`, `sinc:start`, `sinc:dev`, `sinc:build`, `sinc:deploy`, `sinc:push`, `sinc:refresh`, `sinc:status`

When this skill references `npx sinc <command>`, use `npm run sinc:<command>` if working from the Craftsman root. Configuration files (`dove.config.js`) live in the `ServiceNow/` directory.

---

Help the user configure which ServiceNow tables and fields Dovetail tracks, and how records are organized locally.

### How Table Filtering Works

Dovetail has a three-layer system:

1. **Default excludes** (built into core) -- Tables excluded by default because they contain non-code metadata
2. **User `excludes`** in `dove.config.js` -- Additional exclusions or overrides of defaults
3. **User `includes`** in `dove.config.js` -- Explicit inclusions that override excludes

User config is ADDITIVE to defaults (merged with `Object.assign`).

### Default Excluded Tables

These tables are excluded by default:

```
sys_scope_privilege, sys_dictionary, sys_impex_entry, sys_security_acl,
sys_transform_map, sys_ui_policy, sys_ui_list_control, sys_relationship,
sys_report, item_option_new, sys_process_flow, content_block_programmatic,
sp_instance, sys_transform_script, sc_category, sysrule_view, sc_cat_item,
sysevent_in_email_action, sys_navigator, sys_transform_entry,
metric_definition, content_block_lists, content_block_detail, sp_portal,
sc_cat_item_producer, sys_impex_map
```

### Excludes Configuration

```javascript
// dove.config.js
module.exports = {
  excludes: {
    // Override a default exclusion (RE-INCLUDE the table)
    sys_scope_privilege: false,

    // Exclude an entire table
    my_cool_table: true,

    // Exclude specific fields from a table (other fields still included)
    new_cool_table: {
      cool_script: true,
    },
  },
};
```

### Includes Configuration

Includes override excludes when there is a conflict on the same table.

```javascript
// dove.config.js
module.exports = {
  includes: {
    // Override a default inclusion (REMOVE the table)
    content_css: false,

    // Explicitly include a table (overrides any exclude on same table)
    sys_report: true,

    // Include a specific field with a custom file type
    special_code_table: {
      neat_script_field: {
        type: "js",
      },
    },
  },
};
```

Valid file types: `"js"`, `"css"`, `"xml"`, `"html"`, `"scss"`, `"txt"`, `"json"`

### Table Options

The `tableOptions` section controls how records are organized on disk:

```javascript
// dove.config.js
module.exports = {
  tableOptions: {
    some_table: {
      // Use a different field for the record folder name
      displayField: "some_field",

      // De-duplicate records with the same display value
      differentiatorField: "sys_id",

      // Can be an array -- falls back to next field if first is empty
      differentiatorField: ["some_field", "sys_id"],

      // Filter records with an encoded query
      query: "active=true^category=scripts",
    },
  },
};
```

### After Changing Configuration

1. Run `npx dove refresh` to update the manifest with new tables/fields
2. Manually delete any folders for tables you just excluded (Dovetail does not auto-delete)
3. New tables/fields will be downloaded automatically by refresh

### Common Recipes

**Track only script-related tables:**

```javascript
includes: {
  sys_script_include: true,
  sys_script: true,
  sys_ui_script: true,
  sys_ui_page: true,
  sp_widget: true
}
```

**Include a non-code field as code:**

```javascript
includes: {
  sys_ui_page: {
    html: { type: "html" },
    client_script: { type: "js" },
    processing_script: { type: "js" }
  }
}
```

**Filter records by query:**

```javascript
tableOptions: {
  sys_script_include: {
    query: "active=true";
  }
}
```

### Scope-Specific Configuration

When using multi-scope mode, each scope can have its own `tableOptions`:

```javascript
module.exports = {
  tableOptions: {
    /* default table options */
  },
  scopes: {
    x_cadso_core: {
      sourceDirectory: "src/x_cadso_core",
      tableOptions: {
        sys_script_include: {
          query: "active=true",
        },
      },
    },
  },
};
```
