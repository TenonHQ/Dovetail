/**
 * Session-domain selection for the record-write verbs (set-field, create-record,
 * add-choices, remove-choices) and the domain read-back that turns a silent
 * wrong-domain write into a failed result.
 *
 * The incident this guards: on a domain-separated instance whose API user sits in a
 * child domain, set-field on a GLOBAL business rule did not update it — the platform
 * created a domain OVERRIDE row in the child domain instead, and the original stayed
 * unchanged. create-record / add-choices stamped the child domain on new rows even with
 * sys_domain=global in the payload.
 *
 * Everything is mocked — no instance is contacted.
 */
import { setField } from "../src/setField";
import { createRecord, resolveCreateDomain } from "../src/createRecord";
import { addChoicesToField, removeChoicesFromField } from "../src/choices";
import {
  normalizeDomain,
  domainSnapshot,
  findOverrides,
  newOverrides,
  readServerDomainEcho,
  DEFAULT_WRITE_DOMAIN
} from "../src/domain";
import { domainSchema, setFieldSchema, createRecordSchema, addChoicesToFieldSchema, removeChoicesFromFieldSchema } from "../src/mcp/schemas";
import { makeMockClient } from "./mockClient";

var US = "059d29ea47bb4310357690d3706d43c7";
var BR = "a01405ee33d8e2107b18bc534d5c7baa";
var OVERRIDE = "33ad616647f38310276209d3706d4319";
var CHILD = "09ff3d105f231000b12e3572f2b4775d";
var ACK_GLOBAL = { requested: "global", applied: "global", previous: CHILD };

describe("normalizeDomain", function () {
  it("defaults to global when nothing is given", function () {
    expect(DEFAULT_WRITE_DOMAIN).toBe("global");
    expect(normalizeDomain(undefined)).toBe("global");
    expect(normalizeDomain(null)).toBe("global");
    expect(normalizeDomain("")).toBe("global");
    expect(normalizeDomain("   ")).toBe("global");
  });

  it("accepts global in any case and a sys_id in any case (lower-cased)", function () {
    expect(normalizeDomain("GLOBAL")).toBe("global");
    expect(normalizeDomain(" Global ")).toBe("global");
    expect(normalizeDomain(CHILD.toUpperCase())).toBe(CHILD);
  });

  it("refuses anything else instead of silently falling back", function () {
    expect(function () { normalizeDomain("Default"); }).toThrow(/32-character domain sys_id/);
    expect(function () { normalizeDomain("true"); }).toThrow(/got "true"/);
    expect(function () { normalizeDomain(CHILD + "0"); }).toThrow();
    expect(function () { normalizeDomain(5 as unknown as string); }).toThrow(/must be a string/);
  });
});

describe("domain helpers", function () {
  it("domainSnapshot tells a domain-aware row from one whose table has no sys_domain", function () {
    expect(domainSnapshot({ sys_id: "x" })).toEqual({ domainAware: false, overridesSupported: false, domain: "" });
    expect(domainSnapshot({ sys_id: "x", sys_domain: { link: "l", value: "global" }, sys_overrides: "" }))
      .toEqual({ domainAware: true, overridesSupported: true, domain: "global" });
  });

  it("readServerDomainEcho is null for an op that predates domain selection", function () {
    expect(readServerDomainEcho({ sys_id: "x" })).toBeNull();
    expect(readServerDomainEcho(null)).toBeNull();
    expect(readServerDomainEcho({ domain: ACK_GLOBAL })).toEqual({
      requested: "global", applied: "global", previous: CHILD, skipped: undefined
    });
  });

  it("findOverrides reads across domains and re-filters rows client-side", async function () {
    var ctx = makeMockClient({
      query: async function () {
        // An instance that ignored the filter would return unrelated rows too.
        return [
          { sys_id: OVERRIDE, sys_domain: { value: CHILD }, sys_overrides: { value: BR } },
          { sys_id: "ffffffffffffffffffffffffffffffff", sys_domain: "global", sys_overrides: "" }
        ];
      }
    });
    var rows = await findOverrides(ctx.client, "sys_script", [BR, "not-an-id"]);
    expect(rows).toEqual([{ sysId: OVERRIDE, domain: CHILD, overrides: BR }]);
    expect(ctx.calls.tableQuery[0].query).toBe("sys_overridesIN" + BR);
    expect(ctx.calls.tableQuery[0].options.noDomain).toBe(true);
    expect(newOverrides([], rows)).toHaveLength(1);
    expect(newOverrides(rows, rows)).toHaveLength(0);
  });

  it("findOverrides makes no call when no valid sys_id is given", async function () {
    var ctx = makeMockClient({});
    expect(await findOverrides(ctx.client, "sys_script", ["x"])).toEqual([]);
    expect(ctx.calls.tableQuery).toHaveLength(0);
  });
});

