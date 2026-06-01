# ServiceNow-side Source (Dovetail server)

Source for the ServiceNow records that back Dovetail's two Scripted REST APIs.
`@tenonhq/dovetail-core` calls into both. These records aren't synced via Dovetail
itself because `dove.config.js` doesn't include their scope — this directory is the
source of truth.

| API | Path | Backed by | Source here |
|---|---|---|---|
| **Dovetail** | `/api/cadso/dovetail/*` (legacy `/api/cadso/claude/*`) | 1 WSD + 6 self-contained operations | [`dovetail-api/`](dovetail-api/) |
| **Sincronia** | `/api/sinc/sincronia/*` | 1 WSD + 5 operations + `SincUtils`/`SincUtilsMS` | [`sys_ws_operation/`](sys_ws_operation/) + [`sys_script_include/`](sys_script_include/) |

> **Canonical home:** both APIs are being consolidated into the **Dovetail** global-type
> scoped application (`sys_app 5f33b5d433d90b147b18bc534d5c7bf6`), gated on the
> `dovetail_user` role. The [`bootstrap/`](bootstrap/) one-shot stands the whole thing
> up in that app on any instance. On `tenonworkstudio` today the records still sit loose
> in `global` / the "Include in Update Set" pseudo-scope under `snc_internal_role` —
> that's the legacy state the bootstrap supersedes.

## Layout

```
servicenow/
├── bootstrap/                One-shot Fix Script that stands up BOTH APIs in the
│   ├── dovetail-server-bootstrap.fix.js   Dovetail app, gated on dovetail_user
│   ├── generate-bootstrap.js              Regenerator (edit source, not the fix script)
│   └── README.md
├── dovetail-api/             Recovered source for the Dovetail (cadso) API
│   ├── WSD_Dovetail.json
│   └── sys_ws_operation/     changeScope, currentUpdateSet, changeUpdateSet,
│                             pushWithUpdateSet, createRecord, deleteRecord
├── sys_script_include/
│   ├── SincUtils.js          global.SincUtils — entry-point class
│   └── SincUtilsMS.js        global.SincUtilsMS — base class with all logic
├── sys_ws_operation/         Sincronia (sinc) API operation scripts
│   ├── getAppList.js         GET  /api/sinc/sincronia/getAppList
│   ├── getCurrentScope.js    GET  /api/sinc/sincronia/getCurrentScope
│   ├── getManifest.js        POST /api/sinc/sincronia/getManifest/{scope}
│   ├── bulkDownload.js       POST /api/sinc/sincronia/bulkDownload
│   └── pushATFfile.js        POST /api/sinc/sincronia/pushATFfile
└── scripts/
    └── deploy.js             push local source → ServiceNow instance (by sys_id)
```

## Web Service Definitions

| WSD | sys_id | namespace / service_id |
|---|---|---|
| **Dovetail** | `b8a9db8d33d7a6107b18bc534d5c7b7b` | `cadso` / `dovetail` |
| **Sincronia** | `afaa2facc30cc710d4ddf1db050131b0` | `sinc` / `sincronia` |

The Sincronia WSD shadows the upstream NuvolaTech `x_nuvo_sinc` REST API at the same URL
(only one `sys_ws_definition` can claim a given `namespace/service_id` pair), so any client
hitting `/api/sinc/sincronia/...` reaches this Tenon-owned implementation regardless of
which app is installed. **The `sinc` namespace must be free on a target instance** — if
`x_nuvo_sinc` is installed there, it collides.

## Standing this up on a new instance

Use the one-shot — it honors "create in scope, update set open first" and hard-aborts if
run anywhere but the Dovetail app with an active update set. See
[`bootstrap/README.md`](bootstrap/README.md).

## Deploying script edits to an existing install

```sh
node scripts/deploy.js              # push all files
node scripts/deploy.js --dry-run    # show diff without writing
node scripts/deploy.js SincUtilsMS  # push a specific record
```

Set `SN_INSTANCE`, `SN_USER`, `SN_PASSWORD` in env or `.env` (same as the ServiceNow repo).
`deploy.js` pushes script bodies into existing records by sys_id; it does not create records
or switch update sets. For a from-scratch instance, use the bootstrap instead.

## History

The Sincronia records started life on NuvolaTech's `x_nuvo_sinc` plugin; Tenon ported them
to global scope on 2026-04-01 to own the API surface. The Dovetail (cadso) API was exported
ad-hoc to `Downloads/` and never checked in — its source was recovered from `tenonworkstudio`
into [`dovetail-api/`](dovetail-api/) on 2026-06-01. This directory is the canonical source
going forward.
