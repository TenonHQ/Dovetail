import { cloneSubflow } from "../src/flowDesigner/cloneSubflow";
import { cloneActionType } from "../src/flowDesigner/cloneActionType";
import type { ServiceNowClient } from "../src/client";

interface Captured {
  runQueryCalls: Array<{ table: string; query: string }>;
  createRecordCalls: Array<{ table: string; fields: Record<string, any>; sys_id?: string; update_set_sys_id?: string; scope?: string }>;
}

function makeClient(scripted: Array<{ match: (table: string, query: string) => boolean; rows: Array<any> }>): {
  client: ServiceNowClient;
  cap: Captured;
} {
  var cap: Captured = { runQueryCalls: [], createRecordCalls: [] };
  var client: ServiceNowClient = {
    table: { query: async function () { return []; } },
    buildAgent: {
      runQuery: async function <T>(p: { table: string; query: string; limit?: number }): Promise<Array<T>> {
        cap.runQueryCalls.push({ table: p.table, query: p.query });
        for (var i = 0; i < scripted.length; i++) {
          if (scripted[i].match(p.table, p.query)) return scripted[i].rows as Array<T>;
        }
        return [] as Array<T>;
      },
      getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; },
    },
    claude: {
      createRecord: async function (params: any) {
        cap.createRecordCalls.push(params);
        return { sys_id: params.sys_id };
      },
      pushWithUpdateSet: async function (p: any) { return { sys_id: p.record_sys_id }; },
      currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
    },
  };
  return { client: client, cap: cap };
}

var SOURCE_FLOW_ID = "11111111111111111111111111111111";
var NEW_SCOPE_ID = "22222222222222222222222222222222";
var UPDATE_SET_ID = "33333333333333333333333333333333";

