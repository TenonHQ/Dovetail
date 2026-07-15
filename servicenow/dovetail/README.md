# Dovetail server-side REST API source (`/api/cadso/dovetail*`)

Version-controlled source for the **live** global-scope Dovetail Scripted REST
API that `@tenonhq/dovetail-core` calls today. Until now these ops were only
exported ad-hoc to `Downloads/*.xml` and hand-edited per instance — unreviewable
and un-promotable. This directory is the source of truth going forward.

## Live definitions (all global scope)

| Def name | Base path | Role |
|---|---|---|
| **Dovetail Core** | `/api/cadso/dovetail_core` | write/action ops — the client's primary target |
| **Dovetail** | `/api/cadso/dovetail` | same ops, legacy path — client 404-fallback target |
| **Dovetail Sync** | `/api/cadso/dovetail_sync` | `getAppList` / `getManifest` / `bulkDownload` / `getCurrentScope` / `pushATFfile` |
| **Dovetail Promote** | `/api/cadso/dovetail_promote` | cross-instance update-set promotion |

`sys_id`s differ per instance — look defs up by name, never hardcode.

## Contents

- `sys_ws_operation/pushWithUpdateSet.js` — update a record inside a specified
  update set. **Hardened**: switches to the target update set's application scope
  before `gr.update()` so a scoped record's change is captured into the requested
  set (previously it landed in the caller's session/default set — routed pushes
  reported success while capturing nothing). Present on both the `Dovetail Core`
  and `Dovetail` defs.

- `sys_script_include/DovetailUtilsMS.js` — the base class behind **`Dovetail Sync`**:
  `getManifest`, `bulkDownload` (`processMissingFiles`), `getAppList`,
  `getCurrentScope`, `pushATFfile`. This is the **server half of the sync engine** —
  every `dove refresh` runs through it. **Hardened**: `buildTableMap` and
  `processMissingFiles` key records by display name, so two records sharing a name
  used to silently overwrite each other — one vanished from the manifest with no
  warning, and because the survivor kept the shared folder, a later push to that
  folder wrote to the **wrong record**. Colliding names are now disambiguated with a
  sys_id suffix (`Blueprint (1607d7f0)`) and a `gs.warn`. Covered by
  `packages/core/src/tests/dovetailUtilsMSCollision.test.ts`, which loads this file
  into a sandbox with ServiceNow stubs — so a regression here fails the pre-publish
  test gate in CI (`publish.yml` runs the full suite before anything ships).

  > Not to be confused with `../sys_script_include/SincUtilsMS.js`, which backs the
  > **dead** Sincronia API and carries the same (now un-fixed) bug. It is slated for
  > removal, not repair.

- `sys_ws_operation/` — the rest of the live operation handlers, captured verbatim
  from the instance (`tenonworkstudio`, 2026-07-14):
  - **Dovetail Core / Dovetail** write + scope/update-set ops: `createRecord.js`,
    `deleteRecord.js`, `createUpdateSet.js`, `changeScope.js`, `changeUpdateSet.js`,
    `currentUpdateSet.js`. These ops are mirrored on both the `Dovetail Core` (primary)
    and `Dovetail` (legacy 404-fallback) defs. The three POST ops are identical across
    both defs; the three GET ops (`changeScope`, `changeUpdateSet`, `currentUpdateSet`)
    have **drifted** — the `Dovetail Core` def carries a newer ES5 rewrite (2026-06-01)
    while the legacy `Dovetail` def still runs the older ES6 variant (2025-08-10). Since
    `Dovetail Core` is the client's primary target, **the Core version is captured here**
    as canonical. (Reconciling the legacy def to match is a separate cleanup.)
  - **Dovetail Sync** thin wrappers into `DovetailUtils`: `getAppList.js`,
    `getManifest.js`, `bulkDownload.js`, `getCurrentScope.js`, `pushATFfile.js`.
  - **Dovetail Promote**: `promote.js`.

- `sys_script_include/DovetailUtils.js` — entry-point class the `Dovetail Sync` ops
  instantiate (`new DovetailUtils()`); extends `DovetailUtilsMS`.

- `sys_script_include/DovetailPromote.js` — the engine behind `promote.js`:
  retrieve → preview → (optionally) commit a named update set from a registered
  update-set source. The commit path replicates the platform's
  `UpdateSetCommitAjax.commitRemoteUpdateSet`.

> **These are the cadso-scope successors to the dead `../sys_script_include/SincUtils*`
> + `../sys_ws_operation/*` handlers.** `DovetailUtilsMS` has since diverged forward
> (the duplicate-display-name collision guard above); the Sincronia copies carry the
> old, unfixed logic and are slated for removal, not repair.

### Deployment note

These live in **global scope**, which `dove` does not sync (`dove.config.js` excludes
global scope), so there is no automated repo→instance push for this folder — it is a
**source-of-truth mirror** for review and promotion, kept current by capturing from the
instance. When an op changes on the instance, re-capture the handler here in the same PR.

## Relationship to the legacy Sincronia API

The `/api/sinc/sincronia/*` API documented in [`../README.md`](../README.md) is
**dead** — the current client calls none of its operations (they moved to the
`/api/cadso/dovetail*` defs above). Its decommission is tracked in
[`../../docs/dovetail-servicenow-migration.md`](../../docs/dovetail-servicenow-migration.md).
