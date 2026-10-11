/**
 * The SERVER half of domain selection — servicenow/dovetail/sys_ws_operation/
 * pushWithUpdateSet.js and createRecord.js — run in a sandbox with minimal ServiceNow
 * stubs (gs / GlideRecord / GlideUpdateSet / request / response), the same approach as
 * core's dovetailUtilsMS*.test.ts. These ops are deployed to shared instances by hand,
 * so this is the only gate they get before deploy.
 *
 * What is pinned: an absent `domain` keeps the legacy behaviour (no switch); a requested
 * domain is the session domain DURING the write and the previous one is restored after
 * (also on error); a switch that does not take fails closed with nothing written; a
 * table without sys_domain skips the switch; bad / unknown domains are refused.
 */
import fs from "fs";
import path from "path";
import vm from "vm";

var OPS = path.join(__dirname, "../../../servicenow/dovetail/sys_ws_operation");
var CHILD = "09ff3d105f231000b12e3572f2b4775d";
var OTHER = "11111111111111111111111111111111";
var US = "059d29ea47bb4310357690d3706d43c7";
var BR = "a01405ee33d8e2107b18bc534d5c7baa";

interface World {
  sessionDomain: string | null;
  /** setDomainID is ignored (the switch does not take). */
  switchIgnored: boolean;
  setDomainCalls: Array<string>;
  /** Session domain observed at the moment of each update()/insert(). */
  writeDomains: Array<string | null>;
  /** Values set on the record being written. */
  written: Record<string, string>;
  hasSysDomain: boolean;
  knownDomains: Array<string>;
  writeThrows: boolean;
  recordExists: boolean;
  /** GlideUpdateSet.set() is ignored (the current set does not move). */
  setIgnored: boolean;
  /** setDomainID throws when restoring (any call after the first). */
  restoreThrows: boolean;
  /** Ordered trace of domain / update-set switches. */
  trace: Array<string>;
  warnings: Array<string>;
}

function newWorld(over: Partial<World> = {}): World {
  return Object.assign(
    {
      sessionDomain: CHILD,
      switchIgnored: false,
      setDomainCalls: [],
      writeDomains: [],
      written: {},
      hasSysDomain: true,
      knownDomains: [CHILD, OTHER],
      writeThrows: false,
      recordExists: true,
      setIgnored: false,
      restoreThrows: false,
      trace: [],
      warnings: [],
    },
    over,
  );
}

function sandboxFor(world: World, body: Record<string, unknown>) {
  var res: { status: number; body: any } = { status: 0, body: null };
  function GlideRecord(this: any, table: string) {
    var values: Record<string, string> = {};
    var isDomainTable = table === "domain";
    this.isValidField = function (f: string) {
      if (f === "sys_domain") return world.hasSysDomain;
      return true;
    };
    this.getElement = function () {
      return { getReferenceTable: function () { return "domain"; } };
    };
    this.get = function (id: string) {
      if (isDomainTable) return world.knownDomains.indexOf(id) !== -1;
      if (table === "sys_update_set") {
        values.application = "";
        return id === US;
      }
      if (!world.recordExists) return false;
      values.sys_domain = "global";
      return true;
    };
    this.initialize = function () {};
    this.newRecord = function () {};
    this.setNewGuidValue = function () {};
    this.setValue = function (f: string, v: string) {
      values[f] = v;
      world.written[f] = v;
    };
    this.getValue = function (f: string) {
      return values[f] === undefined ? "" : values[f];
    };
    this.getDisplayValue = function () { return "rec"; };
    this.getUniqueValue = function () { return "x"; };
    this.update = function () {
      if (world.writeThrows) throw new Error("boom");
      world.writeDomains.push(world.sessionDomain);
      return BR;
    };
    this.insert = function () {
      if (world.writeThrows) throw new Error("boom");
      world.writeDomains.push(world.sessionDomain);
      return { toString: function () { return "newsysid"; } };
    };
  }
  var user = {
    getDomainID: function () { return world.sessionDomain; },
    setDomainID: function (id: string) {
      if (world.restoreThrows && world.setDomainCalls.length > 0) throw new Error("restore failed");
      world.setDomainCalls.push(id);
      world.trace.push("domain:" + id);
      if (!world.switchIgnored) world.sessionDomain = id;
    },
  };
  var sandbox: any = {
    request: { body: { data: body } },
    response: {
      setStatus: function (s: number) { res.status = s; },
      setBody: function (b: any) { res.body = b; },
    },
    gs: {
      getUser: function () { return user; },
      getCurrentApplicationId: function () { return "global"; },
      setCurrentApplicationId: function () {},
      warn: function (msg: string) { world.warnings.push(msg); },
    },
    GlideRecord: GlideRecord,
    GlideUpdateSet: function (this: any) {
      var current = "prev_set";
      this.get = function () { return current; };
      this.set = function (id: string) {
        world.trace.push("set:" + id);
        if (!world.setIgnored) current = id;
      };
    },
  };
  return { sandbox: sandbox, res: res };
}

