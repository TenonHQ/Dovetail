# Debug Dovetail Build Transformations

## Task
$ARGUMENTS

## Instructions for Claude

### Directory Context

Dovetail commands can be run from two locations:
- **From `ServiceNow/` directory:** `npx sinc <command>`
- **From Craftsman root:** `npm run sinc:<command>` (proxy scripts)

Available root scripts: `sinc:init`, `sinc:start`, `sinc:dev`, `sinc:build`, `sinc:deploy`, `sinc:push`, `sinc:refresh`, `sinc:status`

When this skill references `npx sinc <command>`, use `npm run sinc:<command>` if working from the Craftsman root. The `build/` and `src/` directories referenced below are at `ServiceNow/build/` and `ServiceNow/src/` relative to the Craftsman root.

---

Help the user understand, inspect, or debug the Dovetail build transformation pipeline -- what happens between source code and what reaches ServiceNow.

### Step 1: Run a Local Build

To see build output without pushing to ServiceNow:

```bash
npx dove build
```

Output files appear in the `build/` directory (configured via `buildDirectory` in `dove.config.js`), mirroring the source directory structure.

To build only changed files (compared to a git branch):

```bash
npx dove build --diff main
```

### Step 2: Compare Source vs Output

```
src/sys_script_include/MyScript/script.ts       <-- Source (TypeScript)
build/sys_script_include/MyScript/script.ts      <-- Output (transpiled JS)
```

### Step 3: Understand Transformation Stages

For a typical TypeScript server-side pipeline (`typescript-plugin` + `babel-plugin`):

**Stage 1: TypeScript Plugin** (`transpile: false`)
- Runs the TypeScript compiler for type checking only
- Does NOT modify the code
- Errors here = TypeScript type errors

**Stage 2: Babel Plugin** (with presets and plugins)

Babel plugins run first (in order):
1. `@tenonhq/dovetail-remove-modules` -- Strips `import`/`export` statements
2. `@babel/proposal-class-properties` -- Transforms class property syntax
3. `@babel/proposal-object-rest-spread` -- Transforms `...spread` syntax

Babel presets run in reverse order:
1. `@babel/typescript` (listed last, runs first) -- Strips type annotations
2. `@babel/env` -- Transpiles ES6+ to ES5
3. `@tenonhq/dovetail-servicenow` (listed first, runs last) -- Sanitizes for Rhino: replaces `__proto__` with `__proto_sn__`, converts `obj.default` to `obj["default"]`

### Step 4: Diagnose Common Issues

**"Cannot read property 'X' of undefined" in ServiceNow**
- Likely: `import` statements were not removed. Check that `@tenonhq/dovetail-remove-modules` is in Babel plugins.
- The import variable becomes `undefined` because ServiceNow has no module system.

**"Illegal access to reserved word" in ServiceNow**
- Likely: Missing `@tenonhq/dovetail-servicenow` preset. Code like `obj.default` or `obj.class` crashes Rhino.
- Fix: Ensure `@tenonhq/dovetail-servicenow` is the FIRST preset listed (= runs LAST).

**"__proto__" security error in ServiceNow**
- Likely: Missing `@tenonhq/dovetail-servicenow` preset. Babel's class transpilation generates `__proto__` references.

**"TypeError: Cannot extend a non-class" or prototype errors**
- Likely: Using `useBuiltIns` with `@babel/env`. Rhino locks base class prototypes.
- Fix: Remove `useBuiltIns` from `@babel/env` config.

**Build succeeds but code does nothing in ServiceNow**
- Check if `export default` was on the main class/function. The `remove-modules` plugin strips exports. In ServiceNow script includes, the class/function name must match the script include name.

### Special Comment Tags

The `@tenonhq/dovetail-remove-modules` Babel plugin supports these comment tags:

**`@keepModule`** -- Preserve an import (for actual ServiceNow modules):
```javascript
//@keepModule
import moduleDos from "myModuleDos";
```

**`@expandModule`** -- Expand imports to dot notation:
```javascript
//@expandModule
import { helper } from "x_cadso_core";
// becomes: x_cadso_core.helper
```

**`@moduleAlias=newName`** -- Rename the module reference with `@expandModule`:
```javascript
//@expandModule
//@moduleAlias=MyApp
import { helper } from "x_cadso_core";
// becomes: MyApp.helper
```

### Step 5: Test Incrementally

If you cannot determine which stage causes an issue:

1. **Remove all plugins** from the rule and push raw source -- does it work?
2. **Add plugins back one at a time** and rebuild after each addition.
3. **Check the `build/` directory** after each rebuild to see intermediate output.
