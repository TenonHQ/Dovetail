---
title: Dovetail Server-Side REST API — Endpoint Catalog
description: Contract-level catalog of every live /api/cadso/dovetail* operation — path, method, params, scope/update-set behavior, and a worked example, grounded in current client source.
status: living
type: reference
tags: [dovetail, servicenow, documentation]
owner: claude
last_updated: 2026-07-10
authority: canonical
related:
  [
    CLAUDE.md,
    docs/dovetail-servicenow-migration.md,
    servicenow/dovetail/README.md,
  ]
---

# Dovetail Server-Side REST API — Endpoint Catalog

> **Purpose:** answer "how do I create/choice/flow/update-set via Dovetail's REST layer" from this doc alone, without reading TypeScript. Every entry below is grounded in this repo's actual client source (`packages/core/src/snClient.ts`, `packages/sawmill/src/client.ts`) and, where it exists, the server-side handler script -- nothing here is guessed.
>
> **This is the first doc in this repo to carry Craftsman's living-doc frontmatter** (title/description/status/type/tags/owner/last_updated). Dovetail's other docs use a plain H1 + blockquote style (see `docs/INDEX.md`) -- that convention continues below the frontmatter; only the metadata block is new.

## Grounding legend

Every operation below is tagged with how directly its behavior is verified, because roughly half of them have no server-side script checked into this repo:

