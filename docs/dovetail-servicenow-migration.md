# ServiceNow-side Dovetail rebrand plan

This document describes the changes needed **on the ServiceNow instance** (and in the separate ServiceNow source-of-truth repo where the API definition is exported) to complete the Sincronia → Dovetail rebrand. The npm-package side of this rebrand lives in the main Dovetail repo (`tenonhq/dovetail`); this file enumerates the changes that must happen elsewhere.

## What is changing on the ServiceNow side

The Dovetail CLI talks to a Scripted REST API on every connected ServiceNow instance. Today that API is named **"Claude"** with base path `/api/cadso/claude/`. After this rebrand:

| Field | Old value | New value |
|---|---|---|
| Scripted REST API record `name` | `Claude` | `Dovetail` |
| Scripted REST API `service_id` (URL component) | `claude` | `dovetail` |
| Full base path | `/api/cadso/claude/` | `/api/cadso/dovetail/` |
| Web service definition `sys_id` | `b8a9db8d33d7a6107b18bc534d5c7b7b` | **unchanged** (we update the record in place) |
| Operation `name` prefix | `Sinc - …` (where present) | `Dovetail - …` |
| Operation `relative_path` | unchanged (e.g. `/createRecord`) | unchanged |
| Operation `sys_id` values | unchanged | unchanged |

The six operations under this API stay the same in shape, payload, and behavior: `changeScope`, `currentUpdateSet`, `changeUpdateSet`, `pushWithUpdateSet`, `createRecord` (a.k.a. `Sinc - Create Record`), `deleteRecord` (a.k.a. `Sinc - Delete Record`).

## Steps

1. **In ServiceNow Studio (or via the platform UI):** open the Scripted REST API record with sys_id `b8a9db8d33d7a6107b18bc534d5c7b7b`.
   - Change `Name` from `Claude` to `Dovetail`.
   - Change `API ID` (the `service_id` field — the URL path segment) from `claude` to `dovetail`.
   - Save. The full path automatically becomes `/api/cadso/dovetail/<op>` for every existing operation.
2. **Rename "Sinc - " prefixed operations** so that listing them in the platform UI matches the new brand:
   - `Sinc - Create Record` → `Dovetail - Create Record`
   - `Sinc - Delete Record` → `Dovetail - Delete Record`
   - Other operations whose name does not include "Sinc" / "Claude" can stay as-is, but a sweep is cheap; rename anything whose `name` references the old branding.
3. **Re-export the API record(s) to XML** from the platform: navigate to the Scripted REST API record, right-click the form header, and choose `Export → XML`. The export will include the renamed parent record plus all child operations.
4. **Update the source-of-truth repo** (the separate repo that holds the ServiceNow XML exports for this API):
   - Replace the existing `Downloads/sys_ws_operation (web_service_definition=b8a9db8d33d7a6107b18bc534d5c7b7b)*.xml` file (or whatever path your repo uses) with the freshly exported XML.
   - If the repo also holds Scripted REST API source records (e.g. `sys_ws_definition_*.xml`), update those too.
   - Update any README / inline docs in that repo that reference "Claude" by name.
5. **Search ServiceNow-side scripts** (script includes, business rules, etc.) for hardcoded references to the old API path:
   - In the Sincronia source repo: `servicenow/sys_script_include/SincUtils.js` and `servicenow/sys_script_include/SincUtilsMS.js` — confirm they don't call `/api/cadso/claude/...` directly. If they do, swap to `/api/cadso/dovetail/...`.
   - Same for any related script includes living only on the instance (not in a repo).
6. **Optional, for safety during rollout:** before removing the old `claude` `service_id`, you can temporarily clone the API record under both `claude` and `dovetail` paths so existing CLI clients keep working during the upgrade window. Approach: leave the existing record as-is, create a *second* Scripted REST API named "Dovetail" with `service_id = dovetail` and identical operations, point new clients at it, then delete the old "Claude" record after all clients have migrated. This is more work but eliminates the brittle re-import-during-maintenance-window concern below.

