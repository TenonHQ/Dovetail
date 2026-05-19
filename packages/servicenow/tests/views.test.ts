import { createView } from "../src/layout/views";
import { makeMockClient } from "./mockClient";

describe("createView", function () {
  it("rejects an empty name", async function () {
    var ctx = makeMockClient();
    await expect(createView(ctx.client, {
      name: "", updateSetSysId: "us1", scope: "x_cadso_automate"
    })).rejects.toThrow(/name is required/);
  });

  it("rejects an update set that is not in progress", async function () {
    var ctx = makeMockClient({
      query: async function (table: string) {
        if (table === "sys_update_set") {
          return [{ sys_id: "us1", name: "X", state: "complete" }];
        }
        return [];
      }
    });
    await expect(createView(ctx.client, {
      name: "sales_support", updateSetSysId: "us1", scope: "x_cadso_automate"
    })).rejects.toThrow(/in progress/);
  });

  it("creates a new view", async function () {
    var ctx = makeMockClient({
      query: async function (table: string) {
        if (table === "sys_ui_view") return [];
        if (table === "sys_update_set") {
          return [{ sys_id: "us1", name: "Work", state: "in progress" }];
        }
        return [];
      }
    });
    var result = await createView(ctx.client, {
      name: "sales_support", updateSetSysId: "us1", scope: "x_cadso_automate"
    });
    expect(ctx.calls.createRecord).toHaveLength(1);
    expect(ctx.calls.createRecord[0].table).toBe("sys_ui_view");
    expect(ctx.calls.createRecord[0].fields.name).toBe("sales_support");
    expect(ctx.calls.createRecord[0].update_set_sys_id).toBe("us1");
    expect(result.view.action).toBe("created");
  });

  it("is idempotent when the view already exists", async function () {
    var ctx = makeMockClient({
      query: async function (table: string) {
        if (table === "sys_ui_view") {
          return [{ sys_id: "v1", name: "sales_support" }];
        }
        if (table === "sys_update_set") {
          return [{ sys_id: "us1", name: "Work", state: "in progress" }];
        }
        return [];
      }
    });
    var result = await createView(ctx.client, {
      name: "sales_support", updateSetSysId: "us1", scope: "x_cadso_automate"
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(result.view.action).toBe("unchanged");
    expect(result.view.sysId).toBe("v1");
  });

  it("plans a create without writing under dryRun", async function () {
    var ctx = makeMockClient({
      query: async function (table: string) {
        if (table === "sys_ui_view") return [];
        if (table === "sys_update_set") {
          return [{ sys_id: "us1", name: "Work", state: "in progress" }];
        }
        return [];
      }
    });
    var result = await createView(ctx.client, {
      name: "sales_support", updateSetSysId: "us1", scope: "x_cadso_automate", dryRun: true
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(result.dryRun).toBe(true);
    expect(result.view.action).toBe("created");
  });
});
