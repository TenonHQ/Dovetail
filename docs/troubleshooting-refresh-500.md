# Troubleshooting `npx dove refresh` 500 Errors

> When `npx dove refresh` fails on some scopes but not others with `Request failed with status code 500` and nothing useful in the debug log — start here.

---

## Resolution (2026-04-14)

Both of the issues described below were fixed on branch `fix/sincronia-refresh-500-diagnostics`:

1. **Error-logging blindness** — `unwrapSNResponse` now dumps the full Axios response surface (status, URL, ServiceNow error body, headers, scope) to `dovetail-debug-*.log` on every failed REST call. Every future 500 anywhere in Sincronia is now diagnosable in one pass.
2. **Actual root cause** — turned out to be `POST api/sinc/sincronia/bulkDownload`, **not** `/getManifest`. ServiceNow rejects REST payloads over 10 MB, and the `refresh` code path called `getMissingFiles` in one shot. The `watch` path in `allScopesCommands.ts` already chunked by 5 tables; `processMissingFiles` in `appUtils.ts` now does the same. All 15 scopes on `tenonworkstudio` refresh successfully post-fix.

The original investigation narrative below is preserved because the methodology — **fix the observability before guessing at root cause** — was correct even though the initial hypothesis about which endpoint was failing was wrong.

---

## Symptom

Running `npx dove refresh` from the `ServiceNow/` directory, some scopes complete and others fail:

```
Refreshing scope: x_cadso_automate...
Error from tenonworkstudio.service-now.com: Request failed with status code 500
Refresh failed: Request failed with status code 500
Refreshing scope: x_cadso_click...
x_cadso_click ======================================== 463/463 (100%)
Refreshing scope: x_cadso_cloud...
x_cadso_cloud ======================================== 203/203 (100%)
...
```

The `dovetail-debug-*.log` file is created but contains no detail about the 500 — no response body, no status code context, no server-side error message.

---

## Diagnosis

The error message is useless because Sincronia's generic error wrapper throws away the interesting data.

**Location:** `Sincronia/packages/core/src/snClient.ts:524-530`

```ts
} catch (e) {
  let message;
  if (e instanceof Error) message = e.message;
  else message = String(e);
  const instance = process.env.SN_INSTANCE || "unknown";
  logger.error("Error from " + instance + ": " + message);
  throw e;
}
```

When a ServiceNow REST call 500s, Axios throws an `AxiosError` with:

- `e.response.status` — HTTP status code
- `e.response.statusText` — HTTP reason phrase
- `e.response.data` — the server-side error body (usually `{error: {message, detail}, status}`)
- `e.response.headers` — response headers
- `e.config.url`, `e.config.method` — which request failed
- `e.message` — only ever says `"Request failed with status code 500"`

The wrapper logs **only `e.message`**. The actual ServiceNow error — including any server-side script stack trace, the REST response code, and the human-readable `detail` — is silently discarded.

### Why some scopes work and others don't

The fact that 5 of 9 scopes refresh successfully rules out:

- ❌ Authentication / credentials
- ❌ Network / TLS / DNS
- ❌ Instance availability
- ❌ The scripted REST API being broken globally
- ❌ Sincronia client bugs in request construction

It narrows the problem to **something scope-specific**. Likely causes, in order of probability:

1. **Server-side script error** — the `/api/sinc/sincronia/getManifest/{scope}` scripted REST resource throws on certain scopes' data shape (e.g., a null field, an unexpected record, an undeclared scope reference).
2. **ACL / read access** — the runtime user can't read a cross-scope table referenced by those scopes' config.
3. **Missing scope or table on the instance** — the failing scope doesn't exist on `tenonworkstudio`, or a table listed in `_scopes.<scope>._tables` doesn't exist.
4. **Config payload shape** — `includes`/`excludes`/`tableOptions` for those scopes produce a payload the server rejects.

Without the response body, we cannot tell which.

### Request flow (for reference)

- Command: `Sincronia/packages/core/src/commands.ts` → `refreshCommand()` → `AppUtils.syncManifest()`
- Per-scope call: `snClient.getManifest(scope, config)` at `snClient.ts:343-370`
- Endpoint: `POST api/sinc/sincronia/getManifest/{scope}`
- Payload: `{includes, excludes, tableOptions, withFiles, getContents}`
- **This is NOT the `Claude` scripted REST API** (`/api/cadso/claude/`). It is a separate scripted REST resource named `sinc` in the global scope. The source is not currently mirrored to the Sincronia repo — inspect it on the instance under **System Web Services → Scripted REST APIs** at base path `/api/sinc/sincronia`.

---

## Remediation

### Step 1 — Enhance `unwrapSNResponse` error logging

**File:** `Sincronia/packages/core/src/snClient.ts` (lines 503-532)

Replace the `catch (e)` block to capture and log the full Axios error surface. The short user-facing line stays; full diagnostic detail goes to the debug log file.

