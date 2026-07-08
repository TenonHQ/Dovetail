import {
  encodeQueryValue,
  normalizeViewValue,
  diffChildren,
  assertUpdateSet,
  resolveScope,
  resolveView,
} from "../src/layout/layoutCommon";
import type { ExistingChild } from "../src/layout/layoutCommon";
import { makeMockClient } from "./mockClient";

describe("encodeQueryValue", function () {
  it("passes clean values through", function () {
    expect(encodeQueryValue("x_cadso_automate_audience")).toBe(
      "x_cadso_automate_audience",
    );
  });
  it("throws on comma, caret, or equals", function () {
    expect(function () {
      encodeQueryValue("a,b");
    }).toThrow(/Invalid character/);
    expect(function () {
      encodeQueryValue("a^b");
    }).toThrow(/Invalid character/);
    expect(function () {
      encodeQueryValue("a=b");
    }).toThrow(/Invalid character/);
  });
});

describe("normalizeViewValue", function () {
  it("maps the Default-view sentinel and empties to ''", function () {
    expect(normalizeViewValue("Default view")).toBe("");
    expect(normalizeViewValue("")).toBe("");
    expect(normalizeViewValue(null)).toBe("");
    expect(normalizeViewValue({ value: "" })).toBe("");
  });
  it("returns a real view value", function () {
    expect(normalizeViewValue("sales_support")).toBe("sales_support");
    expect(normalizeViewValue({ value: "v1" })).toBe("v1");
  });
});

describe("diffChildren", function () {
  function ex(key: string, position: number, sysId?: string): ExistingChild {
    return { key: key, position: position, sysId: sysId || key + "_id" };
  }

  it("creates all when nothing exists", function () {
    var plan = diffChildren(["a", "b", "c"], [], true);
    expect(
      plan.map(function (p) {
        return p.action;
      }),
    ).toEqual(["create", "create", "create"]);
    expect(
      plan.map(function (p) {
        return p.position;
      }),
    ).toEqual([0, 1, 2]);
  });

  it("reports unchanged when existing matches the desired order", function () {
    var plan = diffChildren(["a", "b"], [ex("a", 0), ex("b", 1)], true);
    expect(
      plan.map(function (p) {
        return p.action;
      }),
    ).toEqual(["unchanged", "unchanged"]);
  });

  it("updates position when the order changed", function () {
    var plan = diffChildren(["b", "a"], [ex("a", 0), ex("b", 1)], true);
    expect(plan[0]).toMatchObject({ action: "update", key: "b", position: 0 });
    expect(plan[1]).toMatchObject({ action: "update", key: "a", position: 1 });
  });

  it("deletes extras when prune is true", function () {
    var plan = diffChildren(["a"], [ex("a", 0), ex("old", 1)], true);
    var del = plan.filter(function (p) {
      return p.action === "delete";
    });
    expect(del).toHaveLength(1);
    expect(del[0].key).toBe("old");
  });

  it("keeps and repositions extras when prune is false", function () {
    var plan = diffChildren(["a"], [ex("a", 0), ex("old", 1)], false);
    expect(
      plan.filter(function (p) {
        return p.action === "delete";
      }),
    ).toHaveLength(0);
    var old = plan.filter(function (p) {
      return p.key === "old";
    })[0];
    expect(old.position).toBe(1);
  });

  it("mixes unchanged + create + delete", function () {
    var plan = diffChildren(["a", "new"], [ex("a", 0), ex("gone", 1)], true);
    expect(plan[0]).toMatchObject({ action: "unchanged", key: "a" });
    expect(plan[1]).toMatchObject({
      action: "create",
      key: "new",
      position: 1,
    });
    expect(plan[2]).toMatchObject({ action: "delete", key: "gone" });
  });
});