describe("cloneSubflow", function () {
  it("clones the parent + every child row, rewriting flow FK to the new sys_id", async function () {
    var ctx = makeClient([
      {
        match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("sys_id=" + SOURCE_FLOW_ID) >= 0; },
        rows: [{
          sys_id: SOURCE_FLOW_ID,
          name: "Source Subflow",
          internal_name: "source_subflow",
          type: "subflow",
          sys_scope: "old_scope_xx",
          application: "old_scope_xx",
          description: "from",
          master_snapshot: "stale_master",
          latest_snapshot: "stale_latest",
          sys_created_on: "2025-01-01",
          sys_mod_count: "9",
        }],
      },
      // idempotency check returns empty (target name doesn't exist yet)
      {
        match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("name=Cloned Subflow") >= 0; },
        rows: [],
      },
      {
        match: function (t) { return t === "sys_hub_flow_input"; },
        rows: [
          { sys_id: "i1", name: "Recipient", flow: SOURCE_FLOW_ID, sys_scope: "old_scope_xx" },
          { sys_id: "i2", name: "Body", flow: SOURCE_FLOW_ID, sys_scope: "old_scope_xx" },
        ],
      },
      {
        match: function (t) { return t === "sys_hub_flow_output"; },
        rows: [{ sys_id: "o1", name: "Sent", flow: SOURCE_FLOW_ID, sys_scope: "old_scope_xx" }],
      },
      {
        match: function (t) { return t === "sys_hub_action_instance_v2"; },
        rows: [{ sys_id: "a1", flow: SOURCE_FLOW_ID, action_type: "at_xyz", sys_scope: "old_scope_xx" }],
      },
      {
        match: function (t) { return t === "sys_hub_flow_logic_instance_v2"; },
        rows: [{ sys_id: "l1", flow: SOURCE_FLOW_ID, sys_scope: "old_scope_xx" }],
      },
    ]);

    var result = await cloneSubflow({
      client: ctx.client,
      sourceSysId: SOURCE_FLOW_ID,
      newName: "Cloned Subflow",
      newScope: NEW_SCOPE_ID,
      updateSetSysId: UPDATE_SET_ID,
    });

    expect(result.action).toBe("created");
    expect(result.sysId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.sysId).not.toBe(SOURCE_FLOW_ID);

    // Parent first, then children. 5 children total.
    expect(ctx.cap.createRecordCalls).toHaveLength(6);
    expect(ctx.cap.createRecordCalls[0].table).toBe("sys_hub_flow");
    var parent = ctx.cap.createRecordCalls[0];
    expect(parent.fields.name).toBe("Cloned Subflow");
    expect(parent.fields.internal_name).toBe("Cloned Subflow");
    expect(parent.fields.sys_scope).toBe(NEW_SCOPE_ID);
    expect(parent.fields.sys_id).toBe(result.sysId);
    expect(parent.fields.sys_created_on).toBeUndefined();
    expect(parent.fields.sys_mod_count).toBeUndefined();
    // Stale snapshot pointers from the source MUST be dropped — the new flow's
    // snapshot will be regenerated server-side at publish time.
    expect(parent.fields.master_snapshot).toBeUndefined();
    expect(parent.fields.latest_snapshot).toBeUndefined();
    expect(parent.update_set_sys_id).toBe(UPDATE_SET_ID);

    // Every child must have fk rewritten to the new sys_id and a fresh sys_id.
    for (var i = 1; i < ctx.cap.createRecordCalls.length; i++) {
      var c = ctx.cap.createRecordCalls[i];
      expect(c.fields.flow).toBe(result.sysId);
      expect(c.fields.sys_id).toMatch(/^[0-9a-f]{32}$/);
      expect(c.fields.sys_id).not.toBe("i1");
      expect(c.fields.sys_scope).toBe(NEW_SCOPE_ID);
      expect(c.update_set_sys_id).toBe(UPDATE_SET_ID);
    }
  });

  it("short-circuits when (newName, newScope) already exists", async function () {
    var ctx = makeClient([
      {
        match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("name=Already There") >= 0; },
        rows: [{ sys_id: "existing_sys_id_yyyyyyyyyyyyyyyy" }],
      },
    ]);
    var result = await cloneSubflow({
      client: ctx.client,
      sourceSysId: SOURCE_FLOW_ID,
      newName: "Already There",
      newScope: NEW_SCOPE_ID,
      updateSetSysId: UPDATE_SET_ID,
    });
    expect(result.action).toBe("unchanged");
    expect(result.sysId).toBe("existing_sys_id_yyyyyyyyyyyyyyyy");
    expect(ctx.cap.createRecordCalls).toHaveLength(0);
  });

  it("throws when the source sys_hub_flow is not found", async function () {
    var ctx = makeClient([]);
    await expect(cloneSubflow({
      client: ctx.client,
      sourceSysId: SOURCE_FLOW_ID,
      newName: "X",
      newScope: NEW_SCOPE_ID,
      updateSetSysId: UPDATE_SET_ID,
    })).rejects.toThrow(/source sys_hub_flow not found/);
  });

  it("rejects a non-subflow source (refuses to clone full flows in Phase 1)", async function () {
    var ctx = makeClient([
      {
        match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("sys_id=" + SOURCE_FLOW_ID) >= 0; },
        rows: [{ sys_id: SOURCE_FLOW_ID, name: "Real Flow", type: "flow" }],
      },
    ]);
    await expect(cloneSubflow({
      client: ctx.client,
      sourceSysId: SOURCE_FLOW_ID,
      newName: "X",
      newScope: NEW_SCOPE_ID,
      updateSetSysId: UPDATE_SET_ID,
    })).rejects.toThrow(/not a subflow/);
  });

  it("dryRun returns the plan without writing", async function () {
    var ctx = makeClient([
      {
        match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("sys_id=") >= 0; },
        rows: [{ sys_id: SOURCE_FLOW_ID, name: "S", type: "subflow", sys_scope: "old" }],
      },
      {
        match: function (t) { return t === "sys_hub_flow_input"; },
        rows: [{ sys_id: "i1", flow: SOURCE_FLOW_ID, sys_scope: "old" }],
      },
    ]);
    var result = await cloneSubflow({
      client: ctx.client,
      sourceSysId: SOURCE_FLOW_ID,
      newName: "Dry",
      newScope: NEW_SCOPE_ID,
      updateSetSysId: UPDATE_SET_ID,
      dryRun: true,
    });
    expect(ctx.cap.createRecordCalls).toHaveLength(0);
    expect(result.plan).toBeDefined();
    expect(result.plan!.length).toBeGreaterThan(0);
    expect(result.plan![0].id).toBe("parent");
  });

  it("applies modifications.description and fieldPatch on top of the cloned parent", async function () {
    var ctx = makeClient([
      {
        match: function (t, q) { return t === "sys_hub_flow" && q.indexOf("sys_id=") >= 0; },
        rows: [{ sys_id: SOURCE_FLOW_ID, name: "S", type: "subflow", sys_scope: "old", description: "old desc" }],
      },
    ]);
    await cloneSubflow({
      client: ctx.client,
      sourceSysId: SOURCE_FLOW_ID,
      newName: "Patched",
      newScope: NEW_SCOPE_ID,
      updateSetSysId: UPDATE_SET_ID,
      modifications: {
        description: "new desc",
        fieldPatch: { active: true },
      },
    });
    var parent = ctx.cap.createRecordCalls[0];
    expect(parent.fields.description).toBe("new desc");
    expect(parent.fields.active).toBe(true);
  });
});

