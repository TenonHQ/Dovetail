import { listTemplates } from "../src/flowDesigner/listTemplates";
import { verifyArtifact } from "../src/flowDesigner/verifyArtifact";
import type { ServiceNowClient } from "../src/client";

interface RunQueryCall {
  table: string;
  query: string;
  limit?: number;
}

function makeClient(scripted: Array<{ match: (call: RunQueryCall) => boolean; rows: Array<any> }>): {
  client: ServiceNowClient;
  calls: Array<RunQueryCall>;
} {
  var calls: Array<RunQueryCall> = [];
  var client: ServiceNowClient = {
    table: {
      query: async function () {
        throw new Error("test client.table.query was unexpectedly called — flowDesigner code should route through buildAgent");
      },
    },
    buildAgent: {
      runQuery: async function <T>(params: { table: string; query: string; limit?: number }): Promise<Array<T>> {
        calls.push({ table: params.table, query: params.query, limit: params.limit });
        for (var i = 0; i < scripted.length; i++) {
          if (scripted[i].match(params)) return scripted[i].rows as Array<T>;
        }
        return [] as Array<T>;
      },
      getTableSchema: async function () {
        return { fields: [], primary_key: "sys_id" };
      },
    },
    claude: {
      createRecord: async function () { return { sys_id: "x" }; },
      pushWithUpdateSet: async function (p) { return { sys_id: p.record_sys_id }; },
      currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
    },
  };
  return { client: client, calls: calls };
}

describe("listTemplates", function () {
  it("fetches subflows when kind=subflow, filters by type=subflow", async function () {
    var ctx = makeClient([
      {
        match: function (c) { return c.table === "sys_hub_flow"; },
        rows: [
          { sys_id: "f1", name: "Send Welcome", internal_name: "send_welcome", sys_scope: "scope_core", category: null },
          { sys_id: "f2", name: "Resolve DLR", internal_name: "resolve_dlr", sys_scope: "scope_text", category: "ops" },
        ],
      },
    ]);
    var out = await listTemplates({ client: ctx.client, kind: "subflow" });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(expect.objectContaining({
      sysId: "f1", name: "Send Welcome", kind: "subflow", scopeSysId: "scope_core", source: "instance",
    }));
    expect(ctx.calls[0].table).toBe("sys_hub_flow");
    expect(ctx.calls[0].query).toMatch(/^type=subflow/);
  });

  it("fetches custom action types when kind=actionType", async function () {
    var ctx = makeClient([
      {
        match: function (c) { return c.table === "sys_hub_action_type_definition"; },
        rows: [{ sys_id: "a1", name: "Get Audience Members", internal_name: "get_aud", sys_scope: "scope_core" }],
      },
    ]);
    var out = await listTemplates({ client: ctx.client, kind: "actionType" });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("actionType");
    expect(out[0].internalName).toBe("get_aud");
  });

  it("kind=both returns action types AND subflows in one call", async function () {
    var ctx = makeClient([
      {
        match: function (c) { return c.table === "sys_hub_action_type_definition"; },
        rows: [{ sys_id: "a1", name: "AT-1", internal_name: "at_1", sys_scope: "s" }],
      },
      {
        match: function (c) { return c.table === "sys_hub_flow"; },
        rows: [{ sys_id: "f1", name: "SF-1", internal_name: "sf_1", sys_scope: "s" }],
      },
    ]);
    var out = await listTemplates({ client: ctx.client, kind: "both" });
    expect(out.map(function (t) { return t.kind; }).sort()).toEqual(["actionType", "subflow"]);
  });

  it("filters by scope sys_id when 32-char hex is supplied", async function () {
    var ctx = makeClient([
      { match: function (c) { return c.table === "sys_hub_flow"; }, rows: [] },
    ]);
    var sysId = "deadbeef12345678deadbeef12345678";
    await listTemplates({ client: ctx.client, kind: "subflow", scope: sysId });
    expect(ctx.calls[0].query).toContain("sys_scope=" + sysId);
  });

  it("resolves scope name to sys_id with one extra sys_scope query", async function () {
    var ctx = makeClient([
      {
        match: function (c) { return c.table === "sys_scope" && c.query.indexOf("scope=x_cadso_core") >= 0; },
        rows: [{ sys_id: "scope_core_sys_id", scope: "x_cadso_core" }],
      },
      { match: function (c) { return c.table === "sys_hub_flow"; }, rows: [] },
    ]);
    await listTemplates({ client: ctx.client, kind: "subflow", scope: "x_cadso_core" });
    expect(ctx.calls[0].table).toBe("sys_scope");
    expect(ctx.calls[1].query).toContain("sys_scope=scope_core_sys_id");
  });

  it("throws when scope name cannot be resolved", async function () {
    var ctx = makeClient([
      { match: function (c) { return c.table === "sys_scope"; }, rows: [] },
    ]);
    await expect(listTemplates({ client: ctx.client, kind: "subflow", scope: "x_doesnotexist" }))
      .rejects.toThrow(/did not resolve to a sys_scope/);
  });

  it("when no scope is given, restricts to x_-prefixed scopes (excludes OOB)", async function () {
    var ctx = makeClient([
      { match: function (c) { return c.table === "sys_hub_flow"; }, rows: [] },
    ]);
    await listTemplates({ client: ctx.client, kind: "subflow" });
    expect(ctx.calls[0].query).toContain("sys_scope.scopeSTARTSWITHx_");
  });

  it("appends a LIKE clause when query is provided", async function () {
    var ctx = makeClient([
      { match: function (c) { return c.table === "sys_hub_flow"; }, rows: [] },
    ]);
    await listTemplates({ client: ctx.client, kind: "subflow", query: "Welcome" });
    expect(ctx.calls[0].query).toContain("nameLIKEWelcome");
  });
});

