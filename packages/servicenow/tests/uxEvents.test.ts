import {
  parseNowUiActions,
  classifyAction,
  splitGlideList,
  appendToGlideList,
  syncUxEvents,
  formatUxEventSync,
} from "../src/uxEvents";
import type { ExistingEvent, UxAction } from "../src/uxEvents";
import { makeMockClient } from "./mockClient";
import type { MockClientCtx } from "./mockClient";

var SCOPE = "d4b29430871812d0369f33373cbb35a8";
var OTHER_SCOPE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
var LIB = "026c1b3b322b1446a3ac88223f58da1d";
var MAC = "6bbf730dbab06fa475732d71d54d5353";
var US = "20756100334a03107b18bc534d5c7b2b";
var EV_A = "11111111111111111111111111111111";
var EV_B = "22222222222222222222222222222222";
var EV_ORPHAN = "33333333333333333333333333333333";

function action(name: string, label?: string, description?: string): UxAction {
  return { name: name, label: label || name, description: description || "" };
}

function ev(sysId: string, name: string, scope: string, label?: string): ExistingEvent {
  return { sysId: sysId, eventName: name, label: label || name, description: "", scopeSysId: scope };
}

var NOW_UI = {
  scopeName: "x_cadso_ui_journey",
  components: {
    "cadso-journey-builder": {
      innerComponents: [],
      actions: [
        { name: "TENON_JB_X_A", label: "A (JB)", description: "a" },
        { name: "TENON_JB_X_B", label: "B (JB)", description: "b" },
        { name: "TENON_JB_X_SAVE_ERROR", label: "Save Error (JB)", description: "save failed" },
      ],
    },
    "cadso-journey-archive-modal": { actions: [] },
  },
};

type Row = Record<string, unknown>;

interface WorldOpts {
  dispatched: string;
  events: Array<Row>;
  macroponents?: number;
}

/** Stateful fake instance: creates and dispatched_events pushes are visible to later reads. */
function world(opts: WorldOpts): MockClientCtx {
  var ctx: MockClientCtx;
  var created: Array<Row> = [];
  function dispatched(): string {
    var pushes = ctx.calls.pushWithUpdateSet;
    return pushes.length > 0 ? String(pushes[pushes.length - 1].fields.dispatched_events) : opts.dispatched;
  }
  function allEvents(): Array<Row> {
    return opts.events.concat(created);
  }
  ctx = makeMockClient({
    query: async function (table: string, query?: string) {
      var q = query || "";
      if (table === "sys_ux_lib_component") return q === "tag=cadso-journey-builder" ? [{ sys_id: LIB }] : [];
      if (table === "sys_scope") return [{ scope: "x_cadso_ui_journey" }];
      if (table === "sys_ux_macroponent") {
        var n = opts.macroponents === undefined ? 1 : opts.macroponents;
        var rows: Array<Row> = [];
        for (var i = 0; i < n; i += 1) {
          rows.push({
            sys_id: i === 0 ? MAC : "m" + i,
            name: "Tenon Journey Builder",
            sys_scope: { value: SCOPE },
            dispatched_events: dispatched(),
          });
        }
        return q.indexOf("sys_id=") === 0 ? rows.slice(0, 1) : rows;
      }
      if (table === "sys_ux_event") {
        if (q.indexOf("event_nameIN") === 0) {
          var names = q.slice("event_nameIN".length).split(",");
          return allEvents().filter(function (r) { return names.indexOf(String(r.event_name)) !== -1; });
        }
        if (q.indexOf("sys_idIN") === 0) {
          var ids = q.slice("sys_idIN".length).split(",");
          return allEvents().filter(function (r) { return ids.indexOf(String(r.sys_id)) !== -1; });
        }
        if (q.indexOf("sys_id=") === 0) {
          var id = q.slice("sys_id=".length);
          return allEvents().filter(function (r) { return r.sys_id === id; });
        }
        if (q.indexOf("event_name=") === 0) {
          var en = q.slice("event_name=".length).split("^")[0];
          return allEvents().filter(function (r) { return r.event_name === en && r.sys_scope === SCOPE; });
        }
      }
      return [];
    },
  });
  var origCreate = ctx.client.claude.createRecord;
  ctx.client.claude.createRecord = async function (params) {
    var res = await origCreate(params);
    created.push(Object.assign({ sys_id: res.sys_id, sys_scope: SCOPE }, params.fields));
    return res;
  };
  return ctx;
}