## Coordination caveat

Because the web service definition's `sys_id` does not change, importing the renamed XML over an existing instance updates the record in place — the old `claude` path stops working as soon as the import completes. The Dovetail CLI ships a client-side fallback that retries `/api/cadso/dovetail/<op>` requests against `/api/cadso/claude/<op>` on 404, so customers who have updated their npm packages but have *not yet* re-imported the API XML will keep working with a deprecation warning. After they re-import, the fallback path stops responding (the old path is gone) and only the new path works.

**Document this for customers:** "Update the Dovetail npm packages and re-import the new ServiceNow API XML in the same maintenance window." The fallback cushions the seam, it doesn't eliminate it.

## Verification

After applying the changes:

- `curl -u <user>:<pass> 'https://<instance>.service-now.com/api/cadso/dovetail/currentUpdateSet'` returns the current update set (200).
- `curl -u <user>:<pass> 'https://<instance>.service-now.com/api/cadso/claude/currentUpdateSet'` returns 404 (or whatever ServiceNow returns for an unknown `service_id`).
- A Dovetail CLI workflow that exercises each operation runs cleanly:
  - `dove status` (calls `currentUpdateSet`)
  - `dove createUpdateSet` + `dove switchUpdateSet` (calls `changeUpdateSet`)
  - `dove changeScope` (calls `changeScope`)
  - `dove push` against a known scoped change (calls `pushWithUpdateSet`)
  - `dove create <table>` (calls `createRecord`)
  - `dove delete <table>` (calls `deleteRecord`)

## What will not work without these changes

If the npm packages are upgraded to `@tenonhq/dovetail-*` but the ServiceNow API has not been renamed:

- The CLI's primary requests to `/api/cadso/dovetail/<op>` will return 404.
- The client-side fallback will retry against `/api/cadso/claude/<op>` and succeed (with a one-line stderr warning).
- This is graceful but not a steady state — finish the rename to silence the warnings and to avoid breaking when the fallback is removed in the next major Dovetail release.

## Related: the legacy `api/sinc/sincronia/*` Scripted REST API

Separate from the rebrand of `/api/cadso/claude/*` → `/api/cadso/dovetail/*`, Dovetail also calls a second Scripted REST API on ServiceNow exposed at `/api/sinc/sincronia/*` for the following operations:

- `getAppList` — list scoped applications on the instance
- `getCurrentScope` — read the user's currently-selected scope
- `getManifest` — fetch the manifest of a given scope
- `bulkDownload` — bulk-download all files for a scope
- `pushATFfile` — write an ATF test record

The handler scripts for these operations live in `servicenow/sys_ws_operation/` in this repo (`bulkDownload.js`, `getAppList.js`, etc.) and the API itself is registered in your ServiceNow source-of-truth repo. The path component `sincronia` is the Sincronia-derived service_id; the namespace `sinc` is registered separately on ServiceNow.

**Recommended rename** for full brand consistency: `/api/sinc/sincronia/*` → `/api/sinc/dovetail/*` (rename only the `service_id`; keep the `sinc` namespace to avoid the more-invasive change of registering a new ServiceNow namespace). When you do this:

1. Open the Scripted REST API record for the `sincronia` API on ServiceNow.
2. Change the `API ID` (service_id) from `sincronia` to `dovetail`.
3. Re-export the XML and update the source-of-truth repo.
4. Update Dovetail's client (`packages/core/src/snClient.ts`) to call `api/sinc/dovetail/<op>` and add the same kind of 404 fallback to the legacy `api/sinc/sincronia/<op>` path used for the cadso/dovetail rebrand.

This second rename has not been applied to the Dovetail npm packages yet because it is independent of the cadso/claude rebrand and requires its own coordinated ServiceNow-side change. It can ship in a later release when convenient.
