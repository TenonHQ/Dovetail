# Dovetail Server Bootstrap (one-shot)

Stands up Dovetail's entire server-side footprint inside the **Dovetail** scoped
application on any ServiceNow instance, gated on the `dovetail_user` role.

## What it creates (15 records + 1 role)

| Records | Detail |
|---|---|
| `dovetail_user` role | `db33f5d433d90b147b18bc534d5c7b06` (created if missing) |
| WSD **Dovetail** + 6 ops | `/api/cadso/dovetail/*` — changeScope, currentUpdateSet, changeUpdateSet, pushWithUpdateSet, createRecord, deleteRecord |
| WSD **Sincronia** + 5 ops | `/api/sinc/sincronia/*` — getAppList, getCurrentScope, getManifest, bulkDownload, pushATFfile |
| Script includes ×2 | `global.SincUtils`, `global.SincUtilsMS` |

All records keep their original sys_ids, so the `dove` client manifest needs no remap.
Because the Dovetail app is a global-type app, the `cadso`/`sinc` namespaces and the
API paths are preserved.

## Auth model

`dovetail_user` is **required**. Each operation:
- `requires_authentication = true`
- `requires_snc_internal_role = false` (snc_internal_role no longer needed)
- a `dovetail_user` gate injected at the top of every operation script (403 otherwise; `admin` bypasses)

Grant `dovetail_user` to the integration user the `dove` CLI authenticates as.

## How to run (honors "create in scope, update set open first")

1. **Studio → open the Dovetail app** (`sys_app 5f33b5d433d90b147b18bc534d5c7bf6`).
2. **Create + activate a NEW update set** while Dovetail is the current application.
   The update set is Dovetail-scoped from birth — never create it first and switch scope after.
3. **Create a Fix Script** inside the Dovetail app, paste
   [`dovetail-server-bootstrap.fix.js`](dovetail-server-bootstrap.fix.js), and **Run**.

The script **hard-aborts** unless it is running in the Dovetail scope with an active,
in-progress, non-Default update set — so it physically cannot land records in the wrong
place. It is **idempotent**: re-running updates the records in place.

## Verify

```bash
curl -u USER:PASS 'https://<instance>/api/cadso/dovetail/currentUpdateSet'   # -> 200
curl -u USER:PASS 'https://<instance>/api/sinc/sincronia/getCurrentScope'    # -> 200
npx dove status
```

## Regenerating

The Fix Script is generated, not hand-edited. To rebuild it from the recovered source:

```bash
node generate-bootstrap.js
```

It reads the recovered Dovetail-API operation scripts from `../dovetail-api/` and the
Sincronia script-includes from `../sys_script_include/`, injects the `dovetail_user`
gate, and embeds everything into the single Fix Script. Edit source there, not the
generated file.