Required behaviour:

- Detect Axios errors via `e.isAxiosError` or `e.response` presence (duck-type; do not add an import that isn't already there).
- User-facing `logger.error` line includes: instance, HTTP status, request URL, and if available `e.response.data.error.message`.
- `fileLogger.debug` dumps:
  - `method` + `url`
  - `status` + `statusText`
  - Full `response.data` pretty-printed as JSON
  - `response.headers`
  - If the URL matches `getManifest`, extract the scope from the URL path for easy grepping.
- Still `throw e` at the end — callers depend on that.

This change is scoped to one function and improves diagnostics for **every** Sincronia REST call, not just `refresh`.

### Step 2 — Rebuild the package

```bash
cd Craftsman/Sincronia
npx lerna run build --scope=@tenonhq/dovetail-core
```

Confirm `npx dove` in `ServiceNow/` resolves to the local build:

```bash
cd Craftsman/ServiceNow
which dove
ls -la node_modules/@tenonhq/dovetail-core
```

If `node_modules/@tenonhq/sincronia-core` does not symlink back to the monorepo package, either `npm link` it or invoke the CLI entry script directly from `Sincronia/packages/core/build/...` for the test.

### Step 3 — Reproduce with debug logging

```bash
cd Craftsman/ServiceNow
npx dove refresh --logLevel debug
```

> Verify the exact flag casing — `Sinc.SharedCmdArgs.logLevel` is camelCase internally, but the CLI may accept `--logLevel` or `--loglevel`. Check `Sincronia/packages/core/src/commander.ts`.

Then open the newest `dovetail-debug-*.log` and search for the failing scopes. Each 500 now has a block with the ServiceNow `{error: {message, detail}, status}` payload.

### Step 4 — Map the error to a root cause

Match what the log shows against these patterns:

| Error pattern in `response.data` | Likely cause | Where to fix |
|---|---|---|
| Stack trace / `TypeError: Cannot read property X of null` | Server-side script error in sinc REST resource | ServiceNow instance → System Web Services → Scripted REST APIs → `sinc` |
| `User Not Authorized` / `read access denied on table X` | Missing ACL or scope access | Grant role or correct `dove.config.js` reference |
| `Invalid table` / `No such scope` | Table or scope doesn't exist on this instance | `dove.config.js` — remove/fix the reference |
| `Invalid JSON` / unexpected payload keys | Payload shape mismatch | `snClient.ts:343-370` or server-side parsing |

### Step 5 — Cross-reference `dove.config.js`

Compare the `_scopes.<scope>` entries for the 4 failing scopes (`x_cadso_automate`, `x_cadso_email_spok`, `x_cadso_guide`, `x_cadso_journey`) against the 5 succeeding scopes. Look for:

- Tables added to `_scopes.<scope>._tables` that don't exist on `tenonworkstudio`
- Field-type overrides that point to fields missing on the scope's tables
- Recently added entries — `git log -p dove.config.js` for the last few commits that touched scope config

`Sincronia/CLAUDE.md` documents `dove.config.js` as the single source of truth — there are no hidden defaults — so any delta here is a prime suspect.

### Step 6 — Apply the fix

Branch by what Step 4 revealed:

- **Server-side script bug** — fix the scripted REST resource on the instance, export it, and commit the XML so this can't regress unseen.
- **ACL / missing table / missing scope** — correct `dove.config.js`, or grant access, or create the missing scope on the instance.
- **Payload shape** — adjust `getManifest` request construction or server-side parsing.

### Step 7 — Verify

```bash
cd Craftsman/ServiceNow
npx dove refresh
```

Expect all scopes to complete 100%. If any still fail, the enhanced log now tells you exactly why.

---

## Files of interest

| File | Purpose |
|---|---|
| `Sincronia/packages/core/src/snClient.ts:503-532` | `unwrapSNResponse` — the error handler to fix |
| `Sincronia/packages/core/src/snClient.ts:343-370` | `getManifest` — endpoint + payload shape |
| `Sincronia/packages/core/src/FileLogger.ts` | File logger (`debug()` already available) |
| `Sincronia/packages/core/src/commands.ts:22-36` | `refreshCommand` entry point |
| `ServiceNow/dove.config.js` | Per-scope config — review for failing scopes |
| ServiceNow instance: `/api/sinc/sincronia/getManifest` | Server-side scripted REST resource |

## Out of scope

- Broad refactor of Sincronia logging or error handling beyond this one wrapper.
- Changing `refresh` semantics (continue-on-failure per scope is fine).
- Folding the `sinc` scripted REST API into the `Claude` API.
- Retry / backoff logic on 500s — fix the root cause first.

---

*Last updated: 2026-04-14 — fix landed on `fix/sincronia-refresh-500-diagnostics`. Root cause was `bulkDownload` payload-size cap (10 MB), not `getManifest`. Chunking applied in `processMissingFiles` (`appUtils.ts`).*
