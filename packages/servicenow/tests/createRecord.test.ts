import { createRecord } from "../src/createRecord";
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

describe("createRecord", function () {
  it("refuses schema tables", async function () {
    var ctx = ctxFor({});
    await expect(
      createRecord({ client: ctx.client, table: "sys_dictionary", fields: { element: "x" }, scope: "x_s", updateSetSysId: US })
    ).rejects.toThrow(/schema table/);
    expect(ctx.calls.createRecord.length).toBe(0);
  });

  it("refuses sys_update_set before any client call (createRecord op cannot set its application)", async function () {
    var ctx = ctxFor({});
    await expect(
      createRecord({ client: ctx.client, table: "sys_update_set", fields: { name: "Foo" }, scope: "x_s", updateSetSysId: US })
    ).rejects.toThrow(/dove createUpdateSet/);
    expect(ctx.calls.createRecord.length).toBe(0);
    expect(ctx.calls.tableQuery.length).toBe(0);
  });

  it("requires at least one field", async function () {
    var ctx = ctxFor({});
    await expect(
      createRecord({ client: ctx.client, table: "x_t", fields: {}, scope: "x_s", updateSetSysId: US })
    ).rejects.toThrow(/at least one field/);
  });

  it("requires a scope", async function () {
    var ctx = ctxFor({});
    await expect(
      createRecord({ client: ctx.client, table: "x_t", fields: { name: "a" }, updateSetSysId: US })
    ).rejects.toThrow(/--scope/);
  });

  it("requires an update set", async function () {
    var ctx = ctxFor({});
    await expect(
      createRecord({ client: ctx.client, table: "x_t", fields: { name: "a" }, scope: "x_s" })
    ).rejects.toThrow(/update-set/);
  });

  it("dry-run does not write", async function () {
    var ctx = ctxFor({});
    var r = await createRecord({ client: ctx.client, table: "x_t", fields: { name: "a" }, scope: "x_s", updateSetSysId: US, dryRun: true });
    expect(r.status).toBe("dry-run");
    expect(ctx.calls.createRecord.length).toBe(0);
  });

  it("creates via claude.createRecord and verifies the read-back", async function () {
    var ctx = ctxFor({ "sys_id=new_1": [{ sys_id: "new_1", name: "a", order: "35" }] });
    var r = await createRecord({ client: ctx.client, table: "x_t", fields: { name: "a", order: "35" }, scope: "x_s", updateSetSysId: US });
    expect(r.status).toBe("created");
    expect(r.verified).toBe(true);
    expect(r.sysId).toBe("new_1");
    expect(ctx.calls.createRecord.length).toBe(1);
    expect(ctx.calls.createRecord[0]).toEqual({
      table: "x_t",
      fields: { name: "a", order: "35" },
      scope: "x_s",
      update_set_sys_id: US
    });
  });

  it("reports failed when the read-back does not match", async function () {
    var ctx = ctxFor({ "sys_id=new_1": [{ sys_id: "new_1", name: "a", order: "" }] });
    var r = await createRecord({ client: ctx.client, table: "x_t", fields: { name: "a", order: "35" }, scope: "x_s", updateSetSysId: US });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
  });

  it("--if-absent skips the insert when the query matches with equal values", async function () {
    var ctx = ctxFor({ "name=a": [{ sys_id: "row9", name: "a", order: "35" }] });
    var r = await createRecord({ client: ctx.client, table: "x_t", fields: { name: "a", order: "35" }, scope: "x_s", updateSetSysId: US, ifAbsentQuery: "name=a" });
    expect(r.status).toBe("skipped");
    expect(r.sysId).toBe("row9");
    expect(r.verified).toBe(true);
    expect(ctx.calls.createRecord.length).toBe(0);
  });

  it("--if-absent skip reports drift when the existing values differ", async function () {
    var ctx = ctxFor({ "name=a": [{ sys_id: "row9", name: "a", order: "5" }] });
    var r = await createRecord({ client: ctx.client, table: "x_t", fields: { name: "a", order: "35" }, scope: "x_s", updateSetSysId: US, ifAbsentQuery: "name=a" });
    expect(r.status).toBe("skipped");
    expect(r.verified).toBe(false);
    expect(ctx.calls.createRecord.length).toBe(0);
  });
});

describe("createRecord read-back tolerates the HTML sanitizer (#300)", function () {
  it("verifies when the instance entity-encoded an html value (@ → &#64;)", async function () {
    var ctx = ctxFor({
      "sys_id=new_1": [{ sys_id: "new_1", name: "a", description: "contact &#64;tenon" }]
    });
    var r = await createRecord({
      client: ctx.client, table: "x_t",
      fields: { name: "a", description: "contact @tenon" },
      scope: "x_s", updateSetSysId: US
    });
    expect(r.status).toBe("created");
    expect(r.verified).toBe(true);
    expect(r.note).toMatch(/verified via read-back\. \(description: the instance HTML-entity-encoded/);
    // The submitted value is sent untouched — normalization is compare-only.
    expect(ctx.calls.createRecord[0].fields).toEqual({ name: "a", description: "contact @tenon" });
  });

  it("still reports failed for a genuinely different html value", async function () {
    var ctx = ctxFor({
      "sys_id=new_1": [{ sys_id: "new_1", description: "<p>&#64;beta</p>" }]
    });
    var r = await createRecord({
      client: ctx.client, table: "x_t",
      fields: { description: "<p>@alpha</p>" },
      scope: "x_s", updateSetSysId: US
    });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/\(description\)/);
  });

  it("keeps the strict compare for a non-entity difference", async function () {
    var ctx = ctxFor({
      "sys_id=new_1": [{ sys_id: "new_1", name: "a", order: "" }]
    });
    var r = await createRecord({
      client: ctx.client, table: "x_t",
      fields: { name: "a", order: "35" },
      scope: "x_s", updateSetSysId: US
    });
    expect(r.status).toBe("failed");
    expect(r.note).toMatch(/\(order\)/);
  });

  it("--if-absent treats an entity-encoded existing value as in sync", async function () {
    var ctx = ctxFor({
      "name=a": [{ sys_id: "row9", name: "a", description: "contact &#64;tenon" }]
    });
    var r = await createRecord({
      client: ctx.client, table: "x_t",
      fields: { name: "a", description: "contact @tenon" },
      scope: "x_s", updateSetSysId: US, ifAbsentQuery: "name=a"
    });
    expect(r.status).toBe("skipped");
    expect(r.verified).toBe(true);
    expect(r.note).toMatch(/already match\. \(description: the instance HTML-entity-encoded/);
    expect(ctx.calls.createRecord.length).toBe(0);
  });
});
