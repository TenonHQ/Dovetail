# Configure Dovetail Build Pipeline

## Task

$ARGUMENTS

## Instructions for Claude

### Directory Context

Dovetail commands can be run from two locations:

- **From `ServiceNow/` directory:** `npx sinc <command>`
- **From Craftsman root:** `npm run sinc:<command>` (proxy scripts)

Available root scripts: `sinc:init`, `sinc:start`, `sinc:dev`, `sinc:build`, `sinc:deploy`, `sinc:push`, `sinc:refresh`, `sinc:status`

When running from Craftsman root, `dove.config.js` is at `ServiceNow/dove.config.js`. When running from `ServiceNow/`, it is at `./dove.config.js`. Use the path appropriate to the current working directory.

---

The user wants to configure or modify their `dove.config.js` plugin pipeline. Help them set up the `rules` array with the correct plugins, ordering, and options.

### Key Principles

1. **Rule matching is first-match-wins.** Place the most specific regex patterns first. If `.secret.ts` should have no plugins, that rule MUST come before the generic `.ts` rule.
2. **Plugin chain is sequential.** The output of one plugin feeds into the next. Order matters.
3. **Babel preset execution is REVERSED** (last preset runs first), but **Babel plugin execution is FORWARD** (first plugin runs first). This is standard Babel behavior but confusing in config.

### Step 1: Identify the user's file types and needs

Ask what file types they have if not specified:

- `.ts` files (server-side TypeScript)
- `.js` files (server-side JavaScript)
- `.client.js` or `.wp.js` files (client-side, need Webpack bundling)
- `.scss` files (SCSS stylesheets)
- Any files that should be excluded from processing

### Step 2: Build the rules array

For each file type, construct a rule using these templates:

**Server-side TypeScript (most common):**

```javascript
{
  match: /\.ts$/,
  plugins: [
    {
      name: "@tenonhq/dovetail-typescript-plugin",
      options: { transpile: false }
    },
    {
      name: "@tenonhq/dovetail-babel-plugin",
      options: {
        presets: [
          "@tenonhq/dovetail-servicenow",
          "@babel/env",
          "@babel/typescript"
        ],
        plugins: [
          "@tenonhq/dovetail-remove-modules",
          "@babel/proposal-class-properties",
          "@babel/proposal-object-rest-spread"
        ]
      }
    }
  ]
}
```

**Server-side JavaScript:**

```javascript
{
  match: /\.js$/,
  plugins: [
    {
      name: "@tenonhq/dovetail-babel-plugin",
      options: {
        presets: [
          "@tenonhq/dovetail-servicenow",
          "@babel/env"
        ],
        plugins: [
          "@tenonhq/dovetail-remove-modules"
        ]
      }
    }
  ]
}
```

**Client-side Webpack bundle:**

```javascript
{
  match: /\.wp\.js$/,
  plugins: [
    {
      name: "@tenonhq/dovetail-webpack-plugin",
      options: {
        configGenerator: (context) => ({
          mode: "production",
          output: { library: context.name }
        })
      }
    }
  ]
}
```

**SCSS:**

```javascript
{
  match: /\.scss$/,
  plugins: [
    { name: "@tenonhq/dovetail-sass-plugin", options: {} }
  ]
}
```

**Skip processing:**

```javascript
{
  match: /\.secret\.ts$/,
  plugins: []
}
```

### Step 3: Assemble the complete config

Write the full `dove.config.js` with rules ordered most-specific to least-specific. Include other fields: `sourceDirectory`, `buildDirectory`, `excludes`, `includes`, `tableOptions`, `refreshInterval`, `scopes`.

### Step 4: List npm install commands

Provide a single `npm i -D` command with all required packages.

### Available Plugins Reference

| Plugin     | Purpose                             | npm Package                           |
| ---------- | ----------------------------------- | ------------------------------------- |
| TypeScript | Type-check and/or transpile `.ts`   | `@tenonhq/dovetail-typescript-plugin` |
| Babel      | Run Babel transforms                | `@tenonhq/dovetail-babel-plugin`      |
| ESLint     | Lint before sync (blocks on errors) | `@tenonhq/dovetail-eslint-plugin`     |
| Prettier   | Format output code                  | `@tenonhq/dovetail-prettier-plugin`   |
| SASS       | Compile SCSS to CSS                 | `@tenonhq/dovetail-sass-plugin`       |
| Webpack    | Bundle frontend JS                  | `@tenonhq/dovetail-webpack-plugin`    |

### Babel Sub-Packages (used inside babel-plugin options)

| Package                                         | Purpose                            | Config Key                                      |
| ----------------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| `@tenonhq/dovetail-babel-plugin-remove-modules` | Strip import/export for ServiceNow | `plugins: ["@tenonhq/dovetail-remove-modules"]` |
| `@tenonhq/dovetail-babel-preset-servicenow`     | Sanitize for Rhino engine          | `presets: ["@tenonhq/dovetail-servicenow"]`     |

### Critical Warnings

- **Never use `useBuiltIns`** with `@babel/env` -- ServiceNow's Rhino engine locks base class prototypes, so polyfills will fail.
- **Always include `@tenonhq/dovetail-servicenow`** as the FIRST Babel preset listed (runs last) for server-side code -- it handles `__proto__` and reserved word issues.
- **Always include `@tenonhq/dovetail-remove-modules`** as a Babel plugin for server-side code -- ServiceNow does not support ES modules.
- If using TypeScript plugin for type-checking only (`transpile: false`), Babel must handle the actual transpilation.
- Webpack rules MUST come before generic `.js` rules in the rules array.
