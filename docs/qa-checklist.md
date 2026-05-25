# Sincronia QA Audit — Programmatic Verification Checklist

## Context

AI agents have been working on the Sincronia project (`/Users/dman89/Documents/Tenon/Development/Craftsman/Sincronia`). This plan defines a comprehensive QA checklist of YES/NO questions that Claude can programmatically verify by reading files, running grep/glob, and executing safe shell commands. The goal is to confirm whether the codebase meets Tenon's standards across all dimensions.

---

## Checklist: 10 Categories, 50 Questions

### 1. TypeScript Compilation & Type Safety

| # | Question | Verify With |
|---|----------|-------------|
| 1.1 | Does the project compile without errors (`tsc --noEmit`)? | `cd Sincronia && npx tsc --noEmit` — exit code 0 |
| 1.2 | Is `strict: true` enabled in root `tsconfig.json`? | `grep '"strict": true' tsconfig.json` |
| 1.3 | Are there zero `@ts-ignore` or `@ts-nocheck` directives? | `Grep` for `@ts-ignore\|@ts-nocheck` in `packages/**/*.ts` |
| 1.4 | Is explicit `any` usage below 30 occurrences (excl. type defs)? | `Grep` for `: any` in `.ts` files, exclude `index.d.ts` and `TSFIXME` |
| 1.5 | Are there zero `TSFIXME` usages outside type definition files? | `Grep` for `TSFIXME` in `packages/*/src/*.ts` |
| 1.6 | Does core `tsconfig.json` extend the root config? | `grep '"extends"' packages/core/tsconfig.json` |
| 1.7 | Is ES target set to ES2019? | `grep '"target"' tsconfig.json` |

### 2. Code Standards Compliance

| # | Question | Verify With |
|---|----------|-------------|
| 2.1 | Does `prettier --check` pass on all `.ts` source files? | `npx prettier --check "packages/*/src/**/*.ts"` |
| 2.2 | Does ESLint pass with zero errors? | `npx eslint "packages/*/src/**/*.ts"` |
| 2.3 | Are there zero uses of optional chaining (`?.`)? | `Grep` for `\?\.` in `.ts` source files (ES6-only rule) |
| 2.4 | Does `.prettierrc` specify `semi: true` and `tabWidth: 2`? | Read `.prettierrc` |
| 2.5 | Is ESLint configured with `@typescript-eslint/recommended`? | Read `.eslintrc` |
| 2.6 | Are all source files under 250 lines? | `wc -l packages/*/src/*.ts` — check for >250 |
| 2.7 | Do boolean variables use the `is` prefix? | `Grep` for `(let\|const) (has\|should\|can\|was)` patterns |
| 2.8 | Are functions using single object parameters (not multiple args)? | Inspect exported function signatures in core `src/*.ts` |

### 3. Security

| # | Question | Verify With |
|---|----------|-------------|
| 3.1 | Is `.env` listed in `.gitignore`? | `grep "^\.env$" .gitignore` |
| 3.2 | Are there zero `.env` files in the repo (excl. node_modules)? | `Glob` for `**/.env` |
| 3.3 | Are there zero hardcoded passwords/tokens/secrets in source? | `Grep` for `password\|secret\|token\|api_key` with string literal values |
| 3.4 | Does `defaultClient()` read creds exclusively from `process.env`? | Read `snClient.ts` credential setup |
| 3.5 | Are there zero command injection risks (user input in exec/spawn)? | Inspect `gitUtils.ts` `cp.exec` calls for unsanitized interpolation |
| 3.6 | Does the dashboard avoid exposing credentials in API responses? | Read `packages/dashboard/server.js` response handlers |
| 3.7 | Are file writes restricted to project source/build dirs? | Inspect `FileUtils.ts` write operations |

### 4. Testing

| # | Question | Verify With |
|---|----------|-------------|
| 4.1 | Do existing tests pass (`npx jest`)? | `cd packages/core && npx jest --passWithNoTests` |
| 4.2 | Are there more than 2 test files? | `Glob` for `**/*.test.ts` excl. node_modules |
| 4.3 | Does `example.test.ts` contain meaningful assertions? | Read the file — check for real `expect()` beyond `true === true` |
| 4.4 | Is Jest configured with `ts-jest` preset? | Read `packages/core/jest.config.js` |
| 4.5 | Do test files exist for new features (updateSet, dashboard, allScopes)? | `Glob` for `*updateSet*test*`, `*dashboard*test*`, `*allScopes*test*` |
| 4.6 | Is `jest-junit` reporter configured for CI? | `grep "jest-junit" packages/core/package.json` |

### 5. Documentation

| # | Question | Verify With |
|---|----------|-------------|
| 5.1 | Does every exported function have a JSDoc comment? | Compare `export` count vs `/**` count across `src/*.ts` files |
| 5.2 | Does CHANGELOG.md reflect the current version (0.4.2-alpha.6)? | `grep "0.4.2" CHANGELOG.md` |
| 5.3 | Does README.md document all CLI commands (incl. dashboard, updateSet cmds)? | `Grep` for new command names in `README.md` |
| 5.4 | Does CLAUDE.md accurately list all packages in the monorepo? | Compare `ls packages/` against packages listed in `CLAUDE.md` |
| 5.5 | Is a LICENSE file present? | `test -f LICENSE` |

### 6. Dependency Health

