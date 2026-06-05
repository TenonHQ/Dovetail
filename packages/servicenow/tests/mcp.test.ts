import { buildDescriptors, TOOL_NAMES } from "../src/mcp/registry";
import { runSmoke } from "../src/mcp/server";
import { makeMockClient } from "./mockClient";

var US = { sys_id: "us1", name: "Work", state: "in progress" };

describe("MCP registry", function () {
  it("registers exactly the 12 expected tools", function () {
    var names = buildDescriptors().map(function (d) { return d.name; });
    expect(names.slice().sort()).toEqual(
      [
        "action_view",
        "add_choices_to_field",
        "create_view",
        "flow_copy",
        "flow_create",
        "flow_edit",
        "flow_publish",
        "flow_test",
        "flow_view",
        "set_form_layout",
        "set_list_layout",
        "set_related_lists"
      ]
    );
    expect(TOOL_NAMES).toHaveLength(12);
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
    expect(out).toContain("Registered tools (12)");
    expect(out).toContain("set_form_layout");
    expect(out).toContain("add_choices_to_field");
    expect(out).toContain("flow_view");
    expect(out).toContain("flow_test");
    expect(out).toContain("flow_edit");
    expect(out).toContain("flow_copy");
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

    // destructive-but-idempotent overwrites (prune/recompile/in-place edit)
    ["set_list_layout", "set_form_layout", "set_related_lists", "flow_publish", "flow_edit"].forEach(function (name) {
      expect(map[name].annotations.readOnlyHint).toBe(false);
      expect(map[name].annotations.destructiveHint).toBe(true);
      expect(map[name].annotations.idempotentHint).toBe(true);
    });

    // additive, non-idempotent creates (each call mints a new flow)
    ["flow_copy", "flow_create"].forEach(function (name) {
      expect(map[name].annotations.readOnlyHint).toBe(false);
      expect(map[name].annotations.destructiveHint).toBe(false);
      expect(map[name].annotations.idempotentHint).toBe(false);
    });

    // destructive AND non-idempotent (execute mode can fire a flow / send)
    expect(map["flow_test"].annotations.readOnlyHint).toBe(false);
    expect(map["flow_test"].annotations.destructiveHint).toBe(true);
    expect(map["flow_test"].annotations.idempotentHint).toBe(false);
  });
});
