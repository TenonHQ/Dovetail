import { runBuildFlow } from "../src/flowDesigner/buildFlowOrchestrator";
import type { ServiceNowClient } from "../src/client";

interface Cap {
  queries: Array<{ table: string; query: string }>;
  creates: Array<any>;
  pushes: Array<any>;
}

/**
 * Build a write-aware mock: scripted entries take precedence; if none matches,
 * fall back to looking up the in-memory record store populated by createRecord
 * calls. That way verifyArtifact's read-back of records-we-just-wrote works
 * naturally — no need to know runtime-generated sys_ids ahead of time.
 *
 * The fallback handles the two access patterns verifyArtifact uses:
 *   - sys_id=<X>            → returns the matching write, if any
 *   - <fkColumn>=<X>        → returns every write whose fields[fkColumn] === X
 */
function makeClient(scripted: Array<{ match: (table: string, query: string) => boolean; rows: Array<any> }>): {
  client: ServiceNowClient;
  cap: Cap;
} {
  var cap: Cap = { queries: [], creates: [], pushes: [] };

  function fallbackMatch(table: string, query: string): Array<any> | null {
    var rowsForTable = cap.creates.filter(function (c) { return c.table === table; }).map(function (c) { return c.fields; });
    var sysIdMatch = /(?:^|\^)sys_id=([0-9a-f]{32})(?:$|\^)/.exec(query);
    if (sysIdMatch) {
      var sid = sysIdMatch[1];
      return rowsForTable.filter(function (f) { return f.sys_id === sid; });
    }
    var fkMatch = /(?:^|\^)(\w+)=([0-9a-f]{32})(?:$|\^)/.exec(query);
    if (fkMatch) {
      var fkCol = fkMatch[1];
      var fkVal = fkMatch[2];
      return rowsForTable.filter(function (f) { return f[fkCol] === fkVal; });
    }
    return null;
  }

  return {
    cap: cap,
    client: {
      table: { query: async function () { return []; } },
      buildAgent: {
        runQuery: async function <T>(p: { table: string; query: string }): Promise<Array<T>> {
          cap.queries.push({ table: p.table, query: p.query });
          for (var i = 0; i < scripted.length; i++) {
            if (scripted[i].match(p.table, p.query)) return scripted[i].rows as Array<T>;
          }
          var fb = fallbackMatch(p.table, p.query);
          if (fb !== null) return fb as Array<T>;
          return [] as Array<T>;
        },
        getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; },
      },
      claude: {
        createRecord: async function (p: any) {
          cap.creates.push(p);
          return { sys_id: p.sys_id };
        },
        pushWithUpdateSet: async function (p: any) {
          cap.pushes.push(p);
          return { sys_id: p.record_sys_id };
        },
        currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
      },
    },
  };
}

var SOURCE = "11111111111111111111111111111111";
var SCOPE = "22222222222222222222222222222222";
var US = "33333333333333333333333333333333";

describe("runBuildFlow — spec validation", function () {
  it("returns unrecoverable on missing kind", async function () {
    var ctx = makeClient([]);
    var r = await runBuildFlow(ctx.client, { mode: "clone", newName: "X", newScope: SCOPE, updateSetSysId: US, sourceSysId: SOURCE });
    expect(r.outcome).toBe("unrecoverable");
    expect(r.exitCode).toBe(5);
    expect(r.error?.message).toMatch(/kind/);
  });

  it("returns unrecoverable on bad scope", async function () {
    var ctx = makeClient([]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone", sourceSysId: SOURCE,
      newName: "X", newScope: "not-a-sys-id", updateSetSysId: US,
    });
    expect(r.outcome).toBe("unrecoverable");
    expect(r.error?.message).toMatch(/newScope/);
  });

  it("returns unrecoverable on missing sourceSysId for clone", async function () {
    var ctx = makeClient([]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone",
      newName: "X", newScope: SCOPE, updateSetSysId: US,
    });
    expect(r.outcome).toBe("unrecoverable");
    expect(r.error?.message).toMatch(/sourceSysId/);
  });

  it("rejects mode=create with a clear NotImplemented message", async function () {
    var ctx = makeClient([]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "create",
      newName: "X", newScope: SCOPE, updateSetSysId: US,
    });
    expect(r.outcome).toBe("unrecoverable");
    expect(r.error?.message).toMatch(/Phase 1.C.2/);
  });
});

