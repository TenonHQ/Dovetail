import { deleteRecord, snapshotRecord, UPDATE_SET_CAVEAT } from "../src/deleteRecord";
import { makeMockClient } from "./mockClient";
import type { MockClientCtx, QueryFn } from "./mockClient";

var US = "20756100334a03107b18bc534d5c7b2b";
var ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** The session's current set before anything pins it (the platform "Default"). */
var DEFAULT_SET = "fedcba9876543210fedcba9876543210";
var CLOSED_SET = "0123456789abcdef0123456789abcdef";

interface Row {
  sys_id: string;
  [k: string]: unknown;
}

interface SimOptions {
  /** The delete is silently refused (ACL / BR abort): row stays, nothing captured. */
  stickyDelete?: boolean;
  /** changeUpdateSet answers but the current set does not change. */
  pinIgnored?: boolean;
  /** The DELETE capture row lands in this set whatever the pin says (cross-scope shape). */
  captureInto?: string;
  /** The table is not recorded in update sets: no capture row is written. */
  noCapture?: boolean;
  /** The sys_update_xml read-back throws this message. */
  captureReadError?: string;
  /** Runs when a (non-sticky) delete lands — e.g. to drop the row from a store. */
  onDelete?: (params: { table: string; sys_id: string }) => void;
}

interface SimInstance {
  current: string;
  captures: Array<Record<string, unknown>>;
  /** Write the DELETE capture row the platform would, into the current (or forced) set. */
  landDelete: (table: string, sysId: string) => void;
}

var SETS: Record<string, { name: string; state: string }> = {};
SETS[US] = { name: "Journey set", state: "in progress" };
SETS[DEFAULT_SET] = { name: "Default", state: "in progress" };
SETS[CLOSED_SET] = { name: "Shipped set", state: "complete" };

/**
 * A mock instance: record-table reads go to the caller's query function; sys_update_set
 * and sys_update_xml are simulated, changeUpdateSet / currentUpdateSet share one
 * "current set", and a landed delete writes its DELETE capture row into that set.
 */
function simInstance(
  overrides: { query?: QueryFn },
  options: SimOptions = {}
): MockClientCtx & { inst: SimInstance } {
  var recordQuery: QueryFn = overrides.query || (async function () { return []; });
  var inst: SimInstance = {
    current: DEFAULT_SET,
    captures: [],
    landDelete: function (table: string, sysId: string) {
      if (options.noCapture) return;
      inst.captures.push({
        sys_id: "cap" + inst.captures.length,
        name: table + "_" + sysId,
        action: "DELETE",
        update_set: { link: "https://x/api/now/table/sys_update_set/x", value: options.captureInto || inst.current }
      });
    }
  };
  var ctx = makeMockClient({
    query: async function (table: string, query?: string, limit?: number) {
      if (table === "sys_update_set") {
        var id = (query || "").replace(/^sys_id=/, "");
        var set = SETS[id];
        return set ? [{ sys_id: id, name: set.name, state: set.state }] : [];
      }
      // Newest first, as ORDERBYDESC asks.
      if (table === "sys_update_xml") {
        if (options.captureReadError) throw new Error(options.captureReadError);
        return inst.captures.slice().reverse();
      }
      return recordQuery(table, query, limit);
    }
  });
  ctx.client.claude.changeUpdateSet = async function (params) {
    ctx.calls.changeUpdateSet.push(params);
    if (!options.pinIgnored) inst.current = params.sysId;
    return { sys_id: params.sysId };
  };
  ctx.client.claude.currentUpdateSet = async function () {
    return { sys_id: inst.current, name: SETS[inst.current] ? SETS[inst.current].name : "" };
  };
  var realDelete = ctx.client.claude.deleteRecord;
  ctx.client.claude.deleteRecord = async function (params) {
    var out = await realDelete(params);
    if (!options.stickyDelete) {
      inst.landDelete(params.table, params.sys_id);
      if (options.onDelete) options.onDelete(params);
    }
    return out;
  };
  return Object.assign(ctx, { inst: inst });
}

/**
 * Mock whose record reads are keyed by the encoded query; a successful mock delete
 * removes the row from the store so the post-delete read-back comes back empty.
 * `stickyDelete: true` simulates a delete the instance silently refused (ACL /
 * BR abort) — the row stays and the read-back still finds it.
 */
