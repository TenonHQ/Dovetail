# RFC: ServiceNow Schema-Side CRUD for Dovetail

> **Status:** Draft / Proposed — design for hand-off; build not yet scheduled.
> **Purpose:** Bring Dovetail's _schema_ control of a ServiceNow instance (tables, fields, choices) up to parity with its _code/record_ control, behind one coherent CRUD surface that packages every change into an update set and hands cross-instance promotion to the deploy layer.
> **Audience:** A developer who will build this without further design input, plus reviewers of the surface and the destructive-ops policy.
> **Scope of v1:** `sys_db_object` (tables), `sys_dictionary` (fields), `sys_choice` (choices). **Out of v1** (deferred follow-ons, not designed here): views (`sys_ui_view`), ACLs (`sys_security_acl`), relationships (`sys_relationship`), dictionary overrides (`sys_dictionary_override`).
> **Last updated:** 2026-06-16

---

## 1. Problem

Dovetail gives a Claude Code session robust **code-side** control of a ServiceNow instance: `dove push`/`refresh`/`reconcile` move scripts and records between a branch and an instance, and the record write path (`createRecord`, `pushWithUpdateSet`) is update-set-aware and scope-correct.

The **schema side** is uneven. Some pieces ship and are excellent; others are missing or only reachable as a side effect of an adjacent operation:

- Faithful **table create** ships (`dove-sn create-table`), validated live.
- Schema **reads** ship (`dove schema pull|diff|snapshots` + the read MCP).
- **Choice** upsert ships (`dove-sn add-choices`).
- Packaging existing schema into an update set ships (the `pushWithUpdateSet` path + the capture lifecycle).

But there is **no unified, code-side-parity CRUD surface** for the schema model. The conspicuous gap is **adding a field to an existing table** — there is no verb for it, and the obvious REST shortcut is a platform trap (see §4). UPDATE of field/table attributes has no first-class verb, and DELETE is uniformly unavailable headless.

This RFC designs that surface, states per capability whether it is **already-covered / extend-existing / build-new**, bakes in a context-gated rule for destructive operations, and defines a clean, decoupled seam to the cross-instance promotion layer.

---

## 2. Capability matrix (verified against this repo)

Status legend: **Ships** (works today) · **Partial** (reachable but not a first-class verb, or incomplete) · **Missing**.

| Object                        | CREATE                                                                                                                                                                  | READ                                                                                              | UPDATE                                                                                                                                                       | DELETE                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Table** `sys_db_object`     | **Ships** — `dove-sn create-table` / MCP `create_table`; form-replay (`packages/servicenow/src/table/createTable.ts`), validated live 2026-06-13 (`createTable.ts:20`)  | **Ships** — `dove schema pull\|diff\|snapshots` (`packages/core/src/commander.ts:482`) + read MCP | **Missing** — no verb for table attributes (label, access flags, `super_class`)                                                                              | **Missing / platform-gated** — drop is ACL-blocked headless                                                          |
| **Field** `sys_dictionary`    | **Missing** ⭐ — no add-column-to-existing-table; a REST/`createRecord` insert adopts session scope and won't materialise the physical column (§4.2)                    | **Ships** — `dove schema` + read MCP                                                              | **Partial** — `pushWithUpdateSet` patches a dict row today (`packages/servicenow/src/choices.ts:191`), `read_only` lock exists; no unified field-update verb | **Partial / platform-gated** — headless column drop is ACL-blocked; the change can be _captured_ after a manual drop |
| **Choice** `sys_choice`       | **Ships** — `dove-sn add-choices` / MCP `add_choices_to_field`; idempotent upsert, update-set-aware (`packages/servicenow/src/choices.ts:166`)                          | **Ships** — read MCP + schema                                                                     | **Ships** — `add-choices` upserts label/sequence/inactive                                                                                                    | **Missing** — upsert-only; no remove/deactivate                                                                      |
| **Packaging** (cross-cutting) | `pushWithUpdateSet` (`packages/core/src/snClient.ts:615`) routes a write into a named, scope-correct update set; the create-table lifecycle pins + captures → **Ships** | —                                                                                                 | —                                                                                                                                                            | —                                                                                                                    |