describe("assertUpdateSet", function () {
  it("rejects an empty sys_id", async function () {
    var ctx = makeMockClient();
    await expect(assertUpdateSet(ctx.client, "")).rejects.toThrow(
      /updateSetSysId is required/,
    );
  });
  it("rejects a missing update set", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    await expect(assertUpdateSet(ctx.client, "us1")).rejects.toThrow(
      /not found/,
    );
  });
  it("rejects an update set that is not in progress", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [{ sys_id: "us1", name: "Done", state: "complete" }];
      },
    });
    await expect(assertUpdateSet(ctx.client, "us1")).rejects.toThrow(
      /in progress/,
    );
  });
  it("returns the ref for an in-progress update set", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [{ sys_id: "us1", name: "Work", state: "in progress" }];
      },
    });
    expect(await assertUpdateSet(ctx.client, "us1")).toEqual({
      sysId: "us1",
      name: "Work",
    });
  });
});

describe("resolveScope", function () {
  it("returns the explicit scope without querying", async function () {
    var ctx = makeMockClient();
    var scope = await resolveScope(
      ctx.client,
      "x_cadso_automate_audience",
      "x_cadso_automate",
    );
    expect(scope).toBe("x_cadso_automate");
    expect(ctx.calls.tableQuery).toHaveLength(0);
  });
  it("resolves the scope from sys_db_object -> sys_scope", async function () {
    var ctx = makeMockClient({
      query: async function (table: string) {
        if (table === "sys_db_object")
          return [{ sys_scope: { value: "scope1" } }];
        if (table === "sys_scope")
          return [{ scope: "x_cadso_automate", name: "Tenon" }];
        return [];
      },
    });
    expect(await resolveScope(ctx.client, "x_cadso_automate_audience")).toBe(
      "x_cadso_automate",
    );
  });
  it("falls back to global when the table has no scope", async function () {
    var ctx = makeMockClient({
      query: async function (table: string) {
        if (table === "sys_db_object") return [{ sys_scope: "" }];
        return [];
      },
    });
    expect(await resolveScope(ctx.client, "incident")).toBe("global");
  });
});

describe("resolveView", function () {
  it("resolves an empty name to the Default view", async function () {
    var ctx = makeMockClient();
    var v = await resolveView(ctx.client, {
      viewName: "",
      updateSetSysId: "us1",
      scope: "global",
      dryRun: false,
    });
    expect(v).toEqual({ sysId: "", name: "", action: "unchanged" });
    expect(ctx.calls.tableQuery).toHaveLength(0);
  });
  it("returns an existing view without creating it", async function () {
    var ctx = makeMockClient({
      query: async function (table: string) {
        if (table === "sys_ui_view")
          return [{ sys_id: "v1", name: "sales_support" }];
        return [];
      },
    });
    var v = await resolveView(ctx.client, {
      viewName: "sales_support",
      updateSetSysId: "us1",
      scope: "global",
      dryRun: false,
    });
    expect(v).toEqual({
      sysId: "v1",
      name: "sales_support",
      action: "unchanged",
    });
    expect(ctx.calls.createRecord).toHaveLength(0);
  });
  it("creates a missing view", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    var v = await resolveView(ctx.client, {
      viewName: "sales_support",
      updateSetSysId: "us1",
      scope: "x_cadso_automate",
      dryRun: false,
    });
    expect(v.action).toBe("created");
    expect(v.name).toBe("sales_support");
    expect(ctx.calls.createRecord).toHaveLength(1);
    expect(ctx.calls.createRecord[0].table).toBe("sys_ui_view");
    expect(ctx.calls.createRecord[0].update_set_sys_id).toBe("us1");
  });
  it("plans a create without writing under dryRun", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [];
      },
    });
    var v = await resolveView(ctx.client, {
      viewName: "sales_support",
      updateSetSysId: "us1",
      scope: "global",
      dryRun: true,
    });
    expect(v).toEqual({ sysId: "", name: "sales_support", action: "created" });
    expect(ctx.calls.createRecord).toHaveLength(0);
  });
});
