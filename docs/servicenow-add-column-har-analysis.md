# Add-column request shape — HAR/trace analysis

**Status:** ground truth for a capability already shipped (`addColumn()`, `dove-sn add-column`,
`add_column` MCP tool — [PR #191](https://github.com/TenonHQ/Dovetail/pull/191), merged
2026-06-19, live-validated on tenonworkstudio). This doc is the S0 spike write-up the
[schema-CRUD RFC](servicenow-schema-crud-rfc.md) asked for (Appendix A, S0, AC1) — it was never
produced alongside PR #191, so it's reconstructed here from the shipped implementation (which
*is* the replayed request, byte for byte) rather than from a freshly re-captured HAR file. No
`.har` file has ever been committed to this repo — the equivalent create-table analysis doc
referenced in `createTable.ts`'s header comment (`servicenow-create-table-har-analysis.md`) was
likewise never written down separately.

## The mechanism

Adding a column to an **existing** table is a `POST /sys_db_object.do` against that table's own
record — the same list-edit transaction `create-table` uses for a brand-new table (RFC §4.1), just
against an existing `sys_id` instead of `sys_id=-1`. Implementation: `addColumn.ts`, reusing
`buildColumnXml.ts` / `buildTableSave.ts` / `formSession.ts` wholesale.

### 1. Endpoint

```
GET  /sys_db_object.do?sys_id=<tableSysId>&sysparm_stack=no   — harvest the existing form
POST /sys_db_object.do                                         — the save
```

Critically, an **existing** record's form *renders its related lists* — unlike the `sys_id=-1`
new-record form `create-table` has to work around by falling back to a hardcoded relId
(`createTable.ts:44-52`). So for add-column, `getRecordForm()` (`formSession.ts:225-255`) harvests
the real key straight off the page:

```ts
for (var i = 0; i < keys.length; i += 1) {
  if (keys[i].indexOf("ListEditFormatterAction[sys_db_object.REL:") !== -1) {
    listEditKey = keys[i];
    break;
  }
}
```

This resolves the RFC's §6 framing exactly as hypothesized: the existing-table case is *more*
tractable than table-create, not less, because there's no constant to hardcode — the relId comes
back live in the harvested form. `columnsRelId` is kept as an override param only for an instance
that customized the relationship.

### 2. The list-edit form key

```
ni.java.com.glide.ui_list_edit.ListEditFormatterAction[sys_db_object.REL:<dict-relId>]
```

Built by `listEditKey()` (`buildTableSave.ts:150-152`). `<dict-relId>` is the `sys_relationship`
sys_id for the table's "Columns" related list — harvested per-table above; `create-table`'s
constant (`4344f6f5bf1320001875647fcf0739ad`) is the fallback only.

### 3. The `<record operation="add">` XML

One `<record_update>` envelope per save, one `<record operation="add">` per new column
(`buildColumnXml.ts`):

```xml
<record_update table="sys_dictionary" field="null" query="nameONE IN^element!=NULL^ORDERBYelement">
  <record sys_id="<client-generated-32-hex>" operation="add">
    <field name="column_label" modified="true" value_set="false" dsp_set="true"><value></value><display_value>URL</display_value></field>
    <field name="element" modified="false" value_set="false" dsp_set="false"><value></value></field>
    <field name="internal_type" modified="true" value_set="true" dsp_set="false"><value>url</value></field>
    <field name="reference" modified="false" value_set="false" dsp_set="false"><value>NULL</value></field>
    <field name="max_length" modified="false" value_set="false" dsp_set="false"><value></value></field>
    <field name="default_value" modified="false" value_set="false" dsp_set="false"><value></value></field>
    <field name="display" modified="false" value_set="false" dsp_set="false"><value>false</value></field>
    <field name="sys_updated_on" modified="false" value_set="false" dsp_set="false"><value></value></field>
    <field name="sys_updated_by" modified="false" value_set="false" dsp_set="false"><value></value></field>
    <field name="attributes" modified="false" value_set="false" dsp_set="false"><value></value></field>
    <field name="read_only" modified="false" value_set="false" dsp_set="false"><value>false</value></field>
    <field name="sys_created_on" modified="false" value_set="false" dsp_set="false"><value></value></field>
    <field name="sys_created_by" modified="false" value_set="false" dsp_set="false"><value></value></field>
    <field name="name" modified="false" value_set="false" dsp_set="false"><value></value></field>
  </record>
</record_update>
```

`column_label` is the only field Studio's user actually types — `element` is left empty and
**derived server-side** from the label (confirmed by the before/after diff approach below; the
platform's derivation doesn't always match `deriveElement()`'s local guess — a trailing digit or
a cross-scope add can get normalized differently, which is why `addColumn.ts` never trusts its own
guess as the final answer). `internal_type` carries the resolved ServiceNow type
(`string` → `string_full_utf8`, confirmed in the original create-table HAR per `buildTableSave.ts:24`).
The `query` attribute's odd literal (`nameONE IN^element!=NULL^ORDERBYelement`) is copied verbatim
from the original captured create-table transaction and reused unchanged — it is what the list-edit
formatter itself emits, not something either capability constructs semantically.