**Reads are fully covered.** The gaps cluster in **CREATE (fields)**, **UPDATE (fields/tables)**, and **DELETE (uniform — a ServiceNow ACL ceiling, not a Dovetail gap)**.

### 2.1 Build verdict per capability

| Verdict                                                               | Capabilities                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **already-covered** (absorb into the unified surface; do not rebuild) | table CREATE; all READs; choice CREATE/UPDATE; update-set packaging; the promotion _consumer_ (`@tenonhq/dovetail-sawmill`)                                                                                                                    |
| **extend-existing** (generalise a primitive that already exists)      | field UPDATE (generalise the `sys_dictionary` patch already used by `addChoicesToField` + the `read_only` lock); choice soft-DELETE (`inactive=true` via `pushWithUpdateSet`); field DELETE _capture_ (capture-after-manual-drop)              |
| **build-new**                                                         | **field CREATE** ⭐ (extend the `createTable` form-replay to an existing table; **spike-gated**, §6); table UPDATE; table/field hard-DELETE (context-gated + platform-step handoff, §7); execution-context detection (none exists today, §7.2) |

---

## 3. Goals / non-goals

**Goals**

- One coherent CRUD model over tables, fields, choices — reachable as CLI verbs, MCP tools, and a single skill — with the same scope-correctness and update-set discipline the record path already has.
- Every mutation lands in **one named, scope-correct update set** with its `sys_update_xml` rows asserted present — the artifact the promotion layer consumes.
- A safe, **context-aware** destructive-ops policy.

**Non-goals**

- Cross-instance promotion itself (owned by the deploy layer; this RFC defines only the seam — §8).
- The deferred objects in the header (views/ACLs/relationships/overrides).
- Any REST transport that the platform does not bless (§4) — we do not design around platform limits with a broken shortcut.

---

## 4. Hard platform constraints (load-bearing design inputs)

These are ServiceNow platform truths, each already encoded in this repo's source. The design **confronts** them; it does not route around them.

### 4.1 A faithful table/column write is a form save, not a REST insert

A REST (or `createRecord`) insert into `sys_db_object` produces only a metadata row — **no physical table, no ACLs, no scope wiring** ("orphaned table"). The faithful path is the one the Studio UI drives: a single `POST /sys_db_object.do` whose body embeds every column as a **list-edit XML blob**. Documented in `packages/servicenow/src/table/createTable.ts:1` and enforced by a guard that refuses a bare `sys_db_object` insert:

```
// packages/core/src/snClient.ts:646
// Guard: a bare record insert into sys_db_object creates only an orphaned …
if (params && params.table === "sys_db_object") {
  throw … "Refusing to insert sys_db_object via createRecord: a bare insert …"
}
```

The same mechanism creates **columns**: they ride a list-edit transaction against the `sys_db_object → sys_dictionary` related list, folded into the form POST (`createTable.ts:4`). This is the basis for the field-CREATE design (§6).

### 4.2 Scoped writes must go through Dovetail's scope-switching path

A direct Table-API insert adopts the **API user's current session scope**, not a body field — `sys_scope` in the body is silently ignored, so a cross-scope column is renamed with the wrong prefix. Scoped writes therefore go through `createRecord`/`pushWithUpdateSet`, which switch scope + update set server-side (`packages/core/src/snClient.ts:631`, `:615`). The session app governs scope, **not** a field (`createTable.ts:12`).

### 4.3 The update-set lifecycle and scope rules

Create in the **target scope from the start** — never create in global and re-parent (cross-scope moves are business-rule-blocked). The lifecycle is: create-in-scope → `dove refresh -s <scope>` → capture → `dove push`. The active update set is **not** a body field; it is pinned via the form session's `sys_update_set` user preference, after which the resulting `sys_update_xml` rows must be **asserted** present in the intended set. (`createTable.ts` step 1b + the capture lifecycle.)

