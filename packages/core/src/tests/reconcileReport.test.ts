// Tests for the pure reconcile report renderer — convergence message, drift
// banner, instance deep-links, delete partitioning, and the report-only schema
// section.

import { SchemaDiff } from "@tenonhq/dovetail-schema";
import {
  formatReconcileReport,
  ReconcileScopeResult,
} from "../reconcile/report";
import { RecordChange, RecordDiff } from "../reconcile/types";

const emptyDiff = (): RecordDiff => ({
  creates: [],
  updates: [],
  deletes: [],
  unchangedCount: 0,
});

const change = (
  over: Partial<RecordChange> & Pick<RecordChange, "sys_id" | "kind">,
): RecordChange => ({
  table: "sys_script_include",
  scope: "x_cadso_core",
  name: over.sys_id,
  fieldDeltas: [],
  ...over,
});

const scope = (over: Partial<ReconcileScopeResult>): ReconcileScopeResult => ({
  scope: "x_cadso_core",
  diff: emptyDiff(),
  dirty: [],
  hasBaseline: true,
  schema: null,
  ...over,
});

describe("formatReconcileReport", () => {
  it("reports an in-sync scope and a zeroed summary", () => {
    const out = formatReconcileReport({
      instanceHost: "tenonworkstudio",
      branchRef: "main",
      scopes: [scope({ diff: { ...emptyDiff(), unchangedCount: 12 } })],
      schemaSkippedReason: null,
    });
    expect(out).toContain("in sync (12 records match the instance)");
    expect(out).toContain("Summary: 0 create, 0 update, 0 delete");
  });

  it("renders create/update/delete rows with instance deep links", () => {
    const diff: RecordDiff = {
      creates: [change({ sys_id: "c1", kind: "create", name: "NewThing" })],
      updates: [
        change({
          sys_id: "u1",
          kind: "update",
          name: "Edited",
          fieldDeltas: [
            { field: "script.js", onBranch: true, onLive: true, changed: true },
          ],
        }),
      ],
      deletes: [
        change({
          sys_id: "d1",
          kind: "delete",
          name: "Gone",
          deleteDisposition: "tracked",
        }),
      ],
      unchangedCount: 0,
    };
    const out = formatReconcileReport({
      instanceHost: "tenonworkstudio",
      branchRef: "feat/x",
      scopes: [scope({ diff })],
      schemaSkippedReason: null,
    });
    expect(out).toContain("CREATE (1):");
    expect(out).toContain("UPDATE (1):");
    expect(out).toContain("DELETE (1):");
    expect(out).toContain(
      "https://tenonworkstudio.service-now.com/sys_script_include.do?sys_id=c1",
    );
    expect(out).toContain("- script.js (changed)");
    expect(out).toContain("Summary: 1 create, 1 update, 1 delete");
  });

  it("keeps local-new instance-only records out of DELETE and never proposes deleting them", () => {
    const diff: RecordDiff = {
      ...emptyDiff(),
      deletes: [
        change({
          sys_id: "mine",
          kind: "delete",
          name: "DevMade",
          deleteDisposition: "local-new",
        }),
      ],
    };
    const out = formatReconcileReport({
      instanceHost: "tenonworkstudio",
      branchRef: "main",
      scopes: [scope({ diff })],
      schemaSkippedReason: null,
    });
    expect(out).toContain("INSTANCE-ONLY");
    expect(out).not.toContain("DELETE (");
    expect(out).toContain(
      "Summary: 0 create, 0 update, 0 delete, 1 instance-only kept",
    );
  });

  it("surfaces drift and warns that apply would refuse", () => {
    const out = formatReconcileReport({
      instanceHost: "tenonworkstudio",
      branchRef: "main",
      scopes: [
        scope({
          dirty: [
            {
              sys_id: "x",
              table: "sys_script",
              name: "Touched",
              reason: "changed-since-baseline",
            },
          ],
        }),
      ],
      schemaSkippedReason: null,
    });
    expect(out).toContain("DRIFT — instance changed since baseline");
    expect(out).toContain(
      "Apply would REFUSE: 1 record(s) changed on the instance since baseline",
    );
  });

  it("warns when no baseline exists for the scope", () => {
    const out = formatReconcileReport({
      instanceHost: "tenonworkstudio",
      branchRef: "main",
      scopes: [scope({ hasBaseline: false })],
      schemaSkippedReason: null,
    });
    expect(out).toContain("no baseline for this instance");
  });

  it("renders schema deltas as report-only with dictionary links", () => {
    const schemaDiff: SchemaDiff = {
      instance: "tenonworkstudio",
      from: { ref: "snap", generated_at: "" },
      to: { ref: "live", generated_at: "" },
      scope: "x_cadso_core",
      summary: { breaking: 1, warn: 0, info: 0 },
      tables: [],
      fields: [
        {
          table: "x_cadso_thing",
          field: "old_col",
          change: "removed",
          severity: "BREAKING",
        },
      ],
      exit_code: 1,
    };
    const out = formatReconcileReport({
      instanceHost: "tenonworkstudio",
      branchRef: "main",
      scopes: [scope({ schema: schemaDiff })],
      schemaSkippedReason: null,
    });
    expect(out).toContain("SCHEMA — report-only");
    expect(out).toContain("removed x_cadso_thing.old_col");
    expect(out).toContain(
      "sys_dictionary_list.do?sysparm_query=name=x_cadso_thing^element=old_col",
    );
  });

  it("notes when the schema arm was skipped", () => {
    const out = formatReconcileReport({
      instanceHost: "tenonworkstudio",
      branchRef: "main",
      scopes: [scope({})],
      schemaSkippedReason: "no snapshot found",
    });
    expect(out).toContain("Schema diff skipped: no snapshot found");
  });
});