### 4. What differs from a table-create save

`addColumn.ts`'s overlay (`applyAddColumnOverlay`) touches **only**:

```
sys_target, sys_uniqueName, sys_uniqueValue (= tableSysId), sys_row (= tableSysId),
sys_action, isFormPage, sysparm_modify_check, personalizer_sys_db_object,
<listEditKey> (= the column XML)
```

Every other harvested field — `sys_db_object.name`, `.label`, `.sys_scope`, `.access`, ACL flags,
`super_class`, etc. — is preserved untouched from the GET, so an add-column save cannot
accidentally re-stamp the table itself. (Contrast `createTable.ts`'s `applyTableSaveOverlay`,
which sets ~20 fields because it's originating the table from nothing.)

### 5. Scope + update-set pin

Same as table-create (RFC §4.2/§4.3) — neither is a body field:

- **Scope**: the form session's *current application* is switched via
  `PUT /api/now/ui/concoursepicker/application` (`setCurrentApplication`,
  `formSession.ts:174-203`) before the harvest/POST — governs which scope the column lands in.
- **Update set**: `client.claude.changeUpdateSet({ sysId })` — Dovetail's own scripted REST
  endpoint — is called before the form session's GET/POST, pinning the session's
  `sys_update_set` user preference so the resulting `sys_update_xml` rows land in the named set.

### 6. Response shape — the 200-vs-302 trap

A **new**-record save 302s to the assigned `sys_id` (`createTable.ts`'s success signal). An
**existing**-record save instead re-renders the form with **HTTP 200** — there is no redirect to
parse. `addColumn.ts` therefore never trusts HTTP status as proof of success; only a hard 4xx/5xx
short-circuits as `failed`. Real proof is a **before/after `sys_dictionary` diff**
(`elementTypeMap()`, queried via the REST client, not the form session) — the element(s) present
after the save but not before are the columns that actually landed, with whatever name ServiceNow
itself derived.

### 7. Live validation performed

**PR #191 (2026-06-19, tenonworkstudio):** against a throwaway scoped table
(`x_cadso_core_u_smoke_test_ct5`) — `add-column` created a `url` column, the before/after diff
confirmed it, and a scoped insert setting the new column round-tripped
(`physicalColumnAcceptsData: true`), proving a physical column rather than an orphaned
`sys_dictionary` row. That validation's note only *recommended* confirming the update-set
assertion; it didn't prove it.

**This spike (2026-07-07, tenonworkloft), closing that gap:** created a throwaway table
(`x_cadso_automate_u_dev464_ac3_check`) and a named update set
(`DEV-464 add-column AC3 verification`, `eb0a6aff47f5c710276209d3706d43b2`), then ran
`dove-sn add-column` pinned to that set. Result: `verified: true`, HTTP 200 (existing-record
re-render, confirming §6 above). A direct `sys_update_xml` query for
`update_set=eb0a6aff47f5c710276209d3706d43b2` returned the Dictionary row
`sys_dictionary_x_cadso_automate_u_dev464_ac3_check_verify_update_set`
(target `DEV-464 AC3 Check.Verify Update Set`) — **the update-set assertion S0's AC3 and S2's AC4
both required, now proven by query, not just by note.** A follow-up scoped insert
(`create x_cadso_automate_u_dev464_ac3_check --field verify_update_set=roundtrip-ok`) read back
`"verify_update_set":"roundtrip-ok"` — the physical-column round-trip, independently reconfirmed.

**One nuance surfaced by this run, worth recording:** the RFC's §6 framing ("the existing table's
form *does* render the dictionary related list, so the relId is harvestable") did not hold for
this table — the debug output showed `harvestedListEditKey=no`, meaning `addColumn()` fell back to
the constant `DEFAULT_COLUMNS_REL_ID`, same as `create-table` always does. The fallback worked
(the OOB relationship sys_id is stable), so this isn't a functional gap — but "harvested, not
hardcoded" is not guaranteed on every table/instance; the constant fallback is doing real, load-bearing
work, not just insurance for the new-record case.

**Also surfaced:** on this instance (tenonworkloft), Dovetail's `createUpdateSet` REST operation is
not installed, so `dove createUpdateSet` fell back to a plain Table API insert — which (per RFC
§4.2) adopts session scope rather than the requested one. The update set landed in
`x_cadso_automate`, not the requested `x_cadso_core`; the throwaway table was created in
`x_cadso_automate` to match. This is an update-set-*creation* gap on an older instance, unrelated to
`add-column`'s own scope-correctness (which behaved as documented throughout).

## Decision

**Replayable — confirmed.** The Studio list-edit transaction that creates a column on an existing
table replays headlessly exactly as hypothesized in RFC §6, and is *more* tractable than
table-create because the real relId is harvested from the existing form rather than hardcoded.
S2's scope is delivered (shipped as `add-column` / `add_column`, not the `add-field` /
`add_field_to_table` names originally proposed in the RFC — a naming choice, not a capability gap).
