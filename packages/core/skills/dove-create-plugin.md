# Create a Custom Dovetail Plugin

## Task
$ARGUMENTS

## Instructions for Claude

### Directory Context

Dovetail commands can be run from two locations:
- **From `ServiceNow/` directory:** `npx sinc <command>`
- **From Craftsman root:** `npm run sinc:<command>` (proxy scripts)

Available root scripts: `sinc:init`, `sinc:start`, `sinc:dev`, `sinc:build`, `sinc:deploy`, `sinc:push`, `sinc:refresh`, `sinc:status`

Plugin files and `dove.config.js` live in the `ServiceNow/` directory. When referencing paths from the Craftsman root, prefix with `ServiceNow/`.

---

Help the user create a custom Dovetail build plugin. A plugin is a Node.js module that transforms file content during the build pipeline.

### Plugin Interface

A Dovetail plugin must export an object with a `run` function:

```typescript
interface Plugin {
  run: (
    context: FileContext,
    content: string,
    options: any
  ) => Promise<PluginResults>;
}

interface FileContext {
  filePath: string;     // Absolute path to the source file
  name: string;         // Record display name
  tableName: string;    // ServiceNow table name
  targetField: string;  // Field name in ServiceNow
  ext: string;          // File extension
  sys_id: string;       // ServiceNow record sys_id
  scope: string;        // Application scope
}

interface PluginResults {
  success: boolean;     // If false, build is halted
  output: string;       // Transformed content (passed to next plugin)
}
```

### Minimal Plugin Template

```javascript
// my-dovetail-plugin/index.js
module.exports = {
  run: async function(context, content, options) {
    try {
      let output = content;

      // Example: Add a header comment
      if (options.addHeader) {
        output = "// Generated from " + context.name + "\n" + output;
      }

      return { success: true, output: output };
    } catch (e) {
      console.error("Plugin error: " + e.message);
      return { success: false, output: "" };
    }
  }
};
```

### Plugin Registration in dove.config.js

```javascript
rules: [
  {
    match: /\.ts$/,
    plugins: [
      {
        name: "my-dovetail-plugin",
        options: { addHeader: true }
      }
    ]
  }
]
```

**Important:** Dovetail resolves plugins from `node_modules/` using the plugin name as a path segment. For local plugins, you have three options:

1. **Use npm link:**
   ```bash
   cd plugins/my-plugin && npm link
   npm link my-dovetail-plugin
   ```
2. **Use npm workspaces** (recommended for monorepos)
3. **Publish to npm** as a scoped package (recommended for shared plugins)

### Using the FileContext

```javascript
run: async function(context, content, options) {
  // Different behavior per table
  if (context.tableName === "sys_script_include") {
    // Server-side script include
  } else if (context.tableName === "sp_widget") {
    // Service Portal widget
  }

  // Different behavior per file extension
  if (context.ext === ".ts") {
    // TypeScript file
  }

  console.log("Processing: " + context.name + " (" + context.sys_id + ")");

  return { success: true, output: content };
}
```

### Plugin Chain Behavior

Plugins run sequentially. Each plugin receives the OUTPUT of the previous plugin as its `content` parameter. If any plugin returns `{ success: false }`, the entire build for that file is halted.

```
Source File Content
    |
    v
Plugin 1 (e.g., TypeScript type-check) --> output
    |
    v
Plugin 2 (e.g., Babel transpile) --> output
    |
    v
Plugin 3 (e.g., Prettier format) --> output
    |
    v
Final content pushed to ServiceNow
```

### Example: Minification Plugin

```javascript
// my-minify-plugin/index.js
var terser = require("terser");

module.exports = {
  run: async function(context, content, options) {
    try {
      if (context.ext === ".css" || context.ext === ".scss") {
        return { success: true, output: content };
      }

      var result = await terser.minify(content, {
        compress: options.compress !== false,
        mangle: options.mangle !== false
      });

      return { success: true, output: result.code };
    } catch (e) {
      console.error("Minification failed for " + context.name + ": " + e.message);
      return { success: false, output: "" };
    }
  }
};
```

### Error Handling

- Return `{ success: false, output: "" }` to stop the build for that file
- Throw an exception for unexpected errors (caught by PluginManager)
- Log useful error messages -- they appear in the Dovetail console output
- Check `dovetail-debug-*.log` for detailed error traces
