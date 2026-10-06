import { deleteRecord, snapshotRecord, UPDATE_SET_CAVEAT } from "../src/deleteRecord";
import { makeMockClient } from "./mockClient";

var US = "20756100334a03107b18bc534d5c7b2b";
var ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

interface Row {
  sys_id: string;
  [k: string]: unknown;
}

/**
 * Mock whose reads are keyed by the encoded query; a successful mock delete
 * removes the row from the store so the post-delete read-back comes back empty.
 * `stickyDelete: true` simulates a delete the instance silently refused (ACL /
 * BR abort) — the row stays and the read-back still finds it.
 */
function ctxFor(rows: Record<string, Array<Row>>, options: { stickyDelete?: boolean } = {}) {
  var store: Record<string, Array<Row>> = {};
  Object.keys(rows).forEach(function (k) {
    store[k] = rows[k].slice();
  });
  var ctx = makeMockClient({
    query: async function (_table: string, query?: string) {
      return store[query || ""] || [];
    }
  });
  var realDelete = ctx.client.claude.deleteRecord;
  ctx.client.claude.deleteRecord = async function (params) {
    var out = await realDelete(params);
    if (!options.stickyDelete) {
      delete store["sys_id=" + params.sys_id];
    }
    return out;
  };
  return ctx;
}

describe("deleteRecord — validation (no network)", function () {
  it("rejects a missing table before any call", async function () {
    var ctx = ctxFor({});
    await expect(
      deleteRecord({ client: ctx.client, table: "", sysId: ID, updateSetSysId: US })
    ).rejects.toThrow(/--table is required/);
    expect(ctx.calls.tableQuery.length).toBe(0);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("rejects a malformed table name before any call", async function () {
    var ctx = ctxFor({});
    await expect(
      deleteRecord({ client: ctx.client, table: "Bad Table;drop", sysId: ID, updateSetSysId: US })
    ).rejects.toThrow(/table name/);
    expect(ctx.calls.tableQuery.length).toBe(0);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("refuses schema tables", async function () {
    var ctx = ctxFor({});
    await expect(
      deleteRecord({ client: ctx.client, table: "sys_dictionary", sysId: ID, updateSetSysId: US, confirm: true })
    ).rejects.toThrow(/schema table/);
    await expect(
      deleteRecord({ client: ctx.client, table: "sys_db_object", sysId: ID, updateSetSysId: US, confirm: true })
    ).rejects.toThrow(/schema table/);
    expect(ctx.calls.tableQuery.length).toBe(0);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("rejects a non-32-hex sys_id before any call", async function () {
    var ctx = ctxFor({});
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: "el1", updateSetSysId: US, confirm: true })
    ).rejects.toThrow(/32-character lowercase hex/);
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID.toUpperCase(), updateSetSysId: US, confirm: true })
    ).rejects.toThrow(/32-character lowercase hex/);
    expect(ctx.calls.tableQuery.length).toBe(0);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("requires an update set before any call", async function () {
    var ctx = ctxFor({});
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, confirm: true })
    ).rejects.toThrow(/--update-set/);
    expect(ctx.calls.tableQuery.length).toBe(0);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });
});

describe("deleteRecord — read-before / dry-run", function () {
  it("errors out when the record does not exist, before any delete call", async function () {
    var ctx = ctxFor({});
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true })
    ).rejects.toThrow(/no record .* found on x_t/);
    expect(ctx.calls.tableQuery.length).toBe(1);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("treats a 404 on the pre-read as a missing record, not a crash", async function () {
    var ctx = makeMockClient({
      query: async function () {
        throw new Error("SN 404 on table.query(x_t) — endpoint or record not found.");
      }
    });
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true })
    ).rejects.toThrow(/no record .* found/);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("propagates a non-404 read error (auth) untouched", async function () {
    var ctx = makeMockClient({
      query: async function () {
        throw new Error("SN auth error 403 on table.query(x_t) — check creds");
      }
    });
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true })
    ).rejects.toThrow(/auth error 403/);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("is a dry-run by default — returns the snapshot and performs no delete", async function () {
    var row: Row = { sys_id: ID, name: "avg_parts", order: "35" };
    var ctx = ctxFor({ ["sys_id=" + ID]: [row] });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US });
    expect(r.status).toBe("dry-run");
    expect(r.verified).toBe(false);
    expect(r.before).toEqual({ sys_id: ID, name: "avg_parts", order: "35" });
    expect(r.updateSetSysId).toBe(US);
    expect(ctx.calls.deleteRecord.length).toBe(0);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
    expect(ctx.calls.createRecord.length).toBe(0);
    expect(ctx.calls.nowInvoke.length).toBe(0);
  });

  it("dryRun:true wins over confirm:true", async function () {
    var ctx = ctxFor({ ["sys_id=" + ID]: [{ sys_id: ID, name: "a" }] });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true, dryRun: true });
    expect(r.status).toBe("dry-run");
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("confirm must be exactly true — a truthy non-boolean does not delete", async function () {
    var ctx = ctxFor({ ["sys_id=" + ID]: [{ sys_id: ID, name: "a" }] });
    var loose: { confirm?: boolean } = {};
    (loose as Record<string, unknown>).confirm = "yes";
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: loose.confirm });
    expect(r.status).toBe("dry-run");
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });
});