describe("runBuildFlow — update set state", function () {
  it("rejects when update set is not in progress", async function () {
    var ctx = makeClient([
      {
        match: function (t) { return t === "sys_update_set"; },
        rows: [{ sys_id: US, state: "complete", name: "Old" }],
      },
    ]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone", sourceSysId: SOURCE,
      newName: "X", newScope: SCOPE, updateSetSysId: US,
    });
    expect(r.outcome).toBe("unrecoverable");
    expect(r.error?.message).toMatch(/in progress/);
    // Did not proceed to write.
    expect(ctx.cap.creates).toHaveLength(0);
  });

  it("rejects when update set is not found", async function () {
    var ctx = makeClient([
      { match: function (t) { return t === "sys_update_set"; }, rows: [] },
    ]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone", sourceSysId: SOURCE,
      newName: "X", newScope: SCOPE, updateSetSysId: US,
    });
    expect(r.outcome).toBe("unrecoverable");
    expect(r.error?.message).toMatch(/not found/);
  });
});

describe("runBuildFlow — clone happy path", function () {
  it("runs end-to-end through clone + verify + publish, returning needs-ui-publish in degraded mode", async function () {
    var ctx = makeClient([
      { match: function (t) { return t === "sys_update_set"; }, rows: [{ sys_id: US, state: "in progress", name: "WIP" }] },
      // Idempotency check — empty (target name not yet there)
      {
        match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("name=Cloned") >= 0; },
        rows: [],
      },
      // Source flow lookup
      {
        match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("sys_id=" + SOURCE) >= 0; },
        rows: [{ sys_id: SOURCE, name: "Source", type: "subflow", sys_scope: "old" }],
      },
      // Children — empty for simplicity
      { match: function (t) { return t === "sys_hub_flow_input"; }, rows: [] },
      { match: function (t) { return t === "sys_hub_flow_output"; }, rows: [] },
      { match: function (t) { return t === "sys_hub_flow_variable"; }, rows: [] },
      { match: function (t) { return t === "sys_hub_action_instance_v2"; }, rows: [] },
      { match: function (t) { return t === "sys_hub_flow_logic_instance_v2"; }, rows: [] },
      // No snapshot (degraded mode)
      { match: function (t) { return t === "sys_hub_flow_snapshot"; }, rows: [] },
    ]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone", sourceSysId: SOURCE,
      newName: "Cloned", newScope: SCOPE, updateSetSysId: US,
    }, { skipPublish: false, snapshotTimeoutMs: 600 });

    // We didn't get a snapshot → snapshot-pending → needs-ui-publish (exit 2).
    expect(r.outcome).toBe("needs-ui-publish");
    expect(r.exitCode).toBe(2);
    expect(r.artifact).toBeDefined();
    expect(r.artifact!.action).toBe("created");
    expect(ctx.cap.creates.length).toBeGreaterThan(0);
    expect(ctx.cap.pushes.length).toBe(1); // the publish trigger
  });

  it("returns done (exit 0) when publish snapshot lands", async function () {
    var ctx = makeClient([
      { match: function (t) { return t === "sys_update_set"; }, rows: [{ sys_id: US, state: "in progress", name: "WIP" }] },
      { match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("name=Cloned") >= 0; }, rows: [] },
      { match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("sys_id=" + SOURCE) >= 0; },
        rows: [{ sys_id: SOURCE, name: "S", type: "subflow", sys_scope: "old" }] },
      // Snapshot is server-side; mock it as always-present so triggerPublication's poll resolves.
      { match: function (t) { return t === "sys_hub_flow_snapshot"; }, rows: [{ sys_id: "snap1" }] },
    ]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone", sourceSysId: SOURCE,
      newName: "Cloned", newScope: SCOPE, updateSetSysId: US,
    });
    expect(r.outcome).toBe("done");
    expect(r.exitCode).toBe(0);
    expect(r.publish?.status).toBe("published");
  });

  it("dryRun returns the plan and exits 0 without writing", async function () {
    var ctx = makeClient([
      { match: function (t) { return t === "sys_update_set"; }, rows: [{ sys_id: US, state: "in progress", name: "WIP" }] },
      { match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("name=Cloned") >= 0; }, rows: [] },
      { match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("sys_id=" + SOURCE) >= 0; }, rows: [{ sys_id: SOURCE, name: "S", type: "subflow", sys_scope: "old" }] },
      { match: function (t) { return t === "sys_hub_flow_input"; }, rows: [{ sys_id: "i1", flow: SOURCE, sys_scope: "old" }] },
    ]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone", sourceSysId: SOURCE,
      newName: "Cloned", newScope: SCOPE, updateSetSysId: US,
    }, { dryRun: true });
    expect(r.outcome).toBe("dry-run");
    expect(r.exitCode).toBe(0);
    expect(r.plan).toBeDefined();
    expect(r.plan!.length).toBeGreaterThan(0);
    expect(ctx.cap.creates).toHaveLength(0);
    expect(ctx.cap.pushes).toHaveLength(0);
  });

  it("returns unchanged (exit 0) on idempotent re-run", async function () {
    var ctx = makeClient([
      { match: function (t) { return t === "sys_update_set"; }, rows: [{ sys_id: US, state: "in progress", name: "WIP" }] },
      { match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("name=Already") >= 0; }, rows: [{ sys_id: "abc12345abc12345abc12345abc12345" }] },
    ]);
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone", sourceSysId: SOURCE,
      newName: "Already", newScope: SCOPE, updateSetSysId: US,
    });
    expect(r.outcome).toBe("unchanged");
    expect(r.exitCode).toBe(0);
    expect(r.artifact?.action).toBe("unchanged");
    expect(ctx.cap.creates).toHaveLength(0);
  });
});

