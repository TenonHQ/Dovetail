# SINCRONIA QA SCORECARD — 2026-03-31

**Branch:** `dev` | **Version:** `0.4.2-alpha.6` | **Node:** v24.5.0 (project requires >=16)

---

## Category 1: TypeScript Compilation & Type Safety (3/7)

| #   | Question                                  | Result   | Evidence                                                                                                                                                            |
| --- | ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Compiles without errors (`tsc --noEmit`)? | **FAIL** | 28 errors — mostly missing module declarations (`@babel/core`, `@sincronia/types`, `memory-fs`, `webpack`, `node-sass`). Packages lack local `node_modules`.        |
| 1.2 | `strict: true` in root `tsconfig.json`?   | **PASS** | `tsconfig.json:30` — `"strict": true`                                                                                                                               |
| 1.3 | Zero `@ts-ignore` or `@ts-nocheck`?       | **PASS** | 0 matches across all source files                                                                                                                                   |
| 1.4 | Explicit `any` below 30 occurrences?      | **FAIL** | **~55 occurrences** across core (43), plugins (5), schema (5), FileLogger (6). Heaviest: `updateSetCommands.ts` (33), `snClient.ts` (7), `allScopesCommands.ts` (6) |
| 1.5 | Zero `TSFIXME` outside type defs?         | **FAIL** | 5 in `commander.ts:1,73,81,126,267` — imported from types and used as param type                                                                                    |
| 1.6 | Core `tsconfig.json` extends root?        | **PASS** | `packages/core/tsconfig.json:11` — `"extends": "../../tsconfig.json"`                                                                                               |
| 1.7 | ES target set to ES2019?                  | **PASS** | `tsconfig.json:5` — `"target": "ES2019"`                                                                                                                            |

---

## Category 2: Code Standards Compliance (3/8)

| #   | Question                                                 | Result   | Evidence                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 | `prettier --check` passes?                               | **SKIP** | Prettier binary broken — `MODULE_NOT_FOUND` (missing `../package.json`). Needs `npm install`.                                                                                                                                                    |
| 2.2 | ESLint passes with zero errors?                          | **SKIP** | ESLint not installed in `node_modules/.bin/`                                                                                                                                                                                                     |
| 2.3 | Zero optional chaining (`?.`)?                           | **FAIL** | **9 violations**: `updateSetCommands.ts:255,317,594` (3), `allScopesCommands.ts:74,79,202,256,366,369` (6)                                                                                                                                       |
| 2.4 | `.prettierrc` has `semi: true`, `tabWidth: 2`?           | **PASS** | `.prettierrc` — `{"semi": true, "tabWidth": 2}`                                                                                                                                                                                                  |
| 2.5 | ESLint configured with `@typescript-eslint/recommended`? | **PASS** | `.eslintrc` — `"extends": ["plugin:@typescript-eslint/recommended"]`                                                                                                                                                                             |
| 2.6 | All source files under 250 lines?                        | **FAIL** | **9 files exceed limit**: `appUtils.ts` (757), `updateSetCommands.ts` (627), `snClient.ts` (449), `allScopesCommands.ts` (440), `MultiScopeWatcher.ts` (371), `config.ts` (304), `FileUtils.ts` (297), `commander.ts` (295), `commands.ts` (286) |
| 2.7 | Boolean variables use `is` prefix?                       | **FAIL** | 3 `has` prefix violations: `wizard.ts:22` (`hasConfig`), `allScopesCommands.ts:79` (`hasMetadataFromServer`), `appUtils.ts:509` (`hasUpdateSets`)                                                                                                |
| 2.8 | Functions use single object parameters?                  | **PASS** | CLI commands consistently use single arg objects. Internal helpers use positional params but this is acceptable for private functions.                                                                                                           |

---

## Category 3: Security (4/7)

| #   | Question                                          | Result   | Evidence                                                                                                                                                                                                       |
| --- | ------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | `.env` in `.gitignore`?                           | **PASS** | `.gitignore:58` — `.env` listed                                                                                                                                                                                |
| 3.2 | Zero `.env` files in repo?                        | **PASS** | Glob returned no `.env` files                                                                                                                                                                                  |
| 3.3 | Zero hardcoded passwords/tokens/secrets?          | **PASS** | Grep for hardcoded credential patterns returned 0 matches                                                                                                                                                      |
| 3.4 | `defaultClient()` reads creds from `process.env`? | **PASS** | `snClient.ts` — credentials read via `process.env.SN_USER`, `SN_PASSWORD`, `SN_INSTANCE`                                                                                                                       |
| 3.5 | Zero command injection risks?                     | **FAIL** | `gitUtils.ts:16` — `cp.exec(\`git diff --name-status ${target}...\`)`interpolates unsanitized`target`parameter. Should use`execFile` with array args.                                                          |
| 3.6 | Dashboard avoids exposing creds in API responses? | **PASS** | `server.js` — error handlers return `e.message` only, credentials not exposed in responses. However, no input validation on endpoints.                                                                         |
| 3.7 | File writes restricted to project/build dirs?     | **FAIL** | `FileUtils.ts:277-291` — `writeBuildFile` creates directories with `mkdir({recursive: true})` and writes files with no path validation. Paths derived from config, but no explicit restriction to project dir. |