describe("parseNowUiActions", function () {
  it("returns components with actions, defaulting label to the name", function () {
    var out = parseNowUiActions({ components: { "x-a": { actions: [{ name: "EV_ONE" }] }, "x-b": {} } });
    expect(out).toEqual([{ tag: "x-a", actions: [{ name: "EV_ONE", label: "EV_ONE", description: "" }] }]);
  });

  it("rejects a manifest without components", function () {
    expect(function () { parseNowUiActions({ nope: 1 }); }).toThrow(/not a valid component manifest/);
  });

  it("rejects an event name that could break an encoded query", function () {
    expect(function () {
      parseNowUiActions({ components: { "x-a": { actions: [{ name: "EV^ORsys_id!=x" }] } } });
    }).toThrow(/action name must match/);
  });

  it("rejects an invalid component tag", function () {
    expect(function () {
      parseNowUiActions({ components: { "Bad Tag": { actions: [{ name: "EV" }] } } });
    }).toThrow(/invalid component tag/);
  });

  it("rejects duplicate action names in one component", function () {
    expect(function () {
      parseNowUiActions({ components: { "x-a": { actions: [{ name: "EV" }, { name: "EV" }] } } });
    }).toThrow(/twice/);
  });
});

describe("glide list helpers", function () {
  it("splitGlideList drops blanks and whitespace", function () {
    expect(splitGlideList("")).toEqual([]);
    expect(splitGlideList(" a, ,b ,")).toEqual(["a", "b"]);
  });

  it("appendToGlideList keeps order and skips duplicates", function () {
    expect(appendToGlideList(["b", "a"], ["a", "c", "c", ""])).toEqual(["b", "a", "c"]);
    expect(appendToGlideList([], ["x"])).toEqual(["x"]);
  });
});

describe("classifyAction", function () {
  it("create when no record carries the name", function () {
    expect(classifyAction(action("E"), [], [], SCOPE).status).toBe("create");
  });

  it("ok when linked and matching", function () {
    var p = classifyAction(action("E"), [ev(EV_A, "E", SCOPE)], [EV_A], SCOPE);
    expect(p.status).toBe("ok");
    expect(p.needsLink).toBe(false);
  });

  it("link when the record exists but is not listed", function () {
    var p = classifyAction(action("E"), [ev(EV_A, "E", SCOPE)], [], SCOPE);
    expect(p.status).toBe("link");
    expect(p.eventSysId).toBe(EV_A);
  });

  it("drift when linked but the label differs — reported, not linked again", function () {
    var p = classifyAction(action("E", "New"), [ev(EV_A, "E", SCOPE, "Old")], [EV_A], SCOPE);
    expect(p.status).toBe("drift");
    expect(p.needsLink).toBe(false);
    expect(p.detail).toContain("Old");
  });

  it("prefers the linked candidate, then the in-scope one", function () {
    var linked = classifyAction(action("E"), [ev(EV_A, "E", OTHER_SCOPE), ev(EV_B, "E", SCOPE)], [EV_A], SCOPE);
    expect(linked.eventSysId).toBe(EV_A);
    var inScope = classifyAction(action("E"), [ev(EV_A, "E", OTHER_SCOPE), ev(EV_B, "E", SCOPE)], [], SCOPE);
    expect(inScope.eventSysId).toBe(EV_B);
  });

  it("ambiguous when two candidates tie", function () {
    var p = classifyAction(action("E"), [ev(EV_A, "E", SCOPE), ev(EV_B, "E", SCOPE)], [], SCOPE);
    expect(p.status).toBe("ambiguous");
    expect(p.needsLink).toBe(false);
  });
});

