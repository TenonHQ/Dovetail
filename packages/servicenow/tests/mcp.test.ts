import { buildDescriptors, TOOL_NAMES } from "../src/mcp/registry";
import { runSmoke } from "../src/mcp/server";
import { makeMockClient } from "./mockClient";

var US = { sys_id: "us1", name: "Work", state: "in progress" };

describe("MCP registry", function () {
  it("registers exactly the 18 expected tools", function () {
    var names = buildDescriptors().map(function (d) { return d.name; });
    expect(names.slice().sort()).toEqual(
      [
        "action_view",
        "add_choices_to_field",
        "add_column",
        "create_record",
        "create_table",
        "create_view",
        "flow_copy",
        "flow_create",
        "flow_edit",
        "flow_publish",
        "flow_test",
        "flow_view",
        "host_assets",
        "invoke_rest",
        "set_column",
        "set_field",
        "set_form_layout",
        "set_list_layout",
        "set_related_lists"
      ]
    );
    expect(TOOL_NAMES).toHaveLength(19);
  });

  it("every descriptor has a non-trivial description and an input shape", function () {
    buildDescriptors().forEach(function (d) {
      expect(typeof d.description).toBe("string");
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.shape).toBeDefined();
    });
  });

  it("create_view handler runs the layout function against the injected client", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    var descriptors = buildDescriptors({ client: ctx.client });
    var createView = descriptors.filter(function (d) { return d.name === "create_view"; })[0];
    var result = await createView.handler({
      name: "sales_support",
      updateSetSysId: "us1",
      scope: "global"
    });
    expect(result.view.action).toBe("created");
    expect(ctx.calls.createRecord).toHaveLength(1);
    expect(ctx.calls.createRecord[0].table).toBe("sys_ui_view");
  });

  it("set_list_layout handler reconciles via the injected client", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    var descriptors = buildDescriptors({ client: ctx.client });
    var setList = descriptors.filter(function (d) { return d.name === "set_list_layout"; })[0];
    var result = await setList.handler({
      table: "x_cadso_automate_audience",
      columns: ["number", "name"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(result.dryRun).toBe(false);
    expect(ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_list_element"; }))
      .toHaveLength(2);
  });

  it("set_field handler writes via the injected client and verifies", async function () {
    var ctx = makeMockClient({
      query: async function (table: string, query?: string) {
        if (query === "sys_id=rec1") return [{ sys_id: "rec1", order: "20" }];
        return [];
      }
    });
    var descriptors = buildDescriptors({ client: ctx.client });
    var setFieldTool = descriptors.filter(function (d) { return d.name === "set_field"; })[0];
    var result = await setFieldTool.handler({
      table: "x_cadso_core_metric_point_type",
      sysId: "rec1",
      fields: { order: "20" },
      updateSetSysId: "us1"
    });
    expect(result.status).toBe("applied");
    expect(result.verified).toBe(true);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
    expect(ctx.calls.pushWithUpdateSet[0].record_sys_id).toBe("rec1");
  });

  it("create_record handler inserts via the injected client and verifies", async function () {
    var ctx = makeMockClient({
      query: async function (table: string, query?: string) {
        if (query === "sys_id=new_1") return [{ sys_id: "new_1", name: "avg_parts" }];
        return [];
      }
    });
    var descriptors = buildDescriptors({ client: ctx.client });
    var createRecordTool = descriptors.filter(function (d) { return d.name === "create_record"; })[0];
    var result = await createRecordTool.handler({
      table: "x_cadso_core_metric_point_type",
      fields: { name: "avg_parts" },
      scope: "x_cadso_core",
      updateSetSysId: "us1"
    });
    expect(result.status).toBe("created");
    expect(result.verified).toBe(true);
    expect(result.sysId).toBe("new_1");
    expect(ctx.calls.createRecord).toHaveLength(1);
    expect(ctx.calls.createRecord[0].scope).toBe("x_cadso_core");
  });

  it("invoke_rest handler is a dry-run by default — nothing is sent", async function () {
    var ctx = makeMockClient();
    var descriptors = buildDescriptors({ client: ctx.client });
    var invokeTool = descriptors.filter(function (d) { return d.name === "invoke_rest"; })[0];
    var result = await invokeTool.handler({
      method: "DELETE",
      path: "/api/x_cadso_core/testkit/resource/abc"
    });
    expect(result.status).toBe("dry-run");
    expect(ctx.calls.nowInvoke).toHaveLength(0);
  });

  it("invoke_rest handler sends via the injected client when confirm:true", async function () {
    var ctx = makeMockClient();
    var descriptors = buildDescriptors({ client: ctx.client });
    var invokeTool = descriptors.filter(function (d) { return d.name === "invoke_rest"; })[0];
    var result = await invokeTool.handler({
      method: "PUT",
      path: "/api/x_cadso_core/testkit/resource/abc",
      body: { name: "updated" },
      confirm: true
    });
    expect(result.status).toBe("sent");
    expect(result.httpStatus).toBe(200);
    expect(result.ok).toBe(true);
    expect(ctx.calls.nowInvoke).toHaveLength(1);
    expect(ctx.calls.nowInvoke[0]).toEqual({
      method: "PUT",
      path: "/api/x_cadso_core/testkit/resource/abc",
      body: { name: "updated" }
    });
  });

  it("invoke_rest accepts a lowercase method via the schema preprocess", async function () {
    var ctx = makeMockClient();
    var descriptors = buildDescriptors({ client: ctx.client });
    var invokeTool = descriptors.filter(function (d) { return d.name === "invoke_rest"; })[0];
    var result = await invokeTool.handler({
      method: "delete",
      path: "/api/x_cadso_core/testkit/resource/abc",
      confirm: true
    });
    expect(result.status).toBe("sent");
    expect(ctx.calls.nowInvoke[0].method).toBe("DELETE");
  });

  it("invoke_rest rejects a non-/api/ path via the zod schema", async function () {
    var descriptors = buildDescriptors();
    var invokeTool = descriptors.filter(function (d) { return d.name === "invoke_rest"; })[0];
    await expect(invokeTool.handler({ method: "GET", path: "https://evil.example/api/now" }))
      .rejects.toThrow();
  });

  it("rejects invalid args via the zod schema", async function () {
    var descriptors = buildDescriptors();
    var setList = descriptors.filter(function (d) { return d.name === "set_list_layout"; })[0];
    await expect(setList.handler({ table: "x", columns: [], updateSetSysId: "u" }))
      .rejects.toThrow();
  });

  it("runSmoke lists every registered tool", async function () {
    var out = "";
    var spy = jest.spyOn(process.stdout, "write").mockImplementation((function (s: any) {
      out += String(s);
      return true;
    }) as any);
    await runSmoke();
    spy.mockRestore();
    expect(out).toContain("Registered tools (19)");
    expect(out).toContain("set_form_layout");
    expect(out).toContain("add_choices_to_field");
    expect(out).toContain("flow_view");
    expect(out).toContain("flow_test");
    expect(out).toContain("flow_edit");
    expect(out).toContain("flow_copy");
    expect(out).toContain("set_field");
    expect(out).toContain("create_record");
    expect(out).toContain("invoke_rest");
  });
});

describe("MCP registry — annotations", function () {
  var readTools = ["flow_view", "action_view"];

  function byName(): Record<string, any> {
    var map: Record<string, any> = {};
    buildDescriptors().forEach(function (d) {
      map[d.name] = d;
    });
    return map;
  }

  it("every descriptor carries an annotations object", function () {
    buildDescriptors().forEach(function (d) {
      expect(typeof d.annotations).toBe("object");
      expect(d.annotations).not.toBeNull();
    });
  });

  it("read tools are marked readOnlyHint:true", function () {
    var map = byName();
    readTools.forEach(function (name) {
      expect(map[name].annotations.readOnlyHint).toBe(true);
    });
  });

  it("write tools carry the right destructive/idempotent hints", function () {
    var map = byName();

    // additive, idempotent upserts/creates
    ["create_view", "add_choices_to_field"].forEach(function (name) {
      expect(map[name].annotations.readOnlyHint).toBe(false);
      expect(map[name].annotations.destructiveHint).toBe(false);
      expect(map[name].annotations.idempotentHint).toBe(true);
    });

    // destructive-but-idempotent overwrites (prune/recompile/in-place edit/scalar set)
    ["set_list_layout", "set_form_layout", "set_related_lists", "flow_publish", "flow_edit", "host_assets", "set_field", "set_column"].forEach(function (name) {
      expect(map[name].annotations.readOnlyHint).toBe(false);
      expect(map[name].annotations.destructiveHint).toBe(true);
      expect(map[name].annotations.idempotentHint).toBe(true);
    });

    // additive, non-idempotent creates (each call mints a new flow / record)
    ["flow_copy", "flow_create", "create_record"].forEach(function (name) {
      expect(map[name].annotations.readOnlyHint).toBe(false);
      expect(map[name].annotations.destructiveHint).toBe(false);
      expect(map[name].annotations.idempotentHint).toBe(false);
    });

    // destructive AND non-idempotent (execute mode can fire a flow / send;
    // invoke_rest can drive arbitrary PUT/DELETE operations)
    ["flow_test", "invoke_rest"].forEach(function (name) {
      expect(map[name].annotations.readOnlyHint).toBe(false);
      expect(map[name].annotations.destructiveHint).toBe(true);
      expect(map[name].annotations.idempotentHint).toBe(false);
    });
  });
});