function runOp(op: string, world: World, body: Record<string, unknown>) {
  var src = fs.readFileSync(path.join(OPS, op + ".js"), "utf8");
  var built = sandboxFor(world, body);
  vm.runInNewContext(src, built.sandbox, { filename: op + ".js" });
  return built.res;
}

var PUSH_BODY = { update_set_sys_id: US, table: "sys_script", record_sys_id: BR, fields: { script: "new" } };
var CREATE_BODY = { table: "sys_script", fields: { name: "rule" }, update_set_sys_id: US };

describe("pushWithUpdateSet.js — session domain", function () {
  it("legacy: no domain in the body → no switch, no echo", function () {
    var w = newWorld();
    var r = runOp("pushWithUpdateSet", w, PUSH_BODY);
    expect(r.status).toBe(200);
    expect(w.setDomainCalls).toEqual([]);
    expect(w.writeDomains).toEqual([CHILD]);
    expect(r.body.domain).toBeUndefined();
  });

  it("domain=global: the update runs in global and the child domain is restored", function () {
    var w = newWorld();
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(r.status).toBe(200);
    expect(w.writeDomains).toEqual(["global"]);
    expect(w.setDomainCalls).toEqual(["global", CHILD]);
    expect(w.sessionDomain).toBe(CHILD);
    expect(r.body.domain).toEqual({ requested: "global", applied: "global", previous: CHILD });
    expect(r.body.record_domain).toBe("global");
  });

  it("no switch when the session is already in the requested domain", function () {
    var w = newWorld({ sessionDomain: null });
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(r.status).toBe(200);
    expect(w.setDomainCalls).toEqual([]);
    expect(r.body.domain).toEqual({ requested: "global", applied: "global", previous: "global" });
  });

  it("fails closed when the switch does not take — 409 (never retried), nothing is written", function () {
    var w = newWorld({ switchIgnored: true });
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Could not switch the session domain to global/);
    expect(w.writeDomains).toEqual([]);
  });

  it("restores the domain when the write throws", function () {
    var w = newWorld({ writeThrows: true });
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(r.status).toBe(500);
    expect(w.sessionDomain).toBe(CHILD);
  });

  it("restores the domain when the record is not found", function () {
    var w = newWorld({ recordExists: false });
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(r.status).toBe(404);
    expect(w.sessionDomain).toBe(CHILD);
  });

  it("skips the switch on a table without sys_domain and says so", function () {
    var w = newWorld({ hasSysDomain: false });
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(r.status).toBe(200);
    expect(w.setDomainCalls).toEqual([]);
    expect(r.body.domain).toEqual({ requested: "global", applied: null, previous: null, skipped: "table has no sys_domain" });
  });

  it("switches the domain BEFORE selecting the update set", function () {
    var w = newWorld();
    runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(w.trace.indexOf("domain:global")).toBeLessThan(w.trace.indexOf("set:" + US));
  });

  it("fails closed (409) when the target update set is not current before the write", function () {
    var w = newWorld({ setIgnored: true });
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/is not current after the domain switch/);
    expect(w.writeDomains).toEqual([]);
    expect(w.sessionDomain).toBe(CHILD);
  });

  it("legacy path does not assert the update set (behaviour unchanged without domain)", function () {
    var w = newWorld({ setIgnored: true });
    expect(runOp("pushWithUpdateSet", w, PUSH_BODY).status).toBe(200);
  });

  it("a failed restore is traced with gs.warn, not swallowed", function () {
    var w = newWorld({ restoreThrows: true });
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: "global" }, PUSH_BODY));
    expect(r.status).toBe(200);
    expect(w.warnings[0]).toMatch(/could not restore session domain/);
  });

  it("switches to a named domain sys_id", function () {
    var w = newWorld();
    var r = runOp("pushWithUpdateSet", w, Object.assign({ domain: OTHER }, PUSH_BODY));
    expect(r.status).toBe(200);
    expect(w.writeDomains).toEqual([OTHER]);
    expect(w.sessionDomain).toBe(CHILD);
  });

  it("refuses a malformed domain (400) and an unknown one (422 — a 404 would send the client to the legacy op) before writing", function () {
    var w1 = newWorld();
    expect(runOp("pushWithUpdateSet", w1, Object.assign({ domain: "Default" }, PUSH_BODY)).status).toBe(400);
    var w2 = newWorld();
    var r2 = runOp("pushWithUpdateSet", w2, Object.assign({ domain: "22222222222222222222222222222222" }, PUSH_BODY));
    expect(r2.status).toBe(422);
    expect(r2.body.error).toMatch(/Domain not found/);
    expect(w1.writeDomains.concat(w2.writeDomains)).toEqual([]);
  });
});