describe("cloneActionType", function () {
  it("clones parent + inputs + outputs + step instances using model_id FK", async function () {
    var SOURCE_AT = "44444444444444444444444444444444";
    var ctx = makeClient([
      {
        match: function (t, q) { return t === "sys_hub_action_type_definition" && q.indexOf("sys_id=" + SOURCE_AT) >= 0; },
        rows: [{ sys_id: SOURCE_AT, name: "Get Audience Members", internal_name: "get_aud", sys_scope: "old", description: "" }],
      },
      // idempotency check - empty
      {
        match: function (t, q) { return t === "sys_hub_action_type_definition" && q.indexOf("name=Get Engaged") >= 0; },
        rows: [],
      },
      {
        match: function (t) { return t === "sys_hub_action_input"; },
        rows: [{ sys_id: "ai1", name: "Audience", model_id: SOURCE_AT, sys_scope: "old" }],
      },
      {
        match: function (t) { return t === "sys_hub_action_output"; },
        rows: [{ sys_id: "ao1", name: "Members", model_id: SOURCE_AT, sys_scope: "old" }],
      },
      {
        match: function (t) { return t === "sys_hub_step_instance"; },
        rows: [
          { sys_id: "s1", name: "Step1", model_id: SOURCE_AT, sys_scope: "old" },
          { sys_id: "s2", name: "Step2", model_id: SOURCE_AT, sys_scope: "old" },
        ],
      },
    ]);

    var result = await cloneActionType({
      client: ctx.client,
      sourceSysId: SOURCE_AT,
      newName: "Get Engaged Audience Members",
      newScope: NEW_SCOPE_ID,
      updateSetSysId: UPDATE_SET_ID,
    });

    expect(result.action).toBe("created");
    expect(ctx.cap.createRecordCalls).toHaveLength(5);
    expect(ctx.cap.createRecordCalls[0].table).toBe("sys_hub_action_type_definition");
    expect(ctx.cap.createRecordCalls[0].fields.name).toBe("Get Engaged Audience Members");

    // Children must FK back to the new parent via model_id (not the source sys_id).
    for (var i = 1; i < ctx.cap.createRecordCalls.length; i++) {
      expect(ctx.cap.createRecordCalls[i].fields.model_id).toBe(result.sysId);
      expect(ctx.cap.createRecordCalls[i].fields.sys_id).not.toBe(SOURCE_AT);
    }
  });

  it("short-circuits when name+scope already exists", async function () {
    var SOURCE_AT = "44444444444444444444444444444444";
    var ctx = makeClient([
      {
        match: function (t, q) { return t === "sys_hub_action_type_definition" && q.indexOf("name=Existing") >= 0; },
        rows: [{ sys_id: "abc12345abc12345abc12345abc12345" }],
      },
    ]);
    var result = await cloneActionType({
      client: ctx.client,
      sourceSysId: SOURCE_AT,
      newName: "Existing",
      newScope: NEW_SCOPE_ID,
      updateSetSysId: UPDATE_SET_ID,
    });
    expect(result.action).toBe("unchanged");
    expect(ctx.cap.createRecordCalls).toHaveLength(0);
  });
});
