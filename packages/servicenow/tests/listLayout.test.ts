import { setListLayout } from "../src/layout/listLayout";
import { makeMockClient } from "./mockClient";

var US = { sys_id: "us1", name: "Work", state: "in progress" };

function elementRow(sysId: string, element: string, position: number) {
  return { sys_id: sysId, element: element, position: String(position) };
}

function globalList() {
  return { sys_id: "list1", view: "", parent: "", sys_user: "" };
}

describe("setListLayout", function () {
  it("rejects an empty columns array", async function () {
    var ctx = makeMockClient();
    await expect(setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: [],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    })).rejects.toThrow(/columns must be a non-empty array/);
  });

  it("rejects an update set that is not in progress", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [{ sys_id: "us1", name: "Done", state: "complete" }];
        return [];
      }
    });
    await expect(setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: ["number"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    })).rejects.toThrow(/in progress/);
  });

  it("creates the list and all columns from scratch", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    var result = await setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: ["number", "name", "state"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(result.dryRun).toBe(false);
    expect(result.view).toBe("");
    var listCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_list"; });
    var colCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_list_element"; });
    expect(listCreates).toHaveLength(1);
    expect(listCreates[0].fields.name).toBe("x_cadso_automate_audience");
    expect(listCreates[0].update_set_sys_id).toBe("us1");
    expect(colCreates.map(function (c) { return c.fields.element; })).toEqual(["number", "name", "state"]);
    expect(colCreates.map(function (c) { return c.fields.position; })).toEqual(["0", "1", "2"]);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });

  it("is idempotent — re-running an existing layout writes nothing", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_list") return [globalList()];
        if (table === "sys_ui_list_element") return [elementRow("e0", "number", 0), elementRow("e1", "name", 1)];
        return [];
      }
    });
    var result = await setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: ["number", "name"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(result.records.every(function (r) { return r.action === "unchanged"; })).toBe(true);
  });

  it("repositions a moved column", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_list") return [globalList()];
        if (table === "sys_ui_list_element") return [elementRow("e0", "number", 0), elementRow("e1", "name", 1)];
        return [];
      }
    });
    await setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: ["name", "number"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(2);
    expect(ctx.calls.pushWithUpdateSet[0].table).toBe("sys_ui_list_element");
    expect(ctx.calls.deleteRecord).toHaveLength(0);
  });

  it("prunes a removed column and pins the update set before deleting", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_list") return [globalList()];
        if (table === "sys_ui_list_element") return [elementRow("e0", "number", 0), elementRow("e1", "stale", 1)];
        return [];
      }
    });
    var result = await setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: ["number"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    expect(ctx.calls.deleteRecord).toHaveLength(1);
    expect(ctx.calls.deleteRecord[0].sys_id).toBe("e1");
    expect(ctx.calls.changeUpdateSet).toEqual([{ sysId: "us1" }]);
    expect(result.records.filter(function (r) { return r.action === "deleted"; })).toHaveLength(1);
  });

  it("keeps a removed column when prune is false", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        if (table === "sys_ui_list") return [globalList()];
        if (table === "sys_ui_list_element") return [elementRow("e0", "number", 0), elementRow("e1", "extra", 1)];
        return [];
      }
    });
    await setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: ["number"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
      prune: false
    });
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(ctx.calls.changeUpdateSet).toHaveLength(0);
  });

  it("dryRun plans the layout without writing", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    var result = await setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: ["number", "name"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
      dryRun: true
    });
    expect(result.dryRun).toBe(true);
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(ctx.calls.deleteRecord).toHaveLength(0);
    expect(result.records.filter(function (r) { return r.action === "created"; }).length).toBeGreaterThan(0);
  });

  it("dedupes repeated columns", async function () {
    var ctx = makeMockClient({
      query: async function (table) {
        if (table === "sys_update_set") return [US];
        return [];
      }
    });
    await setListLayout(ctx.client, {
      table: "x_cadso_automate_audience",
      columns: ["number", "name", "number"],
      updateSetSysId: "us1",
      scope: "x_cadso_automate"
    });
    var colCreates = ctx.calls.createRecord.filter(function (c) { return c.table === "sys_ui_list_element"; });
    expect(colCreates.map(function (c) { return c.fields.element; })).toEqual(["number", "name"]);
  });
});