describe("syncUxEvents", function () {
  function baseWorld(extra?: Partial<WorldOpts>): MockClientCtx {
    return world(Object.assign({
      dispatched: EV_A + "," + EV_B + "," + EV_ORPHAN,
      events: [
        { sys_id: EV_A, event_name: "TENON_JB_X_A", label: "A (JB)", description: "a", sys_scope: { value: SCOPE } },
        { sys_id: EV_B, event_name: "TENON_JB_X_B", label: "B (JB)", description: "b", sys_scope: { value: SCOPE } },
        { sys_id: EV_ORPHAN, event_name: "TENON_JB_X_GONE", label: "Gone", description: "", sys_scope: { value: SCOPE } },
      ],
    }, extra || {}));
  }

  it("dry-run plans exactly the missing event, reports the orphan, writes nothing", async function () {
    var ctx = baseWorld();
    var r = await syncUxEvents({ client: ctx.client, nowUi: NOW_UI });
    expect(r.mode).toBe("dry-run");
    expect(r.ok).toBe(true);
    expect(r.pending).toBe(1);
    var c = r.components[0];
    expect(c.macroponentSysId).toBe(MAC);
    expect(c.scopeName).toBe("x_cadso_ui_journey");
    var statuses = c.actions.map(function (a) { return a.name + ":" + a.status; });
    expect(statuses).toEqual(["TENON_JB_X_A:ok", "TENON_JB_X_B:ok", "TENON_JB_X_SAVE_ERROR:create"]);
    expect(c.orphans).toEqual([{ sysId: EV_ORPHAN, eventName: "TENON_JB_X_GONE" }]);
    expect(ctx.calls.createRecord.length).toBe(0);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
    expect(formatUxEventSync(r)).toContain("[create] TENON_JB_X_SAVE_ERROR");
  });

  it("apply creates in scope, appends to dispatched_events, verifies", async function () {
    var ctx = baseWorld();
    var r = await syncUxEvents({ client: ctx.client, nowUi: NOW_UI, apply: true, updateSetSysId: US });
    expect(r.ok).toBe(true);
    expect(ctx.calls.createRecord.length).toBe(1);
    var cr = ctx.calls.createRecord[0];
    expect(cr.table).toBe("sys_ux_event");
    expect(cr.scope).toBe("x_cadso_ui_journey");
    expect(cr.update_set_sys_id).toBe(US);
    expect(cr.fields.event_name).toBe("TENON_JB_X_SAVE_ERROR");
    expect(cr.fields.label).toBe("Save Error (JB)");
    expect(ctx.calls.pushWithUpdateSet.length).toBe(1);
    var push = ctx.calls.pushWithUpdateSet[0];
    expect(push.table).toBe("sys_ux_macroponent");
    expect(push.record_sys_id).toBe(MAC);
    expect(push.fields.dispatched_events).toBe([EV_A, EV_B, EV_ORPHAN, "new_1"].join(","));
    expect(r.components[0].verified).toBe(true);
    expect(r.components[0].linked).toEqual(["new_1"]);
  });

  it("links an existing-but-unlisted event without creating it", async function () {
    var ctx = baseWorld({ dispatched: EV_A });
    var r = await syncUxEvents({
      client: ctx.client,
      nowUi: { components: { "cadso-journey-builder": { actions: [{ name: "TENON_JB_X_A", label: "A (JB)", description: "a" }, { name: "TENON_JB_X_B", label: "B (JB)", description: "b" }] } } },
      apply: true,
      updateSetSysId: US,
    });
    expect(r.ok).toBe(true);
    expect(ctx.calls.createRecord.length).toBe(0);
    expect(ctx.calls.pushWithUpdateSet[0].fields.dispatched_events).toBe(EV_A + "," + EV_B);
  });

  it("is a no-op when everything is in sync", async function () {
    var ctx = baseWorld();
    var r = await syncUxEvents({
      client: ctx.client,
      nowUi: { components: { "cadso-journey-builder": { actions: [{ name: "TENON_JB_X_A", label: "A (JB)", description: "a" }] } } },
      apply: true,
      updateSetSysId: US,
    });
    expect(r.ok).toBe(true);
    expect(r.pending).toBe(0);
    expect(ctx.calls.createRecord.length).toBe(0);
    expect(ctx.calls.pushWithUpdateSet.length).toBe(0);
  });

  it("refuses to apply without a valid update set", async function () {
    var ctx = baseWorld();
    await expect(syncUxEvents({ client: ctx.client, nowUi: NOW_UI, apply: true })).rejects.toThrow(/--update-set/);
    await expect(
      syncUxEvents({ client: ctx.client, nowUi: NOW_UI, apply: true, updateSetSysId: "x^y" }),
    ).rejects.toThrow(/--update-set/);
  });

  it("an ambiguous macroponent is not ok and writes nothing", async function () {
    var ctx = baseWorld({ macroponents: 2 });
    var r = await syncUxEvents({ client: ctx.client, nowUi: NOW_UI, apply: true, updateSetSysId: US });
    expect(r.ok).toBe(false);
    expect(r.components[0].status).toBe("ambiguous-macroponent");
    expect(ctx.calls.createRecord.length).toBe(0);
  });

  it("a component with no lib component is reported, not written", async function () {
    var ctx = baseWorld();
    var r = await syncUxEvents({ client: ctx.client, nowUi: { components: { "x-missing": { actions: [{ name: "EV" }] } } } });
    expect(r.ok).toBe(false);
    expect(r.components[0].status).toBe("no-macroponent");
  });

  it("--component filters and rejects an unknown tag", async function () {
    var ctx = baseWorld();
    await expect(
      syncUxEvents({ client: ctx.client, nowUi: NOW_UI, component: "cadso-journey-archive-modal" }),
    ).rejects.toThrow(/declares no actions/);
    await expect(
      syncUxEvents({ client: ctx.client, nowUi: NOW_UI, component: "Bad^Tag" }),
    ).rejects.toThrow(/invalid --component/);
  });
});
