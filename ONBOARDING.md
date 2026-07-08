# Dovetail — Developer Onboarding

> From zero to a merged change. If you're a **Claude Code session**, read [`docs/claude-operating-guide.md`](docs/claude-operating-guide.md) instead — this doc is for a human contributing _to_ Dovetail.

Dovetail is an npm-workspaces monorepo of **20 published `@tenonhq/dovetail-*` packages**: a bidirectional ServiceNow sync engine (`dove` CLI), a build toolchain (Babel/TypeScript/Webpack/SASS plugins), an action layer (SN authoring helpers, three MCP servers, ClickUp/Google clients), and the Update-Set Dashboard. Full map: [`docs/INDEX.md`](docs/INDEX.md) and the repo [`CLAUDE.md`](CLAUDE.md) → Package Inventory.

---

## 1. Prerequisites

- **Node 22 LTS** — required (`engines.node >= 22`). Use `nvm use 22`.
  > The wider Craftsman repo uses Node 12/20 for components and SN sync — Dovetail tooling is the **Node 22** corner. Don't reuse a Node 12 shell here.
- npm 10+ (ships with Node 22).
- A ServiceNow dev instance + credentials only if you'll run live sync/authoring (not needed to build/test).

## 2. Clone & install

```bash
git clone <craftsman-remote> && cd Craftsman/Dovetail
nvm use 22
npm install            # installs the whole workspace; hoists shared deps
```

`npm install` links every `packages/*` together via workspaces — local packages resolve to each other without publishing.

## 3. Build (dependency order)

Packages depend on each other (e.g. nearly everything on `core`/`types`), so build **in topological order** with the workspace runner:

```bash
node Scripts/run-workspaces.js prepack    # runs `tsc` (+ dist validation) in every package, in dep order
```

`Scripts/run-workspaces.js` toposorts the workspace and runs the named npm script in each package, skipping packages that don't define it (`Scripts/lib/workspace.js`). Build a single package with `npm run prepack -w @tenonhq/dovetail-core`.

## 4. Test

```bash
npm test                                  # = node Scripts/run-workspaces.js test (every package)
npm test -w @tenonhq/dovetail-mcp         # one package
```

Per-package tests run on **Jest**. A jest `test` script with no test files gets `--passWithNoTests` appended by the runner, so an empty package counts as a pass instead of blocking the suite.

## 5. Make a change

1. **Branch off `main`** (one repo per change — Dovetail is its own git repo, separate from Craftsman/ServiceNow/Mortise):
   ```bash
   git worktree add -b docs/DEV-xxx-my-change "@GitWorkTrees/my-change" origin/main
   ```
   Branch naming: `{feature|fix|chore|docs}/{task-id}-{slug}` (include the ClickUp task ID so `pr-clickup-sync` links it).
2. Edit the owning package under `packages/<pkg>/src/`. Reuse existing utilities first (see [`CLAUDE.md`](CLAUDE.md) → which package).
3. **Validate before claiming done:** `npm run prepack -w <pkg>` and `npm test -w <pkg>`. Fix and re-run; don't report green on a red build.
4. Commit with a conventional message (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`; subject < 72 chars).

## 6. Open the PR — **DRAFT, always**

```bash
gh pr create --draft --base main --title "feat: …" --body "…"
```

**Every Dovetail PR opens as DRAFT — no exceptions, even docs-only.** Merge-to-`main` touching `packages/**` auto-publishes the changed packages to npm immediately, and a bad version cannot be cleanly unpublished. Convert to _Ready for review_ only after sign-off, then merge from there. (The only override is an explicit instruction like "open it as ready".)

## 7. What happens on merge (auto-publish)

`.github/workflows/publish.yml` fires on merge to `main` touching `packages/**`:

1. **Scope** — only packages with changed files are built + published, in dependency order.
2. **Gate** — the _entire_ monorepo must `tsc`-build and pass tests; any failure publishes **nothing**.
3. **Version** — auto patch-bump: `max(package.json version, npm-latest + 1 patch)`. For a minor/major, edit the package `version` in your PR and CI honors it.
4. **After publish** — CI commits `postpublish` version bumps back to `main` as `chore(release): … [skip ci]` and cuts git tags + GitHub Releases per package.

Preview a merge without publishing: `node Scripts/publish-on-merge.js --dry-run` (orchestration: [`Scripts/PUBLISHING.md`](Scripts/PUBLISHING.md)).

---

## FAQ

**Why must every PR be a draft?**
Merge auto-publishes to npm and npm versions can't be cleanly unpublished. Draft is the safety interlock so nothing ships before sign-off. Convert to Ready only when done.

**Why is the package version in `main` one patch ahead of npm?**
The `postpublish` hook bumps `package.json` after a publish and commits it back as `chore(release): … [skip ci]`. So source is always ~1 patch ahead of the published version — that's expected, not drift.

**Which package do I edit for X?**

- ServiceNow sync / the `dove` CLI / V2 Flow codec → `core`
- SN dictionary, choices, views, layouts, flow authoring → `servicenow` (`dove-sn`)
- Plans/Q&A/handoff dashboard → `claude-plans`
- ClickUp/Gmail/Calendar/SN _read_ tools for Claude → `mcp`
- Build transforms → the matching `*-plugin` / `babel-*` package
- Cross-instance update-set promotion → `sawmill`

**`dove` vs `dove-sn` vs `dove-claude-plans`?**
`dove` (core) = sync + records + update sets + build/deploy. `dove-sn` (servicenow) = declarative SN view/layout/flow/choice authoring. `dove-claude-plans` (claude-plans) = manage the plan store + run the plans MCP. Each also has an `mcp` mode; full surface in [`docs/claude-operating-guide.md`](docs/claude-operating-guide.md).

**Is there a `dove diff` command?**
No. `--diff <branch>` is a flag on `dove push` and `dove build` that scopes the operation to files changed vs a git branch.

**What is `sawmill`?**
A thin client for the Sawmill Scripted REST API that retrieves, previews, and commits update sets **across ServiceNow instances** (cross-instance promotion). Library only — no CLI. See [`packages/sawmill/README.md`](packages/sawmill/README.md).

**Why are there `packages/tables/` and `packages/tables-data/` with no `package.json`?**
They aren't packages — they're stray build artifacts (`coverage/`, `dist/`). Ignore them; don't treat them as workspaces.

**How many MCP tools are there, and can Claude write to ServiceNow/ClickUp?**
41 tools across three MCP servers. ClickUp writes (4, in `dovetail-mcp`) are gated behind `SINC_MCP_WRITES_ENABLE=1` and dry-run unless `confirm:true`. SN authoring writes (5, in the `dovetail-servicenow` MCP) always go through an update set and support `dryRun`. Full catalog: [`docs/claude-operating-guide.md`](docs/claude-operating-guide.md).

**Build fails right after clone — what first?**
Confirm `nvm use 22` (not a leftover Node 12/20 shell), then re-run `npm install` and `node Scripts/run-workspaces.js prepack`. Packages build in dependency order; a failure in `core`/`types` cascades.

---

_Last updated: 2026-05-29. See [`docs/INDEX.md`](docs/INDEX.md) for the full doc set._
