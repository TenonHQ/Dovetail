# @tenonhq/dovetail-deploy

ClickUp-status-driven **ServiceNow update-set promotion** orchestrator for Dovetail.

When a ClickUp task moves to a promotion status (`push to yard`, `push to mill`, `push to shop`,
`pull to demo 7`, …), this package resolves the update set(s) that belong to that task's `DEV-` id on
the **source** instance and promotes each to the **target** instance — **preview-gated, idempotent, and
stop-on-failure**. A status change is the sole trigger; there is no PR or branch in the loop.

> **Pure orchestration.** Transport stays in [`@tenonhq/dovetail-sawmill`](../sawmill). This package
> depends only on small **ports** (`SnReader`, `Promoter`, `Commenter`) so it is unit-testable with plain
> fakes; the real `@tenonhq/dovetail-{servicenow,sawmill,clickup}` clients are adapted to those ports at
> the call site (the GitHub Action entry).

## API

```ts
import {
  promoteForStatus,
  resolveUpdateSets,
  validatePromotionLadder,
  formatFailureReport,
} from "@tenonhq/dovetail-deploy";
```

### `promoteForStatus({ status, taskId, config, sourceReader, targetReader, promoter, commenter? })`

Resolve → per set: idempotency check (target) → `promote({commit:false})` (preview) → gate on
zero/allowlisted preview errors → `promote({commit:true})` → confirmation comment. Returns a typed
`PromoteForStatusResult`: `promoted` | `skipped` | `no-update-sets` | `ambiguous` | `preview-blocked` |
`failed` | `invalid-task-id`. Any set's failure stops the run and does **not** advance the task.

### `resolveUpdateSets({ reader, taskId, config, state? })`

Returns an **ordered array** of `{ sysId, name, scope }` — multi-set per task is the norm (one complete
`sys_update_set` per scope). Matches the name on `^<taskId>\b` (so `DEV-847` ≠ `DEV-8470`). A same-scope
name collision is the only "ambiguous" case; it never guesses.

### `validatePromotionLadder({ config, branchTaskIdPattern? })`

The authoritative **shape + semantic** check for the `promotion` block of `automation-config.json`
(the Craftsman CI guard imports this). Asserts: valid `taskIdPattern` (and equality with the branch
layer), instance references exist, `transport` in enum, `clickupStatusId` present + unique, and **no
enabled rung points at a disabled / url-less instance**. Returns `ValidationIssue[]` (empty = valid).

## Wiring the ports (at the call site)

```ts
import { createClient } from "@tenonhq/dovetail-servicenow";
import { createSawmillApi } from "@tenonhq/dovetail-sawmill";
import { addComment } from "@tenonhq/dovetail-clickup";

const sourceReader = { query: (p) => createClient(sourceCfg).table.query(p.table, p.query, { fields: p.fields, limit: p.limit }) };
const targetReader = { query: (p) => createClient(targetCfg).table.query(p.table, p.query, { fields: p.fields, limit: p.limit }) };
const promoter = createSawmillApi(targetCfg); // its .promote matches the Promoter port
const commenter = { postComment: (p) => addComment({ /* clickup cfg */, taskId: p.taskId, comment: p.text }) };
```

## Notes

- `config/promotion.schema.json` is a **structural** JSON Schema companion (for editors/tooling); the
  semantic checks live in `validatePromotionLadder`, which is authoritative.
- ES6/TypeScript, `strict`, no `any`, single-object parameters.