### 4.4 `dove reconcile` does not apply schema

Reconcile classifies and (with `--apply`) applies **record** create/update/delete, but **"Schema stays report-only (a SN ceiling)"** (`packages/core/src/reconcileCommand.ts:15`). Schema apply is a different mechanism (form-replay + capture). Reconcile owns records; this capability owns schema. They do not merge (see Alternatives, §9.2).

### 4.5 DELETE of a column/table is ACL-blocked headless

Dropping a `sys_dictionary` column or a `sys_db_object` table is blocked by ServiceNow ACL when attempted through the REST/Scripted-REST path; the physical drop is a UI/admin operation. `element` (a column's name) is immutable, so a "rename" is a delete+recreate. Consequence: the DELETE verbs cannot _perform_ the platform drop headlessly — they **capture the intent and emit the manual step** (§7.3), then capture the result into the update set.

---

## 5. Proposed surface

### 5.1 Where the verbs live (extend, don't fork)

The schema **write** primitives already live in `@tenonhq/dovetail-servicenow` (the form-login replay engine, `create-table`, `add-choices`, the layout setters) and the scope-correct write client lives in `@tenonhq/dovetail-core` (`pushWithUpdateSet`, `createRecord`). The new verbs **extend `@tenonhq/dovetail-servicenow`** and surface under the existing **`dove-sn`** CLI. We do **not** create a new package (§9.3).

Schema **reads** stay under core's existing `dove schema pull|diff|snapshots` — core cannot depend on `dovetail-servicenow` (layering), so reads and writes are physically split by package boundary. The **unification is at the skill + docs layer**, which presents one CRUD model over both.

### 5.2 The triad: CLI verb + MCP tool + skill

Each capability ships as the project's standard triad, matching how `create-table`/`add-choices` already ship:

| Object · verb          | New `dove-sn` CLI verb | New MCP tool (on `packages/servicenow/src/mcp/registry.ts`) | mcp-kit annotation            |
| ---------------------- | ---------------------- | ----------------------------------------------------------- | ----------------------------- |
| Field · CREATE         | `add-field`            | `add_field_to_table`                                        | `WRITE_CREATE`                |
| Field · UPDATE         | `set-field`            | `set_field`                                                 | `WRITE_OVERWRITE`             |
| Field · DELETE         | `remove-field`         | `remove_field`                                              | `WRITE_DESTRUCTIVE` (new; §7) |
| Table · UPDATE         | `set-table`            | `set_table`                                                 | `WRITE_OVERWRITE`             |
| Table · DELETE         | `remove-table`         | `remove_table`                                              | `WRITE_DESTRUCTIVE`           |
| Choice · DELETE (soft) | `remove-choices`       | `remove_choices_from_field`                                 | `WRITE_OVERWRITE`             |

(Existing, reused as-is: `create-table`/`create_table`, `add-choices`/`add_choices_to_field`. Existing annotation vocabulary — `READ_ONLY`, `WRITE_CREATE`, `WRITE_OVERWRITE`, `WRITE_ADDITIVE_IDEMPOTENT`, `WRITE_EXECUTE` — is the gating taxonomy these slot into; `WRITE_DESTRUCTIVE` is the one new tier, §7.)

One umbrella skill — **`/sn-schema`** — exposes the full CRUD model over tables/fields/choices, calling the `dove-sn` verbs for writes and `dove schema` for reads, and is the agent-facing entry point.

### 5.3 Write discipline: two-phase, scope-correct, asserted

Every write verb follows the pattern the repo already uses (`create_table`'s `dryRun`, the skills' two-phase confirm):

1. **dry-run / plan** — resolve scope + target update set, render the exact change (and for form-replay, the column XML) with **no session and no writes**.
2. **confirm** — explicit, gated by execution context (§7).
3. **write** — through the scope-switching path, pinned to the named update set.
4. **verify** — read back and **assert** the `sys_update_xml` rows landed in the intended set (never trust the write's 200 alone).

---

## 6. Field CREATE — the marquee build (spike-gated)

Adding a column to an **existing** table is the central missing capability. The design **extends the `createTable` form-replay**, because the platform creates a column the same way whether the table is new or existing — a list-edit `<record operation="add">` against the `sys_db_object → sys_dictionary` related list (§4.1).

**Why this is _more_ tractable than table-create, not less:** `createTable` notes that a _new-record_ form "doesn't render related lists to harvest one from," so it rides a **constant** "Table Columns" relId (`createTable.ts:17`). For an **existing** table, the form **does** render the dictionary related list — so the relId and the form session are harvestable directly from the table's own form, removing the one hardcoded constant.

**Why not a `createRecord` insert into `sys_dictionary`:** it adopts session scope (§4.2) and, more fundamentally, a bare metadata insert does not trigger the physical column add — the same class of failure the `sys_db_object` guard exists to prevent.

**Spike gate (Story S0).** Before declaring this shipped, capture a single column-add against an existing table in Studio, confirm the list-edit request shape, and prove a headless replay lands the **physical** column plus pinned `sys_update_xml`. This mirrors exactly how table-create was de-risked. **Fallback if not replayable:** field-CREATE degrades to the same capture-intent + manual-step handoff as DELETE (§7.3), and this RFC's "full parity" claim is explicitly qualified to _"create via faithful replay where the platform permits; capture + manual step where it does not."_

---

## 7. Destructive operations — context-gated by design

Destructive schema ops (drop table, drop column, remove choice) are gated on **how the capability was invoked**.

### 7.1 The rule

- **Local / interactive session →** deletes are **confirm-only**: two-phase, show the dry-run plan, write only on explicit confirmation.
- **Automation pipeline (CI) →** a delete is allowed **only if it arrived through a merged pull request.** An unattended run may not originate a destructive schema change.

### 7.2 Detecting context (build-new)

The repo has **no** execution-context detection today — only an explicit `--ci` flag on a couple of commands (`packages/core/src/createRecordCommand.ts:20`, `deleteRecordCommand.ts:18`). So detection is net-new:

- Auto-detect the CI environment via the standard CI environment signal (e.g. the `GITHUB_ACTIONS` variable), with an explicit `--context=local|automation` override for the rare case where auto-detection is wrong.
- In the **automation** branch, additionally require a **merged-PR signal** (the workflow passes the merge SHA / PR ref; the verb refuses if the destructive change is not present in that merged diff). The CI environment alone is necessary but **not** sufficient — "ran in CI" ≠ "came from a merged PR."
- Default when unsure: treat as **local** (the safer, confirm-required branch).

This is a new annotation tier, `WRITE_DESTRUCTIVE`, distinct from `WRITE_OVERWRITE`, so the gate is legible to the MCP host and to reviewers.

### 7.3 Where the platform blocks the headless drop

Because a column/table drop is ACL-blocked headless (§4.5), the DELETE verbs **cannot perform the drop**. They:

1. produce the dry-run plan + blast-radius (what references the column/table),
2. on confirm (or merged-PR in automation), **emit the exact manual step** (the System Definition / Table-Management action), and
3. provide the **capture** that records the resulting deletion into the scope-correct update set once the manual drop is done — so the change still promotes like any other.

Choice "delete" is the exception that **can** be done headlessly: it is a **soft-delete** (`inactive=true`) via `pushWithUpdateSet`, fully within the existing primitive — no platform step required.

---

## 8. The deploy seam (decoupled, one-directional)

This capability's responsibility **ends** at: _every mutation lands in one named, scope-correct update set on the source instance, with all `sys_update_xml` rows asserted present._ That update set's **name** is the entire handoff contract.

The promotion **consumer already exists**: `@tenonhq/dovetail-sawmill` exports

```
// packages/sawmill/src/types.ts:11
promote(req: {
  sourceInstance: string;
  updateSetName: string;       // ← the handoff token
  commit: boolean;
  skipPreviewErrors?: string[];
}): Promise<{ remoteUpdateSetSysId; previewErrors[]; committed; elapsedMs }>
```

hitting `/api/cadso/dovetail_promote/promote` (`packages/sawmill/src/client.ts:9`). The merge-triggered orchestration package (`dovetail-deploy`, planned — `docs/dovetail-platform-spec.md:1422`) will wrap it; it is **not built yet**.

**Seam properties:**

- **No code dependency** from schema-CRUD onto the promotion layer. The dependency is the _data artifact_ (the update set), one-directional. Schema-CRUD can ship and be useful before any promotion package exists.
- **Verify-via-preview.** A schema-CRUD verb can optionally validate its own output by calling `promote({ …, commit: false })` — a preview that reports `previewErrors[]` without committing. Note `commit:true` is non-idempotent and never retried (`packages/sawmill/src/client.ts:78`); the seam therefore only ever _previews_ (commit:false) from within an authoring verb. Actual commits belong to the promotion layer.
- **Naming convention** is the only thing both sides must agree on: the update-set name schema-CRUD produces is the `updateSetName` the promotion layer consumes. The RFC fixes this as the contract; neither side hardcodes the other's internals.

---

## 9. Alternatives considered

### 9.1 REST-first schema CRUD — **rejected**

Drive table/field create via Table-API / `createRecord` inserts. Rejected: orphans tables (§4.1), adopts session scope and renames columns (§4.2), and a bare dictionary insert does not materialise the physical column. This is precisely the failure the in-tree `sys_db_object` guard exists to stop. Form-replay is the only faithful path.

### 9.2 Fold schema apply into `dove reconcile --apply` — **rejected**

Make reconcile apply schema drift branch→instance. Rejected: reconcile's schema is **report-only by deliberate design** ("a SN ceiling," `reconcileCommand.ts:15`), and reconcile's record-PATCH mechanism is the wrong tool — schema needs form-replay + update-set capture. Reconcile is also a _sync_ (make my instance match my branch), whereas schema-CRUD is an _authoring_ action. Keeping them separate preserves reconcile's "refuse-if-dirty" safety contract.

### 9.3 A new `dovetail-schema-write` package — **rejected**

Rejected: the form-login/auth machinery, the scope-switching write client, and the existing schema verbs already live in `dovetail-servicenow` + `dovetail-core`. A new package would fork that machinery and split the schema surface across three packages. Extend `dovetail-servicenow`.

### 9.4 Hard dependency on the (unbuilt) `dovetail-deploy` for a write→promote flow — **rejected**

Rejected: the promotion orchestrator is not built, and coupling schema-CRUD to it would block delivery behind another track. The update set is the decoupling seam; `dovetail-sawmill.promote` already exists if an inline preview is ever wanted (§8).

---

## 10. Risks & open questions

- **R1 — Field-CREATE replay (the gating risk).** Until S0 proves the single-column list-edit replay lands a physical column, field-CREATE is a hypothesis. Mitigation: S0 first; documented UI-handoff fallback (§6).
- **R2 — Physical-vs-metadata field UPDATE.** Some `sys_dictionary` attribute changes (e.g. `max_length`, `internal_type`) trigger a physical `ALTER COLUMN` and may need the form-replay rather than a plain `pushWithUpdateSet` patch; non-physical attributes (label, `mandatory`, `default`, `read_only`) do not. S3 must split these two classes.
- **R3 — Stale `create_table` MCP annotation.** The `create_table` tool annotation still reads "the live write path is pending a validated-live spike — prefer dryRun" (`packages/servicenow/src/mcp/registry.ts`), although `createTable.ts:20` records the 2026-06-13 live validation. S7 reconciles the annotation with the validated state.
- **R4 — Merged-PR signal fidelity.** The automation gate is only as good as the merge signal the workflow passes. S1 must define that contract explicitly and fail closed.

---

## 11. Stories

The build slices into nine ordered, independently-reviewable stories — **Appendix A**. Sequencing is driven by internal dependencies only (ownership/scheduling left open). **S0** (the field-CREATE spike) and **S1** (the gated-write harness) are the two roots and can run in parallel; everything else hangs off them.

---

## Appendix A — Hand-off stories

> Each story is self-contained — a developer can execute it from this doc alone. **Pkg** = owning package · **Deps** = stories that must land first · points are a rough Fibonacci size.

### Dependency graph

```
S0 (spike) ─┐
            ├─→ S2 (field CREATE) ─┐
S1 (gate) ──┼─→ S3 (field UPDATE)  ├─→ S7 (skill + surface) ─→ S8 (seam test)
            ├─→ S4 (table UPDATE)  │
            ├─→ S5 (choice soft-del)│
            └─→ S6 (hard DELETE) ──┘
```

### S0 — Field-CREATE replay spike · Pkg: dovetail-servicenow · Deps: none · ~5pts

**Goal:** Prove (or disprove) that adding a single column to an _existing_ table can be done headlessly by replaying the Studio list-edit form transaction.
**Acceptance criteria**

- A captured request trace of a one-column add to an existing table in Studio is analysed and its exact shape documented (endpoint, the `ListEditFormatterAction[…REL:<dict-relId>]` field, the `<record operation="add">` XML, the update-set pin).
- A throwaway script replays that request headlessly against a sandbox and **the physical column exists** afterward — verified by reading the table schema and inserting a scoped row that sets the column (round-trips, not an orphan).
- The resulting `sys_update_xml` rows land in a named, scope-correct update set (asserted by query).
- **Decision recorded in the RFC:** replayable → S2 is a faithful form-replay; not replayable → S2 degrades to the capture-intent + manual-step model (§7.3) and the parity claim is qualified.

### S1 — Execution-context detection + two-phase gate · Pkg: dovetail-servicenow (+ core helper) · Deps: none · ~5pts

**Goal:** A reusable gate every schema write/delete verb runs through, aware of local vs automation context.
**Acceptance criteria**

- A helper resolves context: auto-detects the CI environment (standard CI env signal), honours an explicit `--context=local|automation` override, defaults to `local` when ambiguous.
- Local: a schema-mutating verb runs two-phase — dry-run plan, then write only on explicit confirmation (mirrors the existing `dryRun` + two-phase CONFIRM patterns).
- Automation: a destructive verb additionally requires a merged-PR signal (a passed merge ref/SHA) and **fails closed** if the change is not present in that merged diff.
- Unit tests: local-no-confirm refuses; automation-without-merge-signal refuses; explicit override beats auto-detect.
- A new `WRITE_DESTRUCTIVE` mcp-kit annotation tier exists, distinct from `WRITE_OVERWRITE`.

### S2 — Field CREATE (`add-field` / `add_field_to_table`) · Pkg: dovetail-servicenow · Deps: S0, S1 · ~8pts

**Goal:** Add a column to an existing table faithfully, landing in a scope-correct update set.
**Acceptance criteria**

- New `dove-sn add-field` verb + `add_field_to_table` MCP tool (`WRITE_CREATE`): table, column (label, type, max_length, reference, mandatory, default), scope, update-set.
- Implementation extends the `createTable` form-replay (`packages/servicenow/src/table/createTable.ts`) and harvests the dictionary related-list relId from the _existing_ table's form (no hardcoded relId).
- `dryRun` returns the plan + the column XML with no session and no writes.
- Live path creates the **physical** column; `sys_update_xml` rows asserted in the named set; friendly types mapped to internal types (`string`→`string_full_utf8`).
- Cross-scope correctness: column created in the target scope, no session-scope rename (§4.2).
- (If S0 disproved replay: this story ships the capture-intent + manual-step path instead and is re-pointed.)

### S3 — Field UPDATE (`set-field` / `set_field`) · Pkg: dovetail-servicenow · Deps: S1 · ~5pts

**Goal:** Update dictionary attributes of an existing column.
**Acceptance criteria**

- New `dove-sn set-field` verb + `set_field` MCP tool (`WRITE_OVERWRITE`).
- **Non-physical** attributes (label, `mandatory`, `default`, `read_only`) update via `pushWithUpdateSet` (generalises the dict-patch at `packages/servicenow/src/choices.ts:191` + the existing `read_only` lock).
- **Physical** attributes (`max_length`, `internal_type`) are detected and routed through the form-replay (or surfaced as a manual step if not replayable) — never a silent metadata-only write that leaves the physical column unchanged.
- `element` (rename) is explicitly rejected, pointing at delete+recreate (immutable — §4.5).
- Writes land in the named update set; asserted.

### S4 — Table UPDATE (`set-table` / `set_table`) · Pkg: dovetail-servicenow · Deps: S1 · ~3pts

**Goal:** Update `sys_db_object` attributes of an existing table.
**Acceptance criteria**

- New `dove-sn set-table` verb + `set_table` MCP tool (`WRITE_OVERWRITE`) for label and access flags (read/create/update/delete/etc.).
- Writes via `pushWithUpdateSet` into the named, scope-correct set; asserted.
- `super_class` (extends) changes are out of scope and explicitly rejected (structural; deferred).

### S5 — Choice soft-DELETE (`remove-choices` / `remove_choices_from_field`) · Pkg: dovetail-servicenow · Deps: S1 · ~2pts

**Goal:** Remove a choice value without a platform drop.
**Acceptance criteria**

- Extends the `add-choices` path with a remove mode that sets `inactive=true` via `pushWithUpdateSet` — idempotent, update-set-aware.
- A hard delete of `sys_choice` is **not** attempted (deferred); the verb documents soft-delete semantics.
- Asserted in the named set.

### S6 — Context-gated hard DELETE (table / field) · Pkg: dovetail-servicenow · Deps: S1, S0 · ~5pts

**Goal:** A safe delete path for tables/columns given the ACL ceiling.
**Acceptance criteria**

- New `remove-field` / `remove-table` verbs + MCP tools (`WRITE_DESTRUCTIVE`), gated by S1's context rule (local confirm / automation merged-PR).
- Dry-run prints the blast radius (what references the column/table) before any action.
- Because the headless drop is ACL-blocked (§4.5), the verb emits the exact manual step and provides the capture that records the post-drop deletion into the scope-correct update set.
- Refuses in automation without a merged-PR signal; refuses locally without confirm.

### S7 — Unified `/sn-schema` skill + surface reconcile · Pkg: dovetail-servicenow + skill · Deps: S2–S6 · ~5pts

**Goal:** One coherent CRUD surface + fix the stale annotation.
**Acceptance criteria**

- A `/sn-schema` skill exposes CRUD over tables/fields/choices, calling the `dove-sn` write verbs and `dove schema` reads; documented with examples.
- All new MCP tools registered on `packages/servicenow/src/mcp/registry.ts` with correct annotation tiers.
- The `create_table` MCP annotation is reconciled with the live-validation state (`createTable.ts:20`) — the "prefer dryRun until confirmed" caveat updated (R3).
- `docs/claude-operating-guide.md` (the canonical capability catalog) updated with the new verbs/tools.

### S8 — Deploy-seam contract test · Pkg: dovetail-servicenow (test) · Deps: S2–S6 · ~3pts

**Goal:** Prove the handoff contract holds.
**Acceptance criteria**

- An integration test asserts each schema-mutating verb yields exactly one named, scope-correct update set with all expected `sys_update_xml` rows present.
- The test feeds that update-set name to `dovetail-sawmill` `promote({ sourceInstance, updateSetName, commit: false })` and asserts a clean preview (no `previewErrors`) — **commit:false only** (never commits from a test; §8).
- No build/runtime dependency from `dovetail-servicenow` onto a promotion package is introduced (the seam stays data-only).
  </content>