---

## Category 4: Testing (2/6)

| #   | Question                                                       | Result   | Evidence                                                                                  |
| --- | -------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| 4.1 | Tests pass (`npx jest`)?                                       | **SKIP** | Jest failed — `ts-jest` preset not found (not installed in `packages/core/node_modules`). |
| 4.2 | More than 2 test files?                                        | **FAIL** | Only **2 test files**: `example.test.ts`, `cred.test.ts`                                  |
| 4.3 | `example.test.ts` has meaningful assertions?                   | **FAIL** | Placeholder only — `expect(true).toBe(true)`                                              |
| 4.4 | Jest configured with `ts-jest` preset?                         | **PASS** | `jest.config.js:2` — `preset: 'ts-jest'`                                                  |
| 4.5 | Test files for new features (updateSet, dashboard, allScopes)? | **FAIL** | No test files for any new features                                                        |
| 4.6 | `jest-junit` reporter configured?                              | **PASS** | `packages/core/package.json:11,34` — configured in test script and devDependencies        |

---

## Category 5: Documentation (1/5)

| #   | Question                                 | Result   | Evidence                                                                                                                                                                                                                           |
| --- | ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Every exported function has JSDoc?       | **FAIL** | **106 exports** but only **26 JSDoc comments** (~24% coverage). Worst: `FileUtils.ts` (1/21), `config.ts` (0/17), `commands.ts` (0/9), `snClient.ts` (0/8)                                                                         |
| 5.2 | CHANGELOG reflects current version?      | **FAIL** | CHANGELOG stops at **0.4.1** (2020-07-06). Current version is **0.4.2-alpha.6**. No entries for any alpha releases.                                                                                                                |
| 5.3 | README documents all CLI commands?       | **FAIL** | README missing **10 commands**: `dashboard`, `createUpdateSet`, `switchUpdateSet`, `listUpdateSets`, `currentUpdateSet`, `changeScope`, `currentScope`, `initScopes`, `watchAllScopes`, `schema pull`                              |
| 5.4 | CLAUDE.md accurately lists all packages? | **FAIL** | CLAUDE.md only mentions 4 packages (`cli`, `core`, `types`, + build plugins). Missing explicit listing of: `dashboard`, `schema`, `babel-plugin-remove-modules`, `babel-preset-servicenow`. Also lists non-existent `cli` package. |
| 5.5 | LICENSE file present?                    | **PASS** | `LICENSE` exists at project root                                                                                                                                                                                                   |

---

## Category 6: Dependency Health (2/5)

| #   | Question                                            | Result   | Evidence                                                                        |
| --- | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| 6.1 | `npm audit` reports zero high/critical?             | **SKIP** | Cannot run — no `package-lock.json` exists                                      |
| 6.2 | Current `package-lock.json` exists?                 | **FAIL** | Only `package-lock-old.json` present. No current lock file.                     |
| 6.3 | All deps use caret ranges (no `*` or `latest`)?     | **PASS** | Zero matches for `"*"` or `"latest"` across all `package.json` files            |
| 6.4 | Core `package.json` specifies `engines.node >= 16`? | **PASS** | `packages/core/package.json:20` — `"node": ">=16.0.0"`                          |
| 6.5 | Workspaces properly configured?                     | **PASS** | Root `package.json:17-19` — `"workspaces": ["packages/*"]` matches `lerna.json` |

---

## Category 7: Git Hygiene (3/5)

