/**
 * cloneActionType — Table API reads only (buildAgent 401s on our instances),
 * multi-step record graph with the right FK columns, old→new step remap onto
 * the SOURCE's /step_instances graph, stepOps (incl. setStepInputs), dry-run by
 * default, idempotency, and publish + verify through the snapshot path.
 */

import {
  cloneActionType,
  remapClonedSteps,
  slugInternalName,
  verifyOutputMappings,
} from "../src/flowDesigner/cloneActionType";
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
  PILL_STATUS_CODE,
  ACTION_STATUS_JSON,
  MAP_1,
  MAP_2,
  MAP_3,
  DOC_IN,
  DOC_OUT,
  EXISTING_TARGET_DOC,
  varTable,
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

describe("remapClonedSteps — live /step_instances shape", function () {
  // Shape captured from tenonworkstudio 2026-09-30: the record id is `step_id`,
  // there is NO `sys_id` key, and pills reference steps by `cid` (kept as-is).
  var OLD_GUARD = "9d923813c3674f10d4ddf1db05013116";
  var OLD_REST = "99923813c3674f10d4ddf1db05013132";
  var NEW_GUARD = "a".repeat(32);
  var NEW_REST = "b".repeat(32);
  var NEW_PARENT = "c".repeat(32);
  function liveSteps(): Array<Record<string, unknown>> {
    return [
      { label: "Gaurd", step_id: OLD_GUARD, action: "69b1b09fc3274f10d4ddf1db05013193", cid: "777e0dc1", order: 1, inputs: [] },
      {
        label: "REST step",
        step_id: OLD_REST,
        action: "69b1b09fc3274f10d4ddf1db05013193",
        cid: "7d49315c",
        order: 2,
        inputs: [{ name: "base_url", value: "{{step[777e0dc1].base_url}}" }],
      },
    ];
  }

  it("remaps step_id and action onto the clone, leaving cid and pills untouched", function () {
    var map: Record<string, string> = {};
    map[OLD_GUARD] = NEW_GUARD;
    map[OLD_REST] = NEW_REST;
    var out = remapClonedSteps(liveSteps() as never, NEW_PARENT, map, {});
    expect(out[0].step_id).toBe(NEW_GUARD);
    expect(out[1].step_id).toBe(NEW_REST);
    expect(out[0].action).toBe(NEW_PARENT);
    expect(out[1].cid).toBe("7d49315c");
    expect((out[1].inputs as Array<Record<string, unknown>>)[0].value).toBe("{{step[777e0dc1].base_url}}");
    expect(Object.prototype.hasOwnProperty.call(out[0], "sys_id")).toBe(false);
  });

  it("still throws, naming the step, when a step_id has no cloned counterpart", function () {
    expect(function () {
      remapClonedSteps(liveSteps() as never, NEW_PARENT, {}, {});
    }).toThrow(/Gaurd.*9d923813c3674f10d4ddf1db05013116.*no cloned/);
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
    // parent + 1 in + 1 out + 2 steps + 1 ext in + 1 ext out + 3 output mappings + 2 labels
    expect(m.cap.creates).toHaveLength(12);

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
      sys_element_mapping: 3,
      sys_documentation: 2,
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
    expect(res.plan && res.plan.total).toBe(12);
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
    expect(m.cap.creates).toHaveLength(12);
    expect(m.cap.posts).toHaveLength(0);
    expect(res.publish).toBeUndefined();
  });
});