| # | Question | Verify With |
|---|----------|-------------|
| 6.1 | Does `npm audit` report zero high/critical vulnerabilities? | `npm audit --audit-level=high` |
| 6.2 | Is there a current `package-lock.json` (not just `package-lock-old.json`)? | `Glob` for `package-lock*.json` at root |
| 6.3 | Are all dep versions using caret ranges (no `*` or `latest`)? | `Grep` for `"*"\|"latest"` in all `package.json` files |
| 6.4 | Does core `package.json` specify `engines.node >= 16`? | Read `packages/core/package.json` engines field |
| 6.5 | Are workspaces properly configured in root `package.json`? | Read root `package.json` workspaces field |

### 7. Git Hygiene

| # | Question | Verify With |
|---|----------|-------------|
| 7.1 | Is the working tree clean (no uncommitted changes)? | `git status --short` |
| 7.2 | Are there zero merge conflict markers in source files? | `Grep` for `<<<<<<<\|>>>>>>>\|=======` in `.ts`/`.js` files |
| 7.3 | Are `node_modules/`, `dist/`, `.DS_Store`, `.env` all in `.gitignore`? | Read `.gitignore` |
| 7.4 | Is `dist/` not tracked in git? | `git ls-files "*/dist/*"` — should be empty |
| 7.5 | Do recent commits have descriptive messages (not just "fix" or "save")? | `git log --oneline -10` — inspect quality |

### 8. Architecture & Patterns

| # | Question | Verify With |
|---|----------|-------------|
| 8.1 | Is async/await used consistently (no callback-style patterns)? | `Grep` for `cp.exec` with callbacks in `gitUtils.ts`, `fs.writeFile` callbacks |
| 8.2 | Do all build plugins export a consistent `run` interface? | Read `packages/*/src/index.ts` for each plugin |
| 8.3 | Is error handling consistent (no bare `throw e` re-throws)? | `Grep` for `throw e;` in source files |
| 8.4 | Does the rate limiter enforce 20 RPS max? | `grep "maxRPS" packages/core/src/snClient.ts` |
| 8.5 | Are there zero orphaned source files (not imported anywhere)? | For each `.ts` file, check if its name appears in imports elsewhere |

### 9. File & Project Structure

| # | Question | Verify With |
|---|----------|-------------|
| 9.1 | Does every package have a `package.json` with a `name` field? | Read each `packages/*/package.json` |
| 9.2 | Does the root `package.json` have a real `test` script (not placeholder)? | Read root `package.json` test script |
| 9.3 | Does core have a `prepack` script that runs `tsc`? | `grep '"prepack"' packages/core/package.json` |
| 9.4 | Is the `sinc` binary entry point defined? | `grep '"bin"' packages/core/package.json` |
| 9.5 | Does the root `package.json` declare `workspaces: ["packages/*"]`? | Read root `package.json` |

### 10. Runtime Safety

| # | Question | Verify With |
|---|----------|-------------|
| 10.1 | Are SIGINT/SIGTERM handlers registered for long-running processes? | `Grep` for `process.on("SIGINT")` in watcher/dashboard files |
| 10.2 | Is `axios-rate-limit` applied to the HTTP client? | `grep "rateLimit" snClient.ts` |
| 10.3 | Does the dashboard server also use rate limiting for SN API calls? | `Grep` for `rateLimit\|maxRPS\|throttle` in `dashboard/server.js` |
| 10.4 | Are `Promise.all` calls guarded against partial failures? | `Grep` for `Promise.all` vs `allSettled` usage in `appUtils.ts` |
| 10.5 | Does the file watcher handle errors (`.on("error", ...)`)? | Read `Watcher.ts` and `MultiScopeWatcher.ts` for error handlers |
| 10.6 | Does `process.exit()` only occur at top-level command handlers? | `Grep` for `process.exit` — verify none in utility modules |

---

## Known Failures (from exploration)

These items are **already identified as NO/FAIL** and represent the current technical debt:

1. **1.4** — ~35+ explicit `any` usages
2. **1.5** — 4 `TSFIXME` uses in `commander.ts`
3. **2.3** — 9 optional chaining violations (ES6-only rule)
4. **2.6** — 9 files exceed 250-line max (largest: `appUtils.ts` at 757)
5. **3.5** — Command injection risk in `gitUtils.ts` via `cp.exec`
6. **4.2/4.3/4.5** — Only 2 test files, one is a placeholder, no tests for new features
7. **5.1** — ~80 exports but only ~26 JSDoc comments
8. **5.2** — CHANGELOG stops at 0.4.1
9. **5.3/5.4** — README and CLAUDE.md missing new commands/packages
10. **7.1** — 7 uncommitted files + 4 untracked items
11. **8.1** — Callback patterns in `gitUtils.ts`
12. **8.3** — Bare `throw e` in 6+ locations
13. **8.6/2.8** — Many functions use multiple positional params
14. **9.2** — Root test script is a placeholder
15. **10.3** — Dashboard lacks rate limiting
16. **10.4** — Bare `Promise.all` without failure handling

---

## Execution Plan

1. **Run each verification command/check sequentially by category**
2. **Record YES/NO for each question**
3. **For NO answers, note the specific files and line numbers**
4. **Produce a summary scorecard**: `X/50 passing` with category breakdowns
5. **Prioritize failures by severity**: Security > Runtime Safety > Type Safety > Standards > Docs

---

## Critical Files

- `packages/core/src/snClient.ts` — HTTP client, credentials, rate limiting
- `packages/core/src/appUtils.ts` — Core business logic (757 lines)
- `packages/core/src/gitUtils.ts` — Command injection risk
- `packages/core/src/updateSetCommands.ts` — Optional chaining violations
- `packages/core/src/allScopesCommands.ts` — Optional chaining, duplication
- `packages/core/src/commander.ts` — TSFIXME usage
- `packages/dashboard/server.js` — No rate limiting, credential handling
- `packages/core/src/tests/` — Only 2 test files