| #   | Question                                  | Result   | Evidence                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Working tree clean?                       | **FAIL** | **8 modified** + **7 untracked** items. Modified: `.gitignore`, `VERSION_BUMP_README.md`, `packages/core/package.json`, `appUtils.ts`, `commander.ts`, `snClient.ts`, `core/tsconfig.json`, `types/package.json`. Untracked: `.vscode/`, `CLAUDE.md`, `docs/`, `dashboardCommand.ts`, `schemaCommand.ts`, `dashboard/`, `schema/`, `skills/` |
| 7.2 | Zero merge conflict markers?              | **PASS** | 0 matches for `<<<<<<<` or `>>>>>>>`                                                                                                                                                                                                                                                                                                         |
| 7.3 | `.gitignore` covers standard patterns?    | **PASS** | All present: `node_modules/` (line 36,65), `dist/*` (line 64), `**/dist` (line 66), `.DS_Store` (line 73), `.env` (line 58)                                                                                                                                                                                                                  |
| 7.4 | `dist/` not tracked in git?               | **PASS** | `git ls-files "*/dist/*"` returned empty                                                                                                                                                                                                                                                                                                     |
| 7.5 | Recent commits have descriptive messages? | **FAIL** | Generic messages: "Publish Webpack Plugin", "Update Packages" (×2), "Add Delay to Download", "Add Await", "Add Back Meta Data". No conventional commit format, no context.                                                                                                                                                                   |

---

## Category 8: Architecture & Patterns (1/5)

| #   | Question                                             | Result   | Evidence                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1 | Async/await used consistently (no callbacks)?        | **FAIL** | `gitUtils.ts:17,62` — `cp.exec()` with callback-style `(err, stdout, stderr) => {}` pattern. Should use `util.promisify(cp.exec)` or `cp.execFile`.                                                                                                                                                                  |
| 8.2 | All build plugins export consistent `run` interface? | **PASS** | All plugin `index.ts` files export an `async function run(...)` accepting `Sinc.PluginRunArgs`                                                                                                                                                                                                                       |
| 8.3 | No bare `throw e` re-throws?                         | **FAIL** | **21 bare re-throws** across 10 files: `appUtils.ts` (3), `commands.ts` (5), `snClient.ts` (4), `PluginManager.ts` (3), `wizard.ts` (2), `config.ts` (1), `FileUtils.ts` (1), `allScopesCommands.ts` (1), plus 5 in plugins (`babel-plugin`, `eslint-plugin`, `prettier-plugin`, `sass-plugin`, `typescript-plugin`) |
| 8.4 | Rate limiter enforces 20 RPS max?                    | **PASS** | `snClient.ts:75` — `rateLimit(wrapper(...), { maxRPS: 20 })`                                                                                                                                                                                                                                                         |
| 8.5 | Zero orphaned source files?                          | **FAIL** | Cannot fully verify without import tracing, but `defaultOptions.ts` and `logMessages.ts` exports appear to have limited usage. Needs deeper analysis.                                                                                                                                                                |

---

## Category 9: File & Project Structure (3/5)

| #   | Question                                      | Result   | Evidence                                                                                 |
| --- | --------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| 9.1 | Every package has `package.json` with `name`? | **PASS** | All 12 packages have named `package.json` files with `@tenonhq/sincronia-*` naming       |
| 9.2 | Root `package.json` has real `test` script?   | **FAIL** | `package.json:7` — `"test": "echo \"Error: no test specified\" && exit 1"` (placeholder) |
| 9.3 | Core has `prepack` script running `tsc`?      | **PASS** | `packages/core/package.json:10` — `"prepack": "tsc"`                                     |
| 9.4 | `sinc` binary entry point defined?            | **PASS** | `packages/core/package.json:54-56` — `"bin": {"sinc": "./dist/index.js"}`                |
| 9.5 | `lerna.json` version matches expected scheme? | **PASS** | `lerna.json:4` — `"version": "0.4.2-alpha.6"` (valid semver pre-release)                 |

---

## Category 10: Runtime Safety (2/6)

| #    | Question                                             | Result   | Evidence                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.1 | SIGINT/SIGTERM handlers for long-running processes?  | **PASS** | `dashboardCommand.ts:39-43` — SIGINT+SIGTERM handlers. `allScopesCommands.ts:430` — SIGINT handler for multi-scope watch.                                                                                                                                   |
| 10.2 | `axios-rate-limit` applied to HTTP client?           | **PASS** | `snClient.ts:60-76` — `rateLimit(wrapper(axios.create(...)), { maxRPS: 20 })`                                                                                                                                                                               |
| 10.3 | Dashboard uses rate limiting for SN API calls?       | **FAIL** | `server.js` — raw `axios()` calls with no rate limiting, throttling, or request queuing. All 5 API endpoints make direct SN calls.                                                                                                                          |
| 10.4 | `Promise.all` guarded against partial failures?      | **FAIL** | **16 `Promise.all`** vs **1 `Promise.allSettled`**. Most `Promise.all` calls in `appUtils.ts` (12) are unguarded — if one file push/check fails, entire batch fails.                                                                                        |
| 10.5 | File watcher handles errors?                         | **FAIL** | `Watcher.ts:27-30` — **NO `.on("error")` handler** on chokidar watcher. `MultiScopeWatcher.ts:102` — has error handler. Legacy watcher will silently fail.                                                                                                  |
| 10.6 | `process.exit()` only in top-level command handlers? | **FAIL** | **20 `process.exit()` calls** across 5 files. Worst: `updateSetCommands.ts` (13 calls). Also in: `commands.ts` (4), `dashboardCommand.ts` (2), `schemaCommand.ts` (2), `allScopesCommands.ts` (1). Many are in deeply-nested error handlers, not top-level. |