describe("cloneActionType — output mappings, labels, var__m names", function () {
  function byTable(creates: Array<{ table: string; fields: Record<string, unknown> }>, t: string) {
    return creates.filter(function (c) { return c.table === t; });
  }

  it("clones every sys_element_mapping row onto the clone's var__m output table, field + pill unchanged", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Mapped", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
    });
    expect(m.cap.tableQueries).toContainEqual({
      table: "sys_element_mapping",
      query: "id=" + SRC + "^tableSTARTSWITHvar__m_sys_hub_action_output_",
    });
    var maps = byTable(m.cap.creates, "sys_element_mapping");
    expect(maps).toHaveLength(3);
    var newTable = varTable("sys_hub_action_output", res.sysId);
    var byField: Record<string, Record<string, unknown>> = {};
    maps.forEach(function (c) {
      expect(c.fields.id).toBe(res.sysId);
      expect(c.fields.table).toBe(newTable);
      expect(String(c.fields.sys_id)).toMatch(/^[0-9a-f]{32}$/);
      expect([MAP_1, MAP_2, MAP_3]).not.toContain(c.fields.sys_id);
      expect(c.fields.sys_mod_count).toBeUndefined();
      byField[String(c.fields.field)] = c.fields;
    });
    expect(byField.status_code.value).toBe(PILL_STATUS_CODE);
    expect(byField.__action_status__.value).toBe(ACTION_STATUS_JSON);
    expect(JSON.parse(String(byField.__action_status__.value)).code).toBe(PILL_STATUS_CODE);
    expect(byField.__dont_treat_as_error__.value).toBe("false");

    // Scoped + pinned like every other write, and written after the parent and its output row.
    var mapCreates = m.cap.creates.filter(function (c) { return c.table === "sys_element_mapping"; });
    mapCreates.forEach(function (c) {
      expect(c.scope).toBe(TARGET_SCOPE_NAME);
      expect(c.update_set_sys_id).toBe(US);
    });
    var idxParent = m.cap.creates.findIndex(function (c) { return c.table === "sys_hub_action_type_definition"; });
    var idxOutput = m.cap.creates.findIndex(function (c) { return c.table === "sys_hub_action_output"; });
    var idxStatusMap = m.cap.creates.findIndex(function (c) {
      return c.table === "sys_element_mapping" && c.fields.field === "status_code";
    });
    expect(idxParent).toBeLessThan(idxStatusMap);
    expect(idxOutput).toBeLessThan(idxStatusMap);
    var statusOp = res.plan ? res.plan.ops.filter(function (o) {
      return o.table === "sys_element_mapping" && o.fields.field === "status_code";
    })[0] : undefined;
    expect(statusOp && statusOp.dependsOn).toEqual(["parent", "output:0"]);
  });

  it("rewrites `name` on cloned IO rows to the clone's var__m tables (never the source's)", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Named IO", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
    });
    var stepMap = res.plan ? res.plan.stepIdMap : {};
    var input = byTable(m.cap.creates, "sys_hub_action_input")[0];
    var output = byTable(m.cap.creates, "sys_hub_action_output")[0];
    var extOut = byTable(m.cap.creates, "sys_hub_step_ext_output")[0];
    expect(input.fields.name).toBe(varTable("sys_hub_action_input", res.sysId));
    expect(output.fields.name).toBe(varTable("sys_hub_action_output", res.sysId));
    expect(extOut.fields.name).toBe(varTable("sys_hub_step_ext_output", stepMap[S2]));
    // Labels on the dictionary rows themselves carry over as-is.
    expect(input.fields.label).toBe("Endpoint");
    expect(output.fields.label).toBe("Status Code");
    m.cap.creates.forEach(function (c) {
      expect(String(c.fields.name || "")).not.toContain(SRC);
      expect(String(c.fields.table || "")).not.toContain(SRC);
    });
  });

  it("clones IO label rows (sys_documentation) retargeted to the new var__m tables", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Labelled", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
    });
    expect(m.cap.tableQueries).toContainEqual({
      table: "sys_documentation", query: "name=" + varTable("sys_hub_action_input", SRC),
    });
    expect(m.cap.tableQueries).toContainEqual({
      table: "sys_documentation", query: "name=" + varTable("sys_hub_action_output", SRC),
    });
    var docs = byTable(m.cap.creates, "sys_documentation");
    expect(docs).toHaveLength(2);
    var inDoc = docs.filter(function (d) { return d.fields.element === "endpoint"; })[0];
    var outDoc = docs.filter(function (d) { return d.fields.element === "status_code"; })[0];
    expect(inDoc.fields.name).toBe(varTable("sys_hub_action_input", res.sysId));
    expect(inDoc.fields.label).toBe("Endpoint");
    expect(inDoc.fields.language).toBe("en");
    expect(outDoc.fields.name).toBe(varTable("sys_hub_action_output", res.sysId));
    expect(outDoc.fields.label).toBe("Status Code");
    expect(outDoc.fields.plural).toBe("Status Codes");
    expect(outDoc.fields.sys_scope).toBe(TARGET_SCOPE);
    [inDoc, outDoc].forEach(function (d) {
      expect([DOC_IN, DOC_OUT]).not.toContain(d.fields.sys_id);
    });
    var docCreates = m.cap.creates.filter(function (c) { return c.table === "sys_documentation"; });
    docCreates.forEach(function (c) {
      expect(c.scope).toBe(TARGET_SCOPE_NAME);
      expect(c.update_set_sys_id).toBe(US);
    });
    // Labels are written after every IO row.
    var lastIo = Math.max(
      m.cap.creates.findIndex(function (c) { return c.table === "sys_hub_action_input"; }),
      m.cap.creates.findIndex(function (c) { return c.table === "sys_hub_action_output"; }),
    );
    expect(m.cap.creates.indexOf(docCreates[0])).toBeGreaterThan(lastIo);
    expect(res.plan && res.plan.labelOpIds.sort()).toEqual(["label:input:0", "label:output:0"]);
    var labelResults = res.written.filter(function (w) { return w.table === "sys_documentation"; });
    expect(labelResults.map(function (w) { return w.action; })).toEqual(["created", "created"]);
  });

  it("updates the target label row instead of duplicating it when the platform already made one", async function () {
    var m = makeClient({ existingTargetLabel: true });
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Upsert", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
    });
    var docCreates = byTable(m.cap.creates, "sys_documentation");
    expect(docCreates).toHaveLength(1);
    expect(docCreates[0].fields.element).toBe("status_code");
    expect(m.cap.pushes).toHaveLength(1);
    expect(m.cap.pushes[0].table).toBe("sys_documentation");
    expect(m.cap.pushes[0].record_sys_id).toBe(EXISTING_TARGET_DOC);
    expect(m.cap.pushes[0].update_set_sys_id).toBe(US);
    expect(m.cap.pushes[0].fields.label).toBe("Endpoint");
    expect(m.cap.pushes[0].fields.name).toBe(varTable("sys_hub_action_input", res.sysId));
    expect(m.cap.pushes[0].fields.sys_id).toBeUndefined();
    var updated = res.written.filter(function (w) { return w.action === "updated"; });
    expect(updated).toHaveLength(1);
    expect(updated[0].sysId).toBe(EXISTING_TARGET_DOC);
  });

  it("dry-run plans the mappings + labels but makes zero writes", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Dry Map", newScope: TARGET_SCOPE_NAME,
    });
    expect(res.action).toBe("planned");
    expect(m.cap.creates).toHaveLength(0);
    expect(m.cap.pushes).toHaveLength(0);
    expect(m.cap.posts).toHaveLength(0);
    expect(m.cap.updateSets).toHaveLength(0);
    expect(res.plan && res.plan.counts.sys_element_mapping).toBe(3);
    expect(res.plan && res.plan.counts.sys_documentation).toBe(2);
    var planned = res.plan ? res.plan.ops.filter(function (o) { return o.table === "sys_element_mapping"; }) : [];
    expect(planned.map(function (o) { return o.fields.field; }).sort()).toEqual(
      ["__action_status__", "__dont_treat_as_error__", "status_code"],
    );
    planned.forEach(function (o) {
      expect(o.fields.table).toBe(varTable("sys_hub_action_output", res.sysId));
      expect(o.fields.id).toBe(res.sysId);
      expect(o.scope).toBe(TARGET_SCOPE_NAME);
    });
  });

  it("verify passes when every source output mapping is read back on the clone", async function () {
    var m = makeClient();
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Verified", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
    });
    expect(m.cap.tableQueries).toContainEqual({
      table: "sys_element_mapping",
      query: "id=" + res.sysId + "^tableSTARTSWITHvar__m_sys_hub_action_output_",
    });
    expect(res.verify && res.verify.ok).toBe(true);
    expect(res.verify && res.verify.notes.join(" ")).toMatch(/all 3 output mapping\(s\) present/);
  });

  it("verify fails when a source output mapping is missing on the clone", async function () {
    var m = makeClient({ dropMappingOnReadback: "__action_status__" });
    var res = await cloneActionType({
      client: m.client, sourceSysId: SRC, newName: "Lost Map", newScope: TARGET_SCOPE_NAME,
      updateSetSysId: US, confirm: true,
    });
    expect(res.action).toBe("created");
    expect(res.verify && res.verify.ok).toBe(false);
    expect(res.verify && res.verify.notes.join(" ")).toMatch(/1 output mapping\(s\) missing.*__action_status__/);
  });

  it("verifyOutputMappings: missing fails, a differing value is noted only", function () {
    var src = [
      { field: "status_code", value: PILL_STATUS_CODE },
      { field: "__action_status__", value: ACTION_STATUS_JSON },
    ];
    var ok = verifyOutputMappings(src, [
      { field: "status_code", value: PILL_STATUS_CODE },
      { field: "__action_status__", value: "{}" },
    ]);
    expect(ok.ok).toBe(true);
    expect(ok.notes.join(" ")).toMatch(/'__action_status__' differs/);
    var missing = verifyOutputMappings(src, [{ field: "status_code", value: PILL_STATUS_CODE }]);
    expect(missing.ok).toBe(false);
    expect(verifyOutputMappings(src, []).ok).toBe(false);
    expect(verifyOutputMappings([], []).ok).toBe(true);
  });
});