function ctxFor(rows: Record<string, Array<Row>>, options: SimOptions = {}) {
  var store: Record<string, Array<Row>> = {};
  Object.keys(rows).forEach(function (k) {
    store[k] = rows[k].slice();
  });
  return simInstance(
    {
      query: async function (_table: string, query?: string) {
        return store[query || ""] || [];
      }
    },
    Object.assign({}, options, {
      onDelete: function (params: { sys_id: string }) {
        delete store["sys_id=" + params.sys_id];
      }
    })
  );
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
    var ctx = simInstance({
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
    var ctx = simInstance({
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
    // before-read, update-set lookup, after-read, capture read-back
    expect(ctx.calls.tableQuery.length).toBe(4);
    expect(ctx.calls.tableQuery[1].table).toBe("sys_update_set");
    expect(ctx.calls.tableQuery[2]).toEqual({ table: "x_t", query: "sys_id=" + ID });
    expect(ctx.calls.tableQuery[3].table).toBe("sys_update_xml");
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
    var ctx = simInstance({
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
    var ctx = simInstance({
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

describe("deleteRecord — a delete call that throws still gets a read-back (R-2)", function () {
  it("server refusal (SN 500) with the row still present → failed, verified:false, error in the note", async function () {
    var ctx = ctxFor({ ["sys_id=" + ID]: [{ sys_id: ID, name: "a" }] });
    ctx.client.claude.deleteRecord = async function (params) {
      ctx.calls.deleteRecord.push(params);
      throw new Error("SN 500 on claude.deleteRecord(x_t) — retries exhausted.");
    };
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/STILL PRESENT/);
    expect(r.note).toContain("SN 500 on claude.deleteRecord(x_t)");
    expect(ctx.calls.deleteRecord.length).toBe(1);
  });

  it("transport error (ECONNRESET) after the delete landed → deleted, with the error noted", async function () {
    var present = true;
    var ctx = simInstance({
      query: async function (_table: string, query?: string) {
        if (present && query === "sys_id=" + ID) return [{ sys_id: ID, name: "a" }];
        return [];
      }
    });
    ctx.client.claude.deleteRecord = async function (params) {
      ctx.calls.deleteRecord.push(params);
      present = false;
      ctx.inst.landDelete(params.table, params.sys_id);
      throw new Error("SN network error on claude.deleteRecord(x_t): read ECONNRESET");
    };
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("deleted");
    expect(r.verified).toBe(true);
    expect(r.note).toContain("ECONNRESET");
    expect(r.note).toMatch(/reported an error/);
  });

  it("a read-back that itself fails → failed (state unknown), never a success or a throw", async function () {
    var reads = 0;
    var ctx = simInstance({
      query: async function () {
        reads += 1;
        if (reads === 1) return [{ sys_id: ID, name: "a" }];
        throw new Error("SN auth error 403 on table.query(x_t) — check creds");
      }
    });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/UNKNOWN/);
  });
});

describe("deleteRecord — update set resolved, pinned and the capture read back (R-1)", function () {
  var REC = { ["sys_id=" + ID]: [{ sys_id: ID, name: "a" }] };

  it("an unknown update set is an error on the dry-run — nothing pinned, nothing deleted", async function () {
    var ctx = ctxFor(REC);
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: "99999999999999999999999999999999" })
    ).rejects.toThrow(/update set 9+ not found/);
    expect(ctx.calls.changeUpdateSet.length).toBe(0);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("a closed update set is an error on the dry-run", async function () {
    var ctx = ctxFor(REC);
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: CLOSED_SET })
    ).rejects.toThrow(/'Shipped set'.*state 'complete'/);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("an update-set value with query metacharacters never reaches a query", async function () {
    var ctx = ctxFor(REC);
    await expect(
      deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US + "^ORsys_id!=x" })
    ).rejects.toThrow(/Invalid character/);
    var setReads = ctx.calls.tableQuery.filter(function (q) { return q.table === "sys_update_set"; });
    expect(setReads.length).toBe(0);
  });

  it("the dry-run names the resolved set and does not pin", async function () {
    var ctx = ctxFor(REC);
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US });
    expect(r.status).toBe("dry-run");
    expect(r.updateSetName).toBe("Journey set");
    expect(r.captured).toBe(false);
    expect(r.capturedInto).toBeNull();
    expect(r.note).toContain("'Journey set'");
    expect(ctx.calls.changeUpdateSet.length).toBe(0);
  });

  it("pins the requested set as current BEFORE the delete", async function () {
    var ctx = ctxFor(REC);
    var order: Array<string> = [];
    var realPin = ctx.client.claude.changeUpdateSet;
    ctx.client.claude.changeUpdateSet = async function (params) {
      order.push("pin");
      return realPin(params);
    };
    var realDelete = ctx.client.claude.deleteRecord;
    ctx.client.claude.deleteRecord = async function (params) {
      order.push("delete");
      return realDelete(params);
    };
    await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(ctx.calls.changeUpdateSet).toEqual([{ sysId: US }]);
    expect(order).toEqual(["pin", "delete"]);
  });

  it("a pin that does not read back is refused — no delete call, record untouched", async function () {
    var ctx = ctxFor(REC, { pinIgnored: true });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.captured).toBe(false);
    expect(r.note).toMatch(/Nothing deleted/);
    expect(r.note).toContain("'Default'");
    expect(ctx.calls.changeUpdateSet.length).toBe(1);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("a pin call that throws is refused — no delete call", async function () {
    var ctx = ctxFor(REC);
    ctx.client.claude.changeUpdateSet = async function () {
      throw new Error("SN 500 on claude.changeUpdateSet — retries exhausted.");
    };
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("failed");
    expect(r.note).toMatch(/could not be pinned/);
    expect(ctx.calls.deleteRecord.length).toBe(0);
  });

  it("happy path — the DELETE row is read back in the requested set → captured:true", async function () {
    var ctx = ctxFor(REC);
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("deleted");
    expect(r.verified).toBe(true);
    expect(r.captured).toBe(true);
    expect(r.capturedInto).toEqual({ sysId: US, name: "Journey set" });
    expect(r.note).toMatch(/DELETE captured into update set 'Journey set'/);
    var capRead = ctx.calls.tableQuery.filter(function (q) { return q.table === "sys_update_xml"; })[0];
    expect(capRead.query).toBe("name=x_t_" + ID + "^action=DELETE^ORDERBYDESCsys_updated_on");
  });

  it("the DELETE row landed in another set → deleted but captured:false, capturedInto names it", async function () {
    var ctx = ctxFor(REC, { captureInto: DEFAULT_SET });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("deleted");
    expect(r.verified).toBe(true);
    expect(r.captured).toBe(false);
    expect(r.capturedInto).toEqual({ sysId: DEFAULT_SET, name: "Default" });
    expect(r.note).toMatch(/WRONG SET/);
    expect(r.note).toMatch(/promote WITHOUT this delete/);
  });

  it("no DELETE row at all → captured:false, capturedInto null", async function () {
    var ctx = ctxFor(REC, { noCapture: true });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("deleted");
    expect(r.captured).toBe(false);
    expect(r.capturedInto).toBeNull();
    expect(r.note).toMatch(/NOT CAPTURED/);
  });

  it("ignores capture rows whose name or action do not match (an ignored query term)", async function () {
    var ctx = ctxFor(REC, { noCapture: true });
    ctx.inst.captures.push({ sys_id: "c1", name: "x_t_" + ID, action: "INSERT_OR_UPDATE", update_set: US });
    ctx.inst.captures.push({ sys_id: "c2", name: "x_other_" + ID, action: "DELETE", update_set: US });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.captured).toBe(false);
    expect(r.capturedInto).toBeNull();
  });

  it("a capture read-back that fails → captured:false with the error, still deleted", async function () {
    var ctx = ctxFor(REC, { captureReadError: "SN auth error 403 on table.query(sys_update_xml)" });
    var r = await deleteRecord({ client: ctx.client, table: "x_t", sysId: ID, updateSetSysId: US, confirm: true });
    expect(r.status).toBe("deleted");
    expect(r.captured).toBe(false);
    expect(r.note).toMatch(/CAPTURE UNVERIFIED/);
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

// Until TenonHQ/Dovetail#297 ships the server ignores update_set_sys_id, so the notes say
// the set is pinned as current and the capture read back. Revisit with UPDATE_SET_CAVEAT.
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
