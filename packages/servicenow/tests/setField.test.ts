import { setField } from "../src/setField";
import { makeMockClient } from "./mockClient";

var US = "20756100334a03107b18bc534d5c7b2b";

// Build a mock client whose reads are keyed by the exact encoded query string.
function ctxFor(rows: Record<string, Array<any>>) {
  return makeMockClient({
    query: async function (table: string, query?: string) {
      return rows[query || ""] || [];
    }
  });
}

describe("setField", function () {
  it("refuses schema tables", async function () {
    var ctx = ctxFor({});
    await expect(
      setField({ client: ctx.client, table: "sys_db_object", sysId: "x", fields: { name: "y" }, updateSetSysId: US })
    ).rejects.toThrow(/schema table/);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
  });

  it("requires at least one field", async function () {
    var ctx = ctxFor({});
    await expect(
      setField({ client: ctx.client, table: "x_t", sysId: "x", fields: {}, updateSetSysId: US })
    ).rejects.toThrow(/at least one field/);
  });

  it("requires an update set", async function () {
    var ctx = ctxFor({});
    await expect(
      setField({ client: ctx.client, table: "x_t", sysId: "x", fields: { order: "20" } })
    ).rejects.toThrow(/update-set/);
  });

  it("requires a target (sys-id or query)", async function () {
    var ctx = ctxFor({});
    await expect(
      setField({ client: ctx.client, table: "x_t", fields: { order: "20" }, updateSetSysId: US })
    ).rejects.toThrow(/sys-id or --query/);
  });

  it("dry-run reads the current value but does not write", async function () {
    var ctx = ctxFor({ "sys_id=row1": [{ sys_id: "row1", order: "5" }] });
    var r = await setField({ client: ctx.client, table: "x_t", sysId: "row1", fields: { order: "20" }, updateSetSysId: US, dryRun: true });
    expect(r.status).toBe("dry-run");
    expect(r.before.order).toBe("5");
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
  });

  it("writes via pushWithUpdateSet and verifies the read-back", async function () {
    var ctx = ctxFor({ "sys_id=row1": [{ sys_id: "row1", order: "20" }] });
    var r = await setField({ client: ctx.client, table: "x_t", sysId: "row1", fields: { order: "20" }, updateSetSysId: US });
    expect(r.status).toBe("applied");
    expect(r.verified).toBe(true);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(1);
    expect(ctx.calls.pushWithUpdateSet[0]).toEqual({
      update_set_sys_id: US,
      table: "x_t",
      record_sys_id: "row1",
      fields: { order: "20" }
    });
  });

  it("reports failed when the read-back does not match", async function () {
    var ctx = ctxFor({ "sys_id=row1": [{ sys_id: "row1", order: "5" }] });
    var r = await setField({ client: ctx.client, table: "x_t", sysId: "row1", fields: { order: "20" }, updateSetSysId: US });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
  });

  it("resolves the target by a single-match query", async function () {
    var ctx = ctxFor({ "name=send_size": [{ sys_id: "row1" }], "sys_id=row1": [{ sys_id: "row1", order: "20" }] });
    var r = await setField({ client: ctx.client, table: "x_t", query: "name=send_size", fields: { order: "20" }, updateSetSysId: US });
    expect(r.status).toBe("applied");
    expect(ctx.calls.pushWithUpdateSet[0].record_sys_id).toBe("row1");
  });

  it("refuses an ambiguous (2+ row) query", async function () {
    var ctx = ctxFor({ "name=dup": [{ sys_id: "a" }, { sys_id: "b" }] });
    await expect(
      setField({ client: ctx.client, table: "x_t", query: "name=dup", fields: { order: "20" }, updateSetSysId: US })
    ).rejects.toThrow(/refine to exactly one/);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
  });
});