/**
 * A domain-aware sys_script fixture. `onWrite` decides what the write does to the
 * instance: update in place, or (the incident) spawn an override row.
 */
function brInstance(opts: { recordDomain: string; behaviour: "in-place" | "override"; ack: boolean }) {
  var record: Record<string, any> = {
    sys_id: BR, script: "old", sys_domain: { value: opts.recordDomain }, sys_overrides: ""
  };
  var overrides: Array<Record<string, any>> = [];
  return makeMockClient({
    query: async function (table: string, query?: string) {
      if (query === "sys_id=" + BR) return [Object.assign({}, record)];
      if (query === "sys_overridesIN" + BR) return overrides.slice();
      return [];
    },
    write: function (op: string, params: any) {
      if (opts.behaviour === "in-place") {
        Object.assign(record, params.fields);
      } else {
        overrides.push({
          sys_id: OVERRIDE, sys_domain: { value: CHILD }, sys_overrides: { value: BR }, script: params.fields.script
        });
      }
      return opts.ack
        ? { sys_id: BR, domain: { requested: params.domain, applied: params.domain, previous: CHILD } }
        : { sys_id: BR };
    }
  });
}

describe("setField --domain", function () {
  it("sends domain=global by default and reads back across domains", async function () {
    var ctx = brInstance({ recordDomain: "global", behaviour: "in-place", ack: true });
    var r = await setField({ client: ctx.client, table: "sys_script", sysId: BR, fields: { script: "new" }, updateSetSysId: US });
    expect(ctx.calls.pushWithUpdateSet[0]).toEqual({
      update_set_sys_id: US, table: "sys_script", record_sys_id: BR, fields: { script: "new" }, domain: "global"
    });
    var reads = ctx.calls.tableQuery.filter(function (q) { return q.query === "sys_id=" + BR; });
    expect(reads.length).toBe(2);
    reads.forEach(function (q) {
      expect(q.options.noDomain).toBe(true);
      expect(q.options.fields).toEqual(expect.arrayContaining(["sys_domain", "sys_overrides", "script"]));
    });
    expect(r.status).toBe("applied");
    expect(r.domain.requested).toBe("global");
    expect(r.domain.actual).toBe("global");
    expect(r.domain.serverAcknowledged).toBe(true);
    expect(r.domain.problems).toEqual([]);
    expect(r.note).toMatch(/sys_domain global, no override created/);
  });

  it("passes an explicit domain sys_id through, normalised", async function () {
    var ctx = brInstance({ recordDomain: CHILD, behaviour: "in-place", ack: true });
    var r = await setField({
      client: ctx.client, table: "sys_script", sysId: BR, fields: { script: "new" }, updateSetSysId: US, domain: CHILD.toUpperCase()
    });
    expect(ctx.calls.pushWithUpdateSet[0].domain).toBe(CHILD);
    expect(r.status).toBe("applied");
  });

  it("refuses an invalid domain before any read or write", async function () {
    var ctx = brInstance({ recordDomain: "global", behaviour: "in-place", ack: true });
    await expect(
      setField({ client: ctx.client, table: "sys_script", sysId: BR, fields: { script: "x" }, updateSetSysId: US, domain: "Default" })
    ).rejects.toThrow(/set-field: --domain must be/);
    expect(ctx.calls.tableQuery).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });

  it("FAILS when the platform creates an override instead of updating in place (the incident)", async function () {
    var ctx = brInstance({ recordDomain: "global", behaviour: "override", ack: false });
    var r = await setField({ client: ctx.client, table: "sys_script", sysId: BR, fields: { script: "new" }, updateSetSysId: US });
    expect(r.status).toBe("failed");
    expect(r.verified).toBe(false);
    expect(r.domain.overridesCreated).toEqual([{ sysId: OVERRIDE, domain: CHILD, overrides: BR }]);
    expect(r.note).toMatch(/DOMAIN CHECK FAILED/);
    expect(r.note).toMatch(/override row\(s\) 33ad6166/);
    expect(r.note).toMatch(/re-run with --domain global/);
    // The op ignored `domain` → the note says the op itself is out of date.
    expect(r.domain.serverAcknowledged).toBe(false);
    expect(r.note).toMatch(/predates domain selection/);
    expect(r.note).toMatch(/Field read-back also differs \(script\)/);
  });

  it("an override that existed BEFORE the write is not blamed on it", async function () {
    var pre = { sys_id: OVERRIDE, sys_domain: { value: CHILD }, sys_overrides: { value: BR } };
    var record: Record<string, any> = { sys_id: BR, script: "old", sys_domain: "global", sys_overrides: "" };
    var ctx = makeMockClient({
      query: async function (_t: string, query?: string) {
        if (query === "sys_id=" + BR) return [Object.assign({}, record)];
        if (query === "sys_overridesIN" + BR) return [pre];
        return [];
      },
      write: function (_op: string, params: any) {
        Object.assign(record, params.fields);
        return { sys_id: BR, domain: ACK_GLOBAL };
      }
    });
    var r = await setField({ client: ctx.client, table: "sys_script", sysId: BR, fields: { script: "new" }, updateSetSysId: US });
    expect(r.status).toBe("applied");
    expect(r.domain.overridesCreated).toEqual([]);
  });

  it("FAILS when the record's sys_domain moved without being asked to", async function () {
    var record: Record<string, any> = { sys_id: BR, script: "old", sys_domain: "global" };
    var ctx = makeMockClient({
      query: async function (_t: string, query?: string) {
        return query === "sys_id=" + BR ? [Object.assign({}, record)] : [];
      },
      write: function (_op: string, params: any) {
        Object.assign(record, params.fields, { sys_domain: CHILD });
        return { sys_id: BR, domain: ACK_GLOBAL };
      }
    });
    var r = await setField({ client: ctx.client, table: "sys_script", sysId: BR, fields: { script: "new" }, updateSetSysId: US });
    expect(r.status).toBe("failed");
    expect(r.domain.problems[0]).toMatch(new RegExp("sys_domain is " + CHILD + ", expected global"));
    expect(r.note).not.toMatch(/predates domain selection/);
  });

  it("an explicit sys_domain field is the expected domain (moving a row to global)", async function () {
    var record: Record<string, any> = { sys_id: BR, sys_domain: CHILD };
    var ctx = makeMockClient({
      query: async function (_t: string, query?: string) {
        return query === "sys_id=" + BR ? [Object.assign({}, record)] : [];
      },
      write: function (_op: string, params: any) {
        Object.assign(record, params.fields);
        return { sys_id: BR, domain: ACK_GLOBAL };
      }
    });
    var r = await setField({ client: ctx.client, table: "sys_script", sysId: BR, fields: { sys_domain: "global" }, updateSetSysId: US });
    expect(r.status).toBe("applied");
    expect(r.domain.expected).toBe("global");
  });

  it("skips every domain check on a table without sys_domain", async function () {
    var ctx = makeMockClient({
      query: async function (_t: string, query?: string) {
        return query === "sys_id=row1" ? [{ sys_id: "row1", order: "20" }] : [];
      }
    });
    var r = await setField({ client: ctx.client, table: "x_t", sysId: "row1", fields: { order: "20" }, updateSetSysId: US });
    expect(r.status).toBe("applied");
    expect(r.domain.domainAware).toBe(false);
    // No overrides query against a table that may not have the column.
    expect(ctx.calls.tableQuery.some(function (q) { return q.query.indexOf("sys_overrides") === 0; })).toBe(false);
  });

  it("dry-run reports the domain it would use and writes nothing", async function () {
    var ctx = brInstance({ recordDomain: "global", behaviour: "in-place", ack: true });
    var r = await setField({ client: ctx.client, table: "sys_script", sysId: BR, fields: { script: "new" }, updateSetSysId: US, dryRun: true });
    expect(r.status).toBe("dry-run");
    expect(r.note).toMatch(/in session domain global/);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });
});

