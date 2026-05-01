import {
  generateSysId,
  stripSystemFields,
  applyScope,
  assertSysId,
  SYSTEM_FIELDS_TO_STRIP,
} from "../src/flowDesigner/shape";
import { topoSort, executeWritePlan, WriteOrderError } from "../src/flowDesigner/writeOrder";
import type { WriteOp } from "../src/flowDesigner/writeOrder";
import type { ServiceNowClient } from "../src/client";

describe("shape utilities", function () {
  describe("generateSysId", function () {
    it("emits 32 lowercase hex chars", function () {
      var id = generateSysId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });
    it("does not collide across 1000 calls", function () {
      var seen: Record<string, true> = {};
      for (var i = 0; i < 1000; i++) {
        var id = generateSysId();
        expect(seen[id]).toBeUndefined();
        seen[id] = true;
      }
    });
  });

  describe("stripSystemFields", function () {
    it("drops every SN-managed metadata field", function () {
      var input: Record<string, any> = {
        sys_id: "keep_this",
        name: "n",
        active: true,
      };
      SYSTEM_FIELDS_TO_STRIP.forEach(function (k) { input[k] = "drop"; });
      var out = stripSystemFields(input);
      expect(out.sys_id).toBe("keep_this");
      expect(out.name).toBe("n");
      expect(out.active).toBe(true);
      SYSTEM_FIELDS_TO_STRIP.forEach(function (k) {
        expect((out as Record<string, unknown>)[k]).toBeUndefined();
      });
    });
    it("does not mutate the input", function () {
      var input = { sys_created_on: "x", name: "n" };
      stripSystemFields(input);
      expect(input.sys_created_on).toBe("x");
    });
  });

  describe("assertSysId", function () {
    var SYS = "deadbeef12345678deadbeef12345678";
    it("accepts 32-char lowercase hex", function () {
      expect(function () { assertSysId(SYS, "x"); }).not.toThrow();
    });
    it("rejects uppercase hex", function () {
      expect(function () { assertSysId(SYS.toUpperCase(), "x"); }).toThrow(/x must be a 32-char/);
    });
    it("rejects too short", function () {
      expect(function () { assertSysId("abc", "x"); }).toThrow(/32-char/);
    });
    it("rejects non-string", function () {
      expect(function () { assertSysId(123 as any, "x"); }).toThrow(/32-char/);
    });
  });

  describe("applyScope", function () {
    var SCOPE = "abcdef1234567890abcdef1234567890";
    it("updates sys_scope and application when present", function () {
      var out = applyScope({ sys_scope: "old", application: "old", name: "n" } as any, SCOPE);
      expect(out.sys_scope).toBe(SCOPE);
      expect(out.application).toBe(SCOPE);
      expect(out.name).toBe("n");
    });
    it("leaves records without these fields unchanged", function () {
      var out = applyScope({ name: "n" } as any, SCOPE);
      expect(out).toEqual({ name: "n" });
    });
    it("rejects bad scope sys_id", function () {
      expect(function () { applyScope({ sys_scope: "old" } as any, "bad"); }).toThrow(/scopeSysId/);
    });
  });
});