- 🟢 **Server-verified** -- an actual ServiceNow handler script exists in this repo; behavior is read from that script.
- 🟡 **Client-contract-only** -- verified to exist and its exact request shape confirmed from `snClient.ts`/`sawmill/client.ts`, but the ServiceNow-side handler script is **not checked into this repo** (see `servicenow/dovetail/README.md`'s open TODO). Path, method, and params are accurate; exact server-side edge-case behavior is not independently verifiable from source here.

## The four live Scripted REST API definitions

| Def name                   | Base path                     | Role                                                                                         | Client uses it                                                          |
| -------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Dovetail Core**          | `/api/cadso/dovetail_core`    | Write/action ops -- primary target                                                           | ✅ primary                                                              |
| **Dovetail** (legacy path) | `/api/cadso/dovetail`         | Same ops as Dovetail Core                                                                    | ✅ 404-fallback only, with a one-time deprecation warning (see Gotchas) |
| **Dovetail Sync**          | `/api/cadso/dovetail_sync`    | Read/bulk ops: `getAppList`, `getManifest`, `bulkDownload`, `getCurrentScope`, `pushATFfile` | ✅                                                                      |
| **Dovetail Promote**       | `/api/cadso/dovetail_promote` | Cross-instance update-set promotion (sawmill package)                                        | ✅                                                                      |

`sys_id`s differ per instance -- look definitions up by name, never hardcode (per `servicenow/dovetail/README.md`).

**Note on `CLAUDE.md`'s own REST API table:** it currently describes a single base path (`/api/cadso/dovetail/` falling back to `/api/cadso/claude/`) and lists 6 operations. That's stale relative to the actual client source and the more recently verified `docs/dovetail-servicenow-migration.md` (verified 2026-07-02) -- the real fallback is `dovetail_core` → `dovetail` (not `claude`), and there are 4 defs, not 1, plus an 8th operation (`createUpdateSet`) not in that table at all. This catalog is grounded in current source; `CLAUDE.md`'s table should be refreshed separately.

---

## Dovetail Core (`/api/cadso/dovetail_core`, fallback `/api/cadso/dovetail`)

### `GET /changeScope` 🟡 client-contract-only

Switch the session's active application scope.

- **Params:** `?scope=<scope name>` (required)
- **Client:** `packages/core/src/snClient.ts:603-613`
- **Example:** `GET /api/cadso/dovetail_core/changeScope?scope=x_cadso_core`

### `GET /currentUpdateSet` 🟡 client-contract-only

Read the caller's current update set.

- **Params:** `?scope=<scope name>` (optional)
- **Client:** `packages/core/src/snClient.ts:587-601`
- **Example:** `GET /api/cadso/dovetail_core/currentUpdateSet?scope=x_cadso_core`

### `GET /changeUpdateSet` 🟡 client-contract-only

Switch the active update set.

- **Params:** `?sysId=<update set sys_id>` **or** `?name=<name>&scope=<scope>` (optional fields; op resolves by whichever is given)
- **Client:** `packages/core/src/snClient.ts:576-585`
- **Example:** `GET /api/cadso/dovetail_core/changeUpdateSet?sysId=abc123`

### `POST /pushWithUpdateSet` 🟢 server-verified

Update a record's fields inside a specified update set.

- **Body:** `{ update_set_sys_id, table, record_sys_id, fields }`
- **Client:** `packages/core/src/snClient.ts:615-629`
- **Server:** `servicenow/dovetail/sys_ws_operation/pushWithUpdateSet.js` -- **hardened**: switches the request's application scope to the target update set's scope _before_ calling `gr.update()`. Before this fix, a scoped record's change landed in the caller's session/default update set instead of the requested one -- routed pushes reported success while silently capturing nothing into the intended set.
- **Example:** `POST /api/cadso/dovetail_core/pushWithUpdateSet` with body `{"update_set_sys_id": "...", "table": "sys_script_include", "record_sys_id": "...", "fields": {"script": "..."}}`

### `POST /createRecord` 🟡 client-contract-only

Create a record.

- **Body:** `{ table, fields }` + optional `sys_id`, `scope`, `update_set_sys_id`. Supports cross-instance moves via an explicit `sys_id`.
- **Client:** `packages/core/src/snClient.ts:631-664`
- **Client-side guard (real pain point, now fixed):** a bare `createRecord` call against `table: "sys_db_object"` is **refused client-side** with an explicit error (`packages/core/src/snClient.ts:646-660`) -- a raw insert there only creates an orphaned metadata row with no physical table and no ACLs. The error message redirects to the `dove-sn create-table` capability instead. This guard exists _because_ someone hit this exact footgun before it was added.
- **Scope note:** the request body never includes `sys_scope` -- Dovetail's own field-building logic (`packages/core/src/reconcileCommand.ts:295-315`, `buildCreateFields()`) explicitly strips `sys_scope` before constructing the create payload, with the comment "sys*scope comes from `scope`" -- i.e. scope is conveyed via the separate `scope` parameter, never the body. Whether the \_server* would also ignore an explicitly-sent `sys_scope` field is not verifiable from this repo (no server script checked in for this op) -- documented as unverified rather than asserted.
- **Example:** `POST /api/cadso/dovetail_core/createRecord` with body `{"table": "sys_choice", "fields": {"name": "x_cadso_core_thing", "value": "foo", "label": "Foo"}, "scope": "x_cadso_core", "update_set_sys_id": "..."}`

### `POST /deleteRecord` 🟡 client-contract-only

Delete a record.

- **Body:** `{ table, sys_id }` + optional `scope`
- **Client:** `packages/core/src/snClient.ts:666-683`
- **Example:** `POST /api/cadso/dovetail_core/deleteRecord` with body `{"table": "sys_script_include", "sys_id": "..."}`

### `POST /createUpdateSet` 🟡 client-contract-only -- undocumented in `CLAUDE.md`

Create a new update set, scoped correctly in one server call.

- **Body:** `{ name, state: "in progress", application?: <scope sys_id>, description? }`
- **Client:** `packages/core/src/snClient.ts:444-501`
- **Why it exists (real pain point):** a raw Table API `POST` to `sys_update_set` ignores the `application` field (it defaults to the session's current app), and the older changeScope-then-POST workaround raced when two sets were created back to back, mis-scoping them. This op switches scope and inserts the set in a single server call so it always lands in the requested scope.
- **Fallback behavior (worth knowing):** if this endpoint 404s (an older instance without the op deployed yet), the client **silently degrades to the raw Table API path** -- and logs a warning that update sets created this way "may be mis-scoped until the op is deployed." This is the one place a caller can get a mis-scoped update set today, and it happens silently unless you're watching the logs.
- **Example:** `POST /api/cadso/dovetail_core/createUpdateSet` with body `{"name": "DEV-543 catalog work", "state": "in progress", "application": "<scope sys_id>"}`

---

## Dovetail Sync (`/api/cadso/dovetail_sync`)

All four of these are read/bulk operations used by `dove refresh`/`dove pull`/ATF pushes. **No server-side handler script for the current live def is checked into this repo** -- the files under `servicenow/sys_ws_operation/` (no `dovetail/` in the path) are the **dead Sincronia-era** versions of these same operation names (see Deprecated section below), not the current implementation. Treat all four as 🟡 client-contract-only; do not infer current server behavior from the old scripts.

### `GET /getAppList` 🟡 client-contract-only

List all application scopes. No params. `packages/core/src/snClient.ts:349-353`.

### `GET /getCurrentScope` 🟡 client-contract-only

Read the current user's active scope. No params. `packages/core/src/snClient.ts:438-442`.

### `POST /getManifest/{scope}` 🟡 client-contract-only

Full manifest of records (optionally with file contents) for a scope.

- **Path param:** `{scope}`
- **Body:** `{ includes, excludes, tableOptions, withFiles, getContents }` (note: the wire field is `getContents`, not `withFiles` -- the client renames it before sending, per `packages/core/src/snClient.ts:547-573`)

### `POST /bulkDownload` 🟡 client-contract-only

Download file contents for a set of specific missing records.

- **Body:** `{ missingFiles, tableOptions }` -- `packages/core/src/snClient.ts:534-545`

### `POST /pushATFfile` 🟡 client-contract-only

Update an ATF test step's `inputs.script` field.

- **Body:** `{ file: <contents>, sys_id: <step sys_id> }` -- `packages/core/src/snClient.ts:355-362`. Called internally by `updateRecord()` whenever the target table is `sys_atf_step`.

---

## Dovetail Promote (`/api/cadso/dovetail_promote`)

### `POST /promote` 🟡 client-contract-only

Cross-instance update-set promotion, used by the separate `dovetail-sawmill` package, not the core client.

- **Client:** `packages/sawmill/src/client.ts:9` (`PROMOTE_PATH`)
- Request/response shapes are defined in `packages/sawmill/src/types.ts` (`PromoteRequest`/`PromoteResponse`) -- see that package's own README for the retrieve/preview/commit workflow this endpoint sits inside.

---

## Deprecated: Sincronia (`/api/sinc/sincronia/*`)

**Dead. Zero live callers.** Per `docs/dovetail-servicenow-migration.md` (verified 2026-07-02): "the current client calls none of its operations." The rebrand originally planned to rename this path to `/api/sinc/dovetail/`; that never happened -- the sync ops moved to `/api/cadso/dovetail_sync/` instead, and Sincronia is slated for full removal (decommission checklist in that same doc). Its source under `servicenow/sys_ws_operation/` (`bulkDownload.js`, `getAppList.js`, `getCurrentScope.js`, `getManifest.js`, `pushATFfile.js`) and `sys_script_include/SincUtils*.js` will be deleted once the instance-side def is confirmed gone. **Do not treat this source as documenting current Dovetail Sync behavior** -- it's retained only pending decommission.

---

## Edge cases (from the story's acceptance criteria)

**Cross-scope `createRecord` (body `sys_scope` handling):** confirmed, but more precisely than "the server ignores it" -- Dovetail's own client never sends `sys_scope` in the create body in the first place (`buildCreateFields()` strips it, conveying scope via the separate `scope` param instead). Whether the server-side handler would _also_ ignore an explicitly-sent `sys_scope` from a non-Dovetail caller is unverified -- no server script for this op is in this repo. Documented above under `/createRecord` with that precise scoping, not asserted as fully verified.

**Studio vs. shop instance behavior differences:** none found. No code branching on instance name/hostname exists in `packages/servicenow/src` or `packages/core/src`. "Studio → shop → prod" in this repo's docs refers to the promotion ladder order (e.g. the Sincronia decommission checklist), not a behavioral difference in the API itself -- the same definitions are deployed identically to each instance.

## Top manual-pain gaps

The one gap with real, sourced evidence in this repo: **roughly half of the live operations (`createRecord`, `deleteRecord`, `changeScope`, `changeUpdateSet`, `currentUpdateSet`, `createUpdateSet`, and all four Sync ops) have no server-side handler script checked into version control** -- `servicenow/dovetail/README.md` has an open TODO naming this exact gap. Anyone needing to verify or modify server-side behavior for these today has to export live XML from an instance rather than read source in this repo. This catalog documents their client contracts precisely; closing the underlying gap (capturing the server scripts, per the README's TODO) is separate follow-up work, not something this catalog can substitute for.

I have no access to support history, Slack, or PR comments, so I'm not asserting other "top pain points" beyond what's directly evidenced in source (this gap, the `sys_db_object` create-guard, and `createUpdateSet`'s silent mis-scoping fallback -- all three documented above at their respective operations).