describe("createRecord --domain", function () {
  var NEW = "1234567890abcdef1234567890abcdef";

  function created(storedDomain: string | null, ack: boolean) {
    return makeMockClient({
      query: async function (_t: string, query?: string) {
        if (query !== "sys_id=" + NEW) return [];
        var row: Record<string, any> = { sys_id: NEW, name: "rule" };
        if (storedDomain !== null) row.sys_domain = { value: storedDomain };
        return [row];
      },
      write: function (_op: string, params: any) {
        return ack ? { sys_id: NEW, domain: { requested: params.domain, applied: params.domain, previous: CHILD } } : { sys_id: NEW };
      }
    });
  }

  it("resolveCreateDomain: default global, payload sys_domain implied, explicit wins, conflict refused", function () {
    expect(resolveCreateDomain({ table: "t", fields: { name: "a" } })).toBe("global");
    expect(resolveCreateDomain({ table: "t", fields: { sys_domain: CHILD } })).toBe(CHILD);
    expect(resolveCreateDomain({ table: "t", fields: { sys_domain: "GLOBAL" }, domain: "global" })).toBe("global");
    expect(resolveCreateDomain({ table: "t", fields: { name: "a" }, domain: CHILD })).toBe(CHILD);
    expect(function () {
      resolveCreateDomain({ table: "t", fields: { sys_domain: "global" }, domain: CHILD });
    }).toThrow(/contradicts --domain/);
    expect(function () {
      resolveCreateDomain({ table: "t", fields: { name: "a" }, domain: "nope" });
    }).toThrow(/create-record: --domain must be/);
  });

  it("sends domain=global by default and verifies the stored sys_domain", async function () {
    var ctx = created("global", true);
    var r = await createRecord({ client: ctx.client, table: "sys_script", fields: { name: "rule" }, scope: "x_s", updateSetSysId: US });
    expect(ctx.calls.createRecord[0].domain).toBe("global");
    var readBack = ctx.calls.tableQuery.filter(function (q) { return q.query === "sys_id=" + NEW; })[0];
    expect(readBack.options.noDomain).toBe(true);
    expect(r.status).toBe("created");
    expect(r.domain.actual).toBe("global");
    expect(r.note).toMatch(/sys_domain global/);
  });

  it("FAILS when the insert lands in the session's child domain (the incident)", async function () {
    var ctx = created(CHILD, false);
    var r = await createRecord({
      client: ctx.client, table: "sys_script", fields: { name: "rule", sys_domain: "global" }, scope: "x_s", updateSetSysId: US
    });
    expect(ctx.calls.createRecord[0].domain).toBe("global");
    expect(r.status).toBe("failed");
    expect(r.domain.problems[0]).toMatch(new RegExp("landed in sys_domain " + CHILD + ", not global"));
    expect(r.note).toMatch(/set-field --sys-id 1234567890abcdef1234567890abcdef --fields "sys_domain=global"/);
    expect(r.note).toMatch(/predates domain selection/);
  });

  it("does not double-report a sys_domain payload field as a plain field mismatch", async function () {
    var ctx = created("global", true);
    var r = await createRecord({
      client: ctx.client, table: "sys_script", fields: { name: "rule", sys_domain: "GLOBAL" }, scope: "x_s", updateSetSysId: US
    });
    expect(r.status).toBe("created");
  });

  it("--if-absent counts a row in another domain as present, and flags its domain", async function () {
    var ctx = makeMockClient({
      query: async function (_t: string, query?: string) {
        return query === "name=rule" ? [{ sys_id: NEW, name: "rule", sys_domain: { value: CHILD } }] : [];
      }
    });
    var r = await createRecord({
      client: ctx.client, table: "sys_script", fields: { name: "rule" }, scope: "x_s", updateSetSysId: US, ifAbsentQuery: "name=rule"
    });
    expect(ctx.calls.tableQuery[0].options.noDomain).toBe(true);
    expect(r.status).toBe("skipped");
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/domain differs/);
    expect(ctx.calls.createRecord).toHaveLength(0);
  });
});