describe("deleteRecord — apply + read-back", function () {
  it("confirm:true deletes via claude.deleteRecord with mapped args incl. update_set_sys_id, then verifies gone", async function () {
    var ctx = ctxFor({ ["sys_id=" + ID]: [{ sys_id: ID, name: "a" }] });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("deleted");
    expect(r.verified).toBe(true);
    expect(r.before).toEqual({ sys_id: ID, name: "a" });
    expect(ctx.calls.deleteRecord.length).toBe(1);
    expect(ctx.calls.deleteRecord[0]).toEqual({
      table: "x_t",
      sys_id: ID,
      update_set_sys_id: US
    });
    // before-read + after-read
    expect(ctx.calls.tableQuery.length).toBe(2);
    expect(ctx.calls.tableQuery[1]).toEqual({ table: "x_t", query: "sys_id=" + ID });
  });

  it("reports failed (never success) when the post-delete read-back still finds the record", async function () {
    var ctx = ctxFor({ ["sys_id=" + ID]: [{ sys_id: ID, name: "a" }] }, { stickyDelete: true });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/STILL PRESENT/);
    expect(ctx.calls.deleteRecord.length).toBe(1);
  });

  it("treats a 404 on the post-delete read-back as gone", async function () {
    var reads = 0;
    var ctx = makeMockClient({
      query: async function () {
        reads += 1;
        if (reads === 1) return [{ sys_id: ID, name: "a" }];
        throw new Error("SN 404 on table.query(x_t) — endpoint or record not found.");
      }
    });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("deleted");
    expect(r.verified).toBe(true);
  });

  it("does not trust a read-back row for a different sys_id", async function () {
    var ctx = makeMockClient({
      query: async function () {
        return [{ sys_id: "ffffffffffffffffffffffffffffffff", name: "other" }];
      }
    });
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true })
    ).rejects.toThrow(/no record .* found/);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });
});

describe("snapshotRecord", function () {
  it("flattens reference objects and truncates long values", function () {
    var long = new Array(260).join("x");
    var snap = snapshotRecord({
      sys_id: ID,
      sys_scope: { link: "https://x/api/now/table/sys_scope/abc", value: "abc" },
      script: long,
      empty: null
    });
    expect(snap.sys_id).toBe(ID);
    expect(snap.sys_scope).toBe("abc");
    expect(snap.empty).toBe("");
    expect(snap.script.length).toBeLessThan(long.length);
    expect(snap.script).toMatch(/\[259 chars\]$/);
  });

  it("returns an empty map for a non-object", function () {
    expect(snapshotRecord(null as unknown as Record<string, unknown>)).toEqual({});
  });
});

// Until TenonHQ/Dovetail#297 ships the server ignores update_set_sys_id, so no result may
// imply the capture was pinned. Delete this block with UPDATE_SET_CAVEAT when #297 lands.
describe("deleteRecord — update-set caveat (#297)", function () {
  it("the dry-run note states the capture lands in the session's current set", async function () {
    var ctx = ctxFor({ ["sys_id=" + ID]: [{ sys_id: ID, name: "a" }] });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US });
    expect(r.status).toBe("dry-run");
    expect(r.note).toContain(UPDATE_SET_CAVEAT);
    expect(r.note).not.toMatch(/capture it into update set/);
  });

  it("the deleted note carries the same caveat", async function () {
    var ctx = ctxFor({ ["sys_id=" + ID]: [{ sys_id: ID, name: "a" }] });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("deleted");
    expect(r.note).toContain("#297");
    expect(r.note).toContain("current update set");
  });
});
