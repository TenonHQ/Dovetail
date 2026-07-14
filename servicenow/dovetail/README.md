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
  into a sandbox with ServiceNow stubs — so a regression here fails CI.

  > Not to be confused with `../sys_script_include/SincUtilsMS.js`, which backs the
  > **dead** Sincronia API and carries the same (now un-fixed) bug. It is slated for
  > removal, not repair.

_TODO — capture the remaining live ops here so the whole API is version-controlled:_
`createRecord`, `createUpdateSet`, `changeScope`, `changeUpdateSet`,
`currentUpdateSet`, `deleteRecord` (write API), plus the remaining `Dovetail Sync`
operation handlers (`getManifest.js`, `bulkDownload.js`, … — the thin wrappers that
call into `DovetailUtilsMS`) and the `Dovetail Promote` ops.

## Relationship to the legacy Sincronia API

The `/api/sinc/sincronia/*` API documented in [`../README.md`](../README.md) is
**dead** — the current client calls none of its operations (they moved to the
`/api/cadso/dovetail*` defs above). Its decommission is tracked in
[`../../docs/dovetail-servicenow-migration.md`](../../docs/dovetail-servicenow-migration.md).