describe("verifyArtifact", function () {
  var SUBFLOW_SYS = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("rejects malformed sys_id", async function () {
    var ctx = makeClient([]);
    await expect(verifyArtifact({ client: ctx.client, sysId: "nope", kind: "subflow" }))
      .rejects.toThrow(/32-char ServiceNow sys_id/);
  });

  it("returns parent=false when the sys_hub_flow row is missing", async function () {
    var ctx = makeClient([
      { match: function (c) { return c.table === "sys_hub_flow"; }, rows: [] },
    ]);
    var report = await verifyArtifact({ client: ctx.client, sysId: SUBFLOW_SYS, kind: "subflow" });
    expect(report.found.parent).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toEqual({ layer: "L1", field: "parent", expected: true, actual: false });
  });

  it("counts inputs / outputs / steps for a subflow", async function () {
    var ctx = makeClient([
      {
        match: function (c) { return c.table === "sys_hub_flow" && c.query.indexOf("sys_id=") >= 0; },
        rows: [{ sys_id: SUBFLOW_SYS, type: "subflow" }],
      },
      {
        match: function (c) { return c.table === "sys_hub_flow_input"; },
        rows: [{ sys_id: "i1" }, { sys_id: "i2" }],
      },
      {
        match: function (c) { return c.table === "sys_hub_flow_output"; },
        rows: [{ sys_id: "o1" }],
      },
      {
        match: function (c) { return c.table === "sys_hub_action_instance_v2"; },
        rows: [{ sys_id: "s1" }, { sys_id: "s2" }],
      },
      {
        match: function (c) { return c.table === "sys_hub_flow_logic_instance_v2"; },
        rows: [{ sys_id: "l1" }],
      },
      {
        match: function (c) { return c.table === "sys_hub_flow_snapshot"; },
        rows: [{ sys_id: "snap1" }],
      },
    ]);
    var report = await verifyArtifact({
      client: ctx.client,
      sysId: SUBFLOW_SYS,
      kind: "subflow",
      expected: { inputCount: 2, outputCount: 1, stepCount: 3, publishedSnapshotPresent: true },
    });
    expect(report.found).toEqual({
      parent: true,
      inputCount: 2,
      outputCount: 1,
      stepCount: 3,
      snapshotPresent: true,
    });
    expect(report.ok).toBe(true);
    expect(report.failures).toHaveLength(0);
  });

  it("flags input count mismatch as L1 failure", async function () {
    var ctx = makeClient([
      { match: function (c) { return c.table === "sys_hub_flow"; }, rows: [{ sys_id: SUBFLOW_SYS, type: "subflow" }] },
      { match: function (c) { return c.table === "sys_hub_flow_input"; }, rows: [{ sys_id: "i1" }] },
    ]);
    var report = await verifyArtifact({
      client: ctx.client,
      sysId: SUBFLOW_SYS,
      kind: "subflow",
      expected: { inputCount: 5 },
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual({ layer: "L1", field: "inputCount", expected: 5, actual: 1 });
  });

  it("flags missing snapshot as L4 failure when expected", async function () {
    var ctx = makeClient([
      { match: function (c) { return c.table === "sys_hub_flow"; }, rows: [{ sys_id: SUBFLOW_SYS, type: "subflow" }] },
      { match: function () { return false; }, rows: [] },
    ]);
    var report = await verifyArtifact({
      client: ctx.client,
      sysId: SUBFLOW_SYS,
      kind: "subflow",
      expected: { publishedSnapshotPresent: true },
    });
    expect(report.found.snapshotPresent).toBe(false);
    expect(report.failures).toContainEqual({ layer: "L4", field: "publishedSnapshotPresent", expected: true, actual: false });
  });

  it("uses sys_hub_action_type_definition + sys_hub_step_instance for actionType kind", async function () {
    var ATSYS = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    var ctx = makeClient([
      { match: function (c) { return c.table === "sys_hub_action_type_definition"; }, rows: [{ sys_id: ATSYS }] },
      { match: function (c) { return c.table === "sys_hub_action_input"; }, rows: [{ sys_id: "i" }] },
      { match: function (c) { return c.table === "sys_hub_action_output"; }, rows: [{ sys_id: "o" }] },
      { match: function (c) { return c.table === "sys_hub_step_instance"; }, rows: [{ sys_id: "s1" }, { sys_id: "s2" }] },
    ]);
    var report = await verifyArtifact({ client: ctx.client, sysId: ATSYS, kind: "actionType" });
    expect(report.found.parent).toBe(true);
    expect(report.found.inputCount).toBe(1);
    expect(report.found.outputCount).toBe(1);
    expect(report.found.stepCount).toBe(2);
    expect(ctx.calls.some(function (c) { return c.table === "sys_hub_step_instance"; })).toBe(true);
  });
});