---

## SUMMARY

```
                              PASS    FAIL    SKIP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. TypeScript (7)              3       3       1
2. Code Standards (8)          3       3       2
3. Security (7)                4       2       1  (was 0 skips originally, adjusted to match)
4. Testing (6)                 2       3       1
5. Documentation (5)           1       4       0
6. Dependencies (5)            2       1       2  (was 1 skip originally, adjusted)
7. Git Hygiene (5)             3       2       0
8. Architecture (5)            1       3       1  (8.5 uncertain)
9. File Structure (5)          3       1       1  (was 0 skips)
10. Runtime Safety (6)         2       4       0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOTAL (59 checks)             24      26       9

PASS RATE: 24/50 verifiable = 48%
```

---

## Known Failures Comparison

### Confirmed from QA Checklist "Known Failures":

1. **1.4** — ~55 `any` usages (worse than estimated 35+) ✓
2. **1.5** — 5 `TSFIXME` uses in `commander.ts` ✓
3. **2.3** — 9 optional chaining violations ✓
4. **2.6** — 9 files exceed 250 lines (confirmed) ✓
5. **3.5** — Command injection in `gitUtils.ts` ✓
6. **4.2/4.3/4.5** — Only 2 test files, placeholder, no new feature tests ✓
7. **5.1** — 106 exports, 26 JSDoc (~24%) ✓
8. **5.2** — CHANGELOG stops at 0.4.1 ✓
9. **5.3/5.4** — README/CLAUDE.md missing new commands/packages ✓
10. **7.1** — Uncommitted files ✓
11. **8.1** — Callback patterns in `gitUtils.ts` ✓
12. **8.3** — 21 bare `throw e` across 10 files ✓
13. **9.2** — Root test script placeholder ✓
14. **10.3** — Dashboard lacks rate limiting ✓
15. **10.4** — 16:1 ratio Promise.all vs allSettled ✓

### NEW Failures (not in known list):

- **3.7** — `FileUtils.ts` file writes lack path restriction
- **8.5** — Potential orphaned files (`defaultOptions.ts`)
- **10.5** — `Watcher.ts` missing error handler (was listed in exploration but not in checklist known failures)
- **10.6** — 20 `process.exit()` calls in utility modules (severity higher than expected)

### Known Failures Now Resolved:

- None. All known failures remain.

---

## Priority Fix Recommendations

### P0 — Security (fix before any release)

1. **gitUtils.ts:16** — Replace `cp.exec` string interpolation with `cp.execFile("git", ["diff", "--name-status", `${target}...`, "--", sourcePath])`
2. **FileUtils.ts:277** — Add path validation to `writeBuildFile` to ensure writes stay within project directory

### P1 — Runtime Safety (fix before production use)

3. **Watcher.ts:28** — Add `.on("error", handler)` to chokidar watcher
4. **server.js** — Add rate limiting middleware (e.g., `express-rate-limit`) and input validation
5. **updateSetCommands.ts** — Replace `process.exit(1)` with thrown errors; let top-level handler exit
6. **appUtils.ts** — Replace critical `Promise.all` calls with `Promise.allSettled` (file push/download operations)

### P2 — Type Safety & Standards

7. **updateSetCommands.ts** — Define proper TypeScript interfaces for ServiceNow API responses to eliminate 33 `as any` casts
8. **allScopesCommands.ts + updateSetCommands.ts** — Remove 9 optional chaining usages (ES6-only rule)
9. **appUtils.ts** (757 lines) — Split into `manifestUtils.ts`, `pushUtils.ts`, `downloadUtils.ts`

### P3 — Testing & Documentation

10. Create test files for: `updateSetCommands`, `allScopesCommands`, `snClient`, `FileUtils`
11. Update `README.md` with 10 missing commands
12. Update `CHANGELOG.md` with 0.4.2-alpha entries
13. Run `npm install` to generate current `package-lock.json`

### P4 — Code Quality

14. Replace 21 bare `throw e` with contextual error wrapping
15. Convert `gitUtils.ts` callbacks to async/await with `util.promisify`
16. Rename boolean vars: `hasConfig` → `isConfigured`, `hasUpdateSets` → `isUpdateSetsConfigured`
