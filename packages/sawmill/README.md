# @tenonhq/dovetail-sawmill

Cross-instance **update-set promotion** client for Dovetail. A thin, typed wrapper around the Dovetail Promote Scripted REST API (`POST /api/cadso/dovetail_promote/promote`) that retrieves, previews, and (optionally) commits an update set from a **source** ServiceNow instance onto a **target** instance.

> Library only — **no CLI, no MCP tool**. Import it from Node tooling that promotes update sets between Tenon instances (e.g. dev → shared → prod).

## Install

```bash
npm i @tenonhq/dovetail-sawmill
```

## Usage

```js
const { createSawmillApi, SawmillApiError } = require("@tenonhq/dovetail-sawmill");

// `config` points at the TARGET instance (where the update set is retrieved + previewed/committed).
const api = createSawmillApi({
  instance: "tenonworkshop",            // bare subdomain, host, or full URL — all accepted
  username: process.env.SN_USER,
  password: process.env.SN_PASSWORD
});

const result = await api.promote({
  sourceInstance: "tenonworkstudio",    // instance the update set is pulled FROM
  updateSetName: "DEV-225 consent v2",
  commit: false,                        // false = retrieve + preview only; true = also commit
  skipPreviewErrors: []                 // optional: preview-error types to ignore on commit
});

// result: { remoteUpdateSetSysId, previewErrors[], committed, elapsedMs }
if (result.previewErrors.length) {
  // inspect { type, message, targetTable, targetName, sysId } before committing
}
```

## API

### `createSawmillApi(config) → SawmillApi`
- **config** `{ instance, username, password }` (all required).
- `instance` accepts a bare subdomain (`"x"` → `https://x.service-now.com`), a host (`"x.service-now.com"`), or a full URL — never double-suffixed.
- Returns `{ instance, promote(req) }`.

### `promote(req) → Promise<PromoteResponse>`
| Field | Type | Notes |
|---|---|---|
| `req.sourceInstance` | string | **required** — instance to retrieve the update set from |
| `req.updateSetName` | string | **required** — name of the update set to promote |
| `req.commit` | boolean | `false` = retrieve + preview only; `true` = commit after preview |
| `req.skipPreviewErrors` | string[] | optional preview-error types to ignore |

`PromoteResponse`: `{ remoteUpdateSetSysId, previewErrors: PreviewError[], committed, elapsedMs }`.
`PreviewError`: `{ type, message, targetTable?, targetName?, sysId? }`.

## Behavior

- **Rate limited** to 20 requests/sec (`axios-rate-limit`).
- **Retries** (max 3, exponential backoff): `429` honors `Retry-After`; `5xx` is retried **only when `commit` is false** — commits are non-idempotent and are never retried on a server error.
- **`401`/`403`** throw `SawmillApiError` immediately (no retry).
- All non-2xx responses throw `SawmillApiError` carrying `{ status, body, message }`.

## Source

`src/client.ts` (client + retry/backoff), `src/types.ts` (request/response shapes). Server endpoint: `/api/cadso/dovetail_promote/promote`.