describe("add-choices / remove-choices --domain", function () {
  var dictRow = { sys_id: "dict1", name: "x_t", element: "state", choice: "3", sys_scope: "scope_core" };
  var usRow = { sys_id: "us1", name: "set", state: "in progress", application: "scope_core" };
  var CH = "cccccccccccccccccccccccccccccccc";
  var NEWCH = "dddddddddddddddddddddddddddddddd";

  function choiceInstance(opts: { createdDomain: string; updateMakesOverride: boolean; existingLabel: string; inactive?: string }) {
    var overrides: Array<any> = [];
    return makeMockClient({
      query: async function (table: string, query?: string) {
        if (table === "sys_dictionary") return [dictRow];
        if (table === "sys_update_set") return [usRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_s", name: "x_s" }];
        if (table !== "sys_choice") return [];
        if (query === "sys_idIN" + NEWCH) return [{ sys_id: NEWCH, sys_domain: { value: opts.createdDomain } }];
        if (query === "sys_overridesIN" + CH) return overrides.slice();
        if (query && query.indexOf("name=x_t^element=state") === 0) {
          return [{
            sys_id: CH, value: "a", label: opts.existingLabel, sequence: "", language: "en",
            inactive: opts.inactive || "false", sys_domain: "global", sys_overrides: ""
          }];
        }
        return [];
      },
      write: function (op: string, params: any) {
        if (op === "createRecord") return { sys_id: NEWCH, domain: { requested: params.domain, applied: params.domain, previous: CHILD } };
        if (params.table === "sys_choice" && opts.updateMakesOverride) {
          overrides.push({ sys_id: OVERRIDE, sys_domain: { value: CHILD }, sys_overrides: { value: CH } });
        }
        return { sys_id: params.record_sys_id, domain: { requested: params.domain, applied: params.domain, previous: CHILD } };
      }
    });
  }

  it("threads domain=global into every write by default and verifies clean", async function () {
    var ctx = choiceInstance({ createdDomain: "global", updateMakesOverride: false, existingLabel: "Old" });
    var r = await addChoicesToField(ctx.client, {
      table: "x_t", column: "state", updateSetSysId: "us1",
      choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }]
    });
    expect(ctx.calls.pushWithUpdateSet.map(function (c) { return c.domain; })).toEqual(["global"]);
    expect(ctx.calls.createRecord.map(function (c) { return c.domain; })).toEqual(["global"]);
    expect(r.domain).toEqual({ requested: "global", serverAcknowledged: true, overridesCreated: [], problems: [] });
  });

  it("flags a created choice that landed in the child domain", async function () {
    var ctx = choiceInstance({ createdDomain: CHILD, updateMakesOverride: false, existingLabel: "A" });
    var r = await addChoicesToField(ctx.client, {
      table: "x_t", column: "state", updateSetSysId: "us1", choices: [{ value: "b", label: "B" }]
    });
    expect(r.domain && r.domain.problems[0]).toMatch(new RegExp(NEWCH + " \\(sys_domain=" + CHILD + "\\)"));
  });

  it("flags an update the platform diverted into an override", async function () {
    var ctx = choiceInstance({ createdDomain: "global", updateMakesOverride: true, existingLabel: "Old" });
    var r = await addChoicesToField(ctx.client, {
      table: "x_t", column: "state", updateSetSysId: "us1", choices: [{ value: "a", label: "A" }], domain: CHILD
    });
    expect(ctx.calls.pushWithUpdateSet[0].domain).toBe(CHILD);
    expect(r.domain && r.domain.overridesCreated).toEqual([{ sysId: OVERRIDE, domain: CHILD, overrides: CH }]);
  });

  it("dry-run sends nothing and reports no domain problem", async function () {
    var ctx = choiceInstance({ createdDomain: CHILD, updateMakesOverride: true, existingLabel: "Old" });
    var r = await addChoicesToField(ctx.client, {
      table: "x_t", column: "state", updateSetSysId: "us1", choices: [{ value: "a", label: "A" }], dryRun: true
    });
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
    expect(r.domain && r.domain.problems).toEqual([]);
  });

  it("refuses an invalid domain before reading anything", async function () {
    var ctx = choiceInstance({ createdDomain: "global", updateMakesOverride: false, existingLabel: "A" });
    await expect(addChoicesToField(ctx.client, {
      table: "x_t", column: "state", updateSetSysId: "us1", choices: [{ value: "a", label: "A" }], domain: "Default"
    })).rejects.toThrow(/add-choices: domain must be/);
    expect(ctx.calls.tableQuery).toHaveLength(0);
  });

  it("remove-choices threads the domain and catches a diverted deactivation", async function () {
    var ctx = choiceInstance({ createdDomain: "global", updateMakesOverride: true, existingLabel: "A" });
    var r = await removeChoicesFromField(ctx.client, {
      table: "x_t", column: "state", updateSetSysId: "us1", values: ["a"]
    });
    expect(ctx.calls.pushWithUpdateSet[0]).toEqual({
      update_set_sys_id: "us1", table: "sys_choice", record_sys_id: CH, fields: { inactive: "true" }, domain: "global"
    });
    expect(r.domain && r.domain.problems.length).toBe(1);
  });
});

describe("MCP schemas accept domain", function () {
  it("domainSchema: global / sys_id / omitted pass, anything else fails", function () {
    expect(domainSchema.safeParse(undefined).success).toBe(true);
    expect(domainSchema.safeParse("global").success).toBe(true);
    expect(domainSchema.safeParse(CHILD).success).toBe(true);
    expect(domainSchema.safeParse("Default").success).toBe(false);
  });

  it("every write tool's schema carries the domain key", function () {
    [setFieldSchema, createRecordSchema, addChoicesToFieldSchema, removeChoicesFromFieldSchema].forEach(function (schema) {
      expect(Object.keys(schema.shape)).toContain("domain");
    });
  });
});
