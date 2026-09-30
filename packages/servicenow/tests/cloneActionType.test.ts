/**
 * cloneActionType — Table API reads only (buildAgent 401s on our instances),
 * multi-step record graph with the right FK columns, old→new step remap onto
 * the SOURCE's /step_instances graph, stepOps (incl. setStepInputs), dry-run by
 * default, idempotency, and publish + verify through the snapshot path.
 */

import { cloneActionType, slugInternalName } from "../src/flowDesigner/cloneActionType";
import {
  makeClient,
  SRC,
  SRC_SCOPE,
  TARGET_SCOPE,
  TARGET_SCOPE_NAME,
  US,
  S1,
  S2,
  EXT_IN_1,
  EXT_OUT_2,
} from "./cloneActionFixture";

function valueOf(v: unknown): unknown {
  if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "value")) {
    return (v as Record<string, unknown>).value;
  }
  return v;
}

describe("slugInternalName", function () {
  it("lowercases, maps non-alphanumerics to _ and trims", function () {
    expect(slugInternalName("  Send SMS (v2) — Retry!  ")).toBe("send_sms_v2_retry");
    expect(slugInternalName("Get Engaged Audience Members")).toBe("get_engaged_audience_members");
  });
});

describe("cloneActionType", function () {
  it("clones a multi-step graph with the right FK columns (step.action, ext.model_id → new step)", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client,
      sourceSysId: SRC,
      newName: "Send REST Copy",
      newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US,
      description: "cloned",
      confirm: true,
    });

    expect(res.action).toBe("created");
    expect(res.internalName).toBe("send_rest_copy");
    // parent + 1 in + 1 out + 2 steps + 1 ext in + 1 ext out
    expect(m.cap.creates).toHaveLength(7);

    var parent = m.cap.creates[0];
    expect(parent.table).toBe("sys_hub_action_type_definition");
    expect(parent.fields.sys_id).toBe(res.sysId);
    expect(parent.fields.name).toBe("Send REST Copy");
    expect(parent.fields.internal_name).toBe("send_rest_copy");
    expect(parent.fields.state).toBe("draft");
    expect(parent.fields.description).toBe("cloned");
    expect(parent.fields.sys_scope).toBe(TARGET_SCOPE);
    expect(parent.fields.sys_package).toBe(TARGET_SCOPE);
    expect(parent.fields.master_snapshot).toBeUndefined();
    expect(parent.fields.latest_snapshot).toBeUndefined();
    expect(parent.fields.sys_update_name).toBeUndefined();
    expect(parent.fields.copied_from).toBeUndefined();
    expect(parent.fields.sys_created_on).toBeUndefined();
    expect(parent.fields.sys_mod_count).toBeUndefined();

    // Every write: fresh sys_id, target scope NAME, pinned update set.
    m.cap.creates.forEach(function (c) {
      expect(c.scope).toBe(TARGET_SCOPE_NAME);
      expect(c.update_set_sys_id).toBe(US);
      expect(String(c.fields.sys_id)).toMatch(/^[0-9a-f]{32}$/);
      expect([SRC, S1, S2, EXT_IN_1, EXT_OUT_2]).not.toContain(c.fields.sys_id);
      expect(c.sys_id).toBe(c.fields.sys_id);
    });

    var byTable = function (t: string) {
      return m.cap.creates.filter(function (c) { return c.table === t; });
    };
    expect(byTable("sys_hub_action_input")[0].fields.model_id).toBe(res.sysId);
    expect(byTable("sys_hub_action_output")[0].fields.model_id).toBe(res.sysId);

    var steps = byTable("sys_hub_step_instance");
    expect(steps).toHaveLength(2);
    steps.forEach(function (s) {
      expect(s.fields.action).toBe(res.sysId);
      expect(s.fields.model_id).toBeUndefined();
    });

    var stepMap = res.plan ? res.plan.stepIdMap : {};
    var extIn = byTable("sys_hub_step_ext_input");
    var extOut = byTable("sys_hub_step_ext_output");
    expect(extIn).toHaveLength(1);
    expect(extOut).toHaveLength(1);
    expect(extIn[0].fields.model_id).toBe(stepMap[S1]);
    expect(extOut[0].fields.model_id).toBe(stepMap[S2]);
    // The ext row's parent step is written before it.
    var idxStep1 = m.cap.creates.findIndex(function (c) { return c.fields.sys_id === stepMap[S1]; });
    var idxExt1 = m.cap.creates.indexOf(extIn[0]);
    expect(idxStep1).toBeGreaterThanOrEqual(0);
    expect(idxStep1).toBeLessThan(idxExt1);

    expect(res.plan && res.plan.counts).toEqual({
      sys_hub_action_type_definition: 1,
      sys_hub_action_input: 1,
      sys_hub_action_output: 1,
      sys_hub_step_instance: 2,
      sys_hub_step_ext_input: 1,
      sys_hub_step_ext_output: 1,
    });
  });

  it("reads through the Table API only — never buildAgent", async function () {
    var m = makeClient();
    await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "X", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
    });
    expect(m.cap.buildAgentCalls).toBe(0);
    var tables = m.cap.tableQueries.map(function (q) { return q.table; });
    expect(tables).toContain("sys_hub_step_instance");
    expect(tables).toContain("sys_hub_step_ext_input");
    expect(tables).toContain("sys_hub_step_ext_output");
    // step instances are keyed by `action`, not model_id
    expect(m.cap.tableQueries).toContainEqual({ table: "sys_hub_step_instance", query: "action=" + SRC });
  });

  it("publishes the SOURCE step graph remapped onto the clone (action, sys_id, ext ids)", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Remap", newScope: TARGET_SCOPE,
      updateSetSysId: US, confirm: true,
    });
    var stepMap = res.plan ? res.plan.stepIdMap : {};

    // Source steps read under the SOURCE scope.
    expect(m.cap.gets).toContain(
      "/api/now/processflow/action/action_types/" + SRC + "/step_instances?sysparm_transaction_scope=" + SRC_SCOPE,
    );
    expect(m.cap.posts).toHaveLength(1);
    expect(m.cap.posts[0].path).toBe(
      "/api/now/processflow/action/action_types/" + res.sysId + "/snapshot?sysparm_transaction_scope=" + TARGET_SCOPE,
    );
    var published = m.cap.posts[0].body.steps as Array<Record<string, unknown>>;
    expect(published).toHaveLength(2);
    expect(valueOf(published[0].sys_id)).toBe(stepMap[S1]);
    expect(valueOf(published[1].sys_id)).toBe(stepMap[S2]);
    // wrapped shape preserved on the remap
    expect(published[0].sys_id).toEqual({ value: stepMap[S1] });
    published.forEach(function (s) {
      expect(valueOf(s.action)).toBe(res.sysId);
    });
    var extIn = (published[0].extended_inputs as Array<Record<string, unknown>>)[0];
    expect(extIn.model_id).toBe(stepMap[S1]);
    expect(extIn.sys_id).not.toBe(EXT_IN_1);
    expect(String(extIn.sys_id)).toMatch(/^[0-9a-f]{32}$/);

    // Update set pinned before the snapshot; verify read the clone back.
    expect(m.cap.updateSets).toEqual([US]);
    expect(res.publish && res.publish.status).toBe("published");
    expect(res.verify && res.verify.ok).toBe(true);
  });

  it("applies stepOps (setStepInputs + patchStepScripts) before publish", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "With Ops", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
      stepOps: {
        setStepInputs: [{ step: "REST Step", input: "http_method", value: "post" }],
        patchStepScripts: [{ step: "cid_script", patchScript: { find: "responseBody", replace: "rawBody" } }],
      },
    });
    var published = m.cap.posts[0].body.steps as Array<Record<string, unknown>>;
    var method = (published[0].inputs as Array<Record<string, unknown>>)[0];
    expect(method.value).toBe("post");
    expect(method.display_value).toBe("post");
    var script = (published[1].inputs as Array<Record<string, unknown>>)[0];
    expect(String(script.value)).toContain("inputs.rawBody");
    expect(res.steps && res.steps.touchedCids.sort()).toEqual(["cid_rest", "cid_script"]);
    expect(res.verify && res.verify.ok).toBe(true);
  });

  it("dry-run is the default: full plan, zero writes, zero publishes", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Dry", newScope: TARGET_SCOPE_NAME,
      stepOps: { setStepInputs: [{ step: "REST Step", input: "http_method", value: "put" }] },
    });
    expect(res.action).toBe("planned");
    expect(res.written).toEqual([]);
    expect(m.cap.creates).toHaveLength(0);
    expect(m.cap.posts).toHaveLength(0);
    expect(m.cap.updateSets).toHaveLength(0);
    expect(res.publish).toBeUndefined();
    expect(res.plan && res.plan.total).toBe(7);
    expect(res.plan && res.plan.scope).toEqual({ sysId: TARGET_SCOPE, name: TARGET_SCOPE_NAME });
    expect(res.steps && res.steps.before).toHaveLength(2);
    expect(res.steps && res.steps.changes.join(" ")).toMatch(/http_method' 'get' -> 'put'/);
  });

  it("confirm with dryRun:true still writes nothing", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Forced Dry", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true, dryRun: true,
    });
    expect(res.action).toBe("planned");
    expect(m.cap.creates).toHaveLength(0);
    expect(m.cap.posts).toHaveLength(0);
  });

  it("is idempotent: an existing (name, scope) returns unchanged with no writes", async function () {
    var m = makeClient({ existing: true });
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Already There", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
    });
    expect(res.action).toBe("unchanged");
    expect(res.sysId).toBe("e".repeat(32));
    expect(res.internalName).toBe("already_there");
    expect(m.cap.creates).toHaveLength(0);
    expect(m.cap.posts).toHaveLength(0);
    expect(m.cap.gets).toHaveLength(0);
    expect(m.cap.tableQueries).toContainEqual({
      table: "sys_hub_action_type_definition",
      query: "name=Already There^sys_scope=" + TARGET_SCOPE,
    });
  });

  it("requires an update set sys_id when confirmed", async function () {
    var m = makeClient();
    await expect(cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "No US", newScope: TARGET_SCOPE_NAME, confirm: true,
    })).rejects.toThrow(/updateSetSysId/);
    expect(m.cap.creates).toHaveLength(0);
  });

  it("honours an explicit internalName and rejects an unsafe one", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Named", internalName: "custom_internal",
      newScope: TARGET_SCOPE_NAME,
    });
    expect(res.internalName).toBe("custom_internal");
    expect(res.plan && res.plan.ops[0].fields.internal_name).toBe("custom_internal");
    await expect(cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Named", internalName: "bad name^x",
      newScope: TARGET_SCOPE_NAME,
    })).rejects.toThrow(/internalName/);
  });

  it("rejects a name that would inject into the encoded query", async function () {
    var m = makeClient();
    await expect(cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Evil^sys_scope!=x", newScope: TARGET_SCOPE_NAME,
    })).rejects.toThrow(/must not contain/);
    expect(m.cap.tableQueries).toHaveLength(0);
  });

  it("throws on an unknown scope and on a step op naming an unknown input", async function () {
    var m = makeClient();
    await expect(cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "S", newScope: "x_nope",
    })).rejects.toThrow(/sys_scope not found/);
    await expect(cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "S", newScope: TARGET_SCOPE_NAME,
      stepOps: { setStepInputs: [{ step: "REST Step", input: "no_such_input", value: "x" }] },
    })).rejects.toThrow(/input 'no_such_input' not found/);
    expect(m.cap.creates).toHaveLength(0);
  });

  it("publish:false writes the graph but skips the snapshot (orchestrator mode)", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "No Publish", newScope: TARGET_SCOPE,
      updateSetSysId: US, confirm: true, publish: false,
    });
    expect(res.action).toBe("created");
    expect(m.cap.creates).toHaveLength(7);
    expect(m.cap.posts).toHaveLength(0);
    expect(res.publish).toBeUndefined();
  });
});