describe("topoSort", function () {
  it("respects single-chain dependency order", function () {
    var ops: Array<WriteOp> = [
      { id: "c", logicalName: "c", table: "t", fields: {}, dependsOn: ["b"] },
      { id: "a", logicalName: "a", table: "t", fields: {}, dependsOn: [] },
      { id: "b", logicalName: "b", table: "t", fields: {}, dependsOn: ["a"] },
    ];
    var sorted = topoSort(ops);
    expect(sorted.map(function (o) { return o.id; })).toEqual(["a", "b", "c"]);
  });

  it("breaks ties lexicographically for determinism", function () {
    var ops: Array<WriteOp> = [
      { id: "z", logicalName: "z", table: "t", fields: {}, dependsOn: [] },
      { id: "a", logicalName: "a", table: "t", fields: {}, dependsOn: [] },
      { id: "m", logicalName: "m", table: "t", fields: {}, dependsOn: [] },
    ];
    expect(topoSort(ops).map(function (o) { return o.id; })).toEqual(["a", "m", "z"]);
  });

  it("places parent before all children", function () {
    var ops: Array<WriteOp> = [
      { id: "input1", logicalName: "i1", table: "child", fields: {}, dependsOn: ["parent"] },
      { id: "parent", logicalName: "p", table: "parent", fields: {}, dependsOn: [] },
      { id: "input2", logicalName: "i2", table: "child", fields: {}, dependsOn: ["parent"] },
    ];
    var ids = topoSort(ops).map(function (o) { return o.id; });
    expect(ids[0]).toBe("parent");
    expect(ids.slice(1).sort()).toEqual(["input1", "input2"]);
  });

  it("throws on a cycle", function () {
    var ops: Array<WriteOp> = [
      { id: "a", logicalName: "a", table: "t", fields: {}, dependsOn: ["b"] },
      { id: "b", logicalName: "b", table: "t", fields: {}, dependsOn: ["a"] },
    ];
    var thrown: any = null;
    try { topoSort(ops); } catch (e: any) { thrown = e; }
    expect(thrown).toBeInstanceOf(WriteOrderError);
    expect(thrown.message).toMatch(/cycle/);
    expect(thrown.cycleIds).toContain("a");
    expect(thrown.cycleIds).toContain("b");
  });

  it("throws on a dangling dependency reference", function () {
    var ops: Array<WriteOp> = [
      { id: "a", logicalName: "a", table: "t", fields: {}, dependsOn: ["nope"] },
    ];
    expect(function () { topoSort(ops); }).toThrow(/depends on unknown id/);
  });

  it("throws on duplicate ids", function () {
    var ops: Array<WriteOp> = [
      { id: "a", logicalName: "a", table: "t", fields: {}, dependsOn: [] },
      { id: "a", logicalName: "a", table: "t", fields: {}, dependsOn: [] },
    ];
    expect(function () { topoSort(ops); }).toThrow(/duplicate WriteOp.id/);
  });
});

describe("executeWritePlan", function () {
  function makeMockClient(): {
    client: ServiceNowClient;
    creates: Array<{ table: string; fields: any; sys_id?: string; update_set_sys_id?: string }>;
  } {
    var creates: Array<any> = [];
    return {
      creates: creates,
      client: {
        table: { query: async function () { return []; } },
        buildAgent: {
          runQuery: async function () { return [] as any; },
          getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; },
        },
        claude: {
          createRecord: async function (params: any) {
            creates.push(params);
            return { sys_id: params.sys_id };
          },
          pushWithUpdateSet: async function (p: any) { return { sys_id: p.record_sys_id }; },
          currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
        },
      },
    };
  }

  var US = "11111111111111111111111111111111";

  it("writes ops in topo order with explicit sys_ids", async function () {
    var ctx = makeMockClient();
    var ops: Array<WriteOp> = [
      { id: "input", logicalName: "i", table: "child", fields: { sys_id: "ssss222222222222ssss22222222ssss", parent: "ssss111111111111ssss11111111ssss" }, dependsOn: ["parent"] },
      { id: "parent", logicalName: "p", table: "parent", fields: { sys_id: "ssss111111111111ssss11111111ssss", name: "Foo" }, dependsOn: [] },
    ];
    var results = await executeWritePlan(ctx.client, ops, US);
    expect(ctx.creates.map(function (c) { return c.table; })).toEqual(["parent", "child"]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ id: "parent", action: "created" }));
  });

  it("pins every write to the supplied update set", async function () {
    var ctx = makeMockClient();
    var ops: Array<WriteOp> = [
      { id: "p", logicalName: "p", table: "t", fields: { sys_id: "00000000000000000000000000000001" }, dependsOn: [] },
    ];
    await executeWritePlan(ctx.client, ops, US);
    expect(ctx.creates[0].update_set_sys_id).toBe(US);
  });

  it("requires fields.sys_id on every op", async function () {
    var ctx = makeMockClient();
    var ops: Array<WriteOp> = [
      { id: "p", logicalName: "p", table: "t", fields: { name: "no sys_id" }, dependsOn: [] },
    ];
    await expect(executeWritePlan(ctx.client, ops, US)).rejects.toThrow(/missing fields.sys_id/);
  });

  it("rejects bad updateSetSysId early", async function () {
    var ctx = makeMockClient();
    await expect(executeWritePlan(ctx.client, [], "bad")).rejects.toThrow(/updateSetSysId must be a 32-char/);
  });

  it("wraps a write failure with op + table context", async function () {
    var ctx = makeMockClient();
    ctx.client.claude.createRecord = async function () { throw new Error("ACL violation"); };
    var ops: Array<WriteOp> = [
      { id: "p", logicalName: "p", table: "sys_hub_flow", fields: { sys_id: "00000000000000000000000000000001" }, dependsOn: [] },
    ];
    await expect(executeWritePlan(ctx.client, ops, US)).rejects.toThrow(/op 'p' \(sys_hub_flow\): ACL violation/);
  });
});