describe("createRecord.js — session domain", function () {
  it("legacy: no domain → no switch, no sys_domain stamped, no echo", function () {
    var w = newWorld();
    var r = runOp("createRecord", w, CREATE_BODY);
    expect(r.status).toBe(201);
    expect(w.setDomainCalls).toEqual([]);
    expect(w.written.sys_domain).toBeUndefined();
    expect(r.body.domain).toBeUndefined();
  });

  it("domain=global: inserts in global, stamps sys_domain, restores, echoes", function () {
    var w = newWorld();
    var r = runOp("createRecord", w, Object.assign({ domain: "global" }, CREATE_BODY));
    expect(r.status).toBe(201);
    expect(w.writeDomains).toEqual(["global"]);
    expect(w.written.sys_domain).toBe("global");
    expect(w.sessionDomain).toBe(CHILD);
    expect(r.body.domain).toEqual({ requested: "global", applied: "global", previous: CHILD });
    expect(r.body.record_domain).toBe("global");
  });

  it("a payload sys_domain is kept, not overwritten by the stamp", function () {
    var w = newWorld();
    runOp("createRecord", w, { table: "sys_script", fields: { name: "rule", sys_domain: OTHER }, domain: "global" });
    expect(w.written.sys_domain).toBe(OTHER);
  });

  it("fails closed when the switch does not take — 409, nothing is inserted", function () {
    var w = newWorld({ switchIgnored: true });
    var r = runOp("createRecord", w, Object.assign({ domain: "global" }, CREATE_BODY));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/nothing was inserted/);
    expect(w.writeDomains).toEqual([]);
  });

  it("restores the domain when the insert throws", function () {
    var w = newWorld({ writeThrows: true });
    var r = runOp("createRecord", w, Object.assign({ domain: "global" }, CREATE_BODY));
    expect(r.status).toBe(500);
    expect(w.sessionDomain).toBe(CHILD);
  });

  it("switches the domain BEFORE selecting the update set, and fails closed (409) when the set drifts", function () {
    var w = newWorld();
    runOp("createRecord", w, Object.assign({ domain: "global" }, CREATE_BODY));
    expect(w.trace.indexOf("domain:global")).toBeLessThan(w.trace.indexOf("set:" + US));
    var drift = newWorld({ setIgnored: true });
    var r = runOp("createRecord", drift, Object.assign({ domain: "global" }, CREATE_BODY));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/current: prev_set/);
    expect(drift.writeDomains).toEqual([]);
    expect(drift.sessionDomain).toBe(CHILD);
  });

  it("refuses an unknown domain with 422, never 404", function () {
    var w = newWorld();
    expect(runOp("createRecord", w, Object.assign({ domain: "22222222222222222222222222222222" }, CREATE_BODY)).status).toBe(422);
  });

  it("refuses a malformed domain with 400", function () {
    var w = newWorld();
    expect(runOp("createRecord", w, Object.assign({ domain: "nope" }, CREATE_BODY)).status).toBe(400);
    expect(w.writeDomains).toEqual([]);
  });
});