describe("runBuildFlow — write failure", function () {
  it("maps cloneSubflow throws to outcome=write-failed (exit 4)", async function () {
    var ctx = {
      cap: { creates: [] as Array<any> },
      client: {
        table: { query: async function () { return []; } },
        buildAgent: {
          runQuery: async function <T>(p: { table: string; query: string }): Promise<Array<T>> {
            if (p.table === "sys_update_set") return [{ sys_id: US, state: "in progress", name: "WIP" }] as any;
            if (p.table === "sys_hub_flow" && p.query.indexOf("name=Cloned") >= 0) return [] as any;
            if (p.table === "sys_hub_flow" && p.query.indexOf("sys_id=" + SOURCE) >= 0) {
              return [{ sys_id: SOURCE, name: "S", type: "subflow", sys_scope: "old" }] as any;
            }
            return [] as any;
          },
          getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; },
        },
        claude: {
          createRecord: async function () { throw new Error("ACL violation on sys_hub_flow"); },
          pushWithUpdateSet: async function (p: any) { return { sys_id: p.record_sys_id }; },
          currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
        },
      } as ServiceNowClient,
    };
    var r = await runBuildFlow(ctx.client, {
      kind: "subflow", mode: "clone", sourceSysId: SOURCE,
      newName: "Cloned", newScope: SCOPE, updateSetSysId: US,
    });
    expect(r.outcome).toBe("write-failed");
    expect(r.exitCode).toBe(4);
    expect(r.error?.message).toMatch(/ACL violation/);
  });
});
