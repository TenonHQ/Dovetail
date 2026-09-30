/**
 * defineActionType — merge a spec into a Custom Action Type the way the Flow
 * Designer's Save does. Ground truth: two real Designer saves (trimmed) in
 * tests/fixtures/actionDefine.save1.json / save2.json.
 */

import * as fs from "fs";
import * as path from "path";
import type { ServiceNowClient } from "../src/client";
import {
  canonValue,
  defineActionType,
  planActionDefinition,
  validateDefineSpec,
} from "../src/flowDesigner/defineActionType";
import type { DefineActionSpec } from "../src/flowDesigner/defineActionType";

type Rec = Record<string, any>;

function load(name: string): Rec {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

var SAVE1 = load("actionDefine.save1.json");
var SAVE2 = load("actionDefine.save2.json");
var ACTION = "69b1b09fc3274f10d4ddf1db05013193";
var SCOPE = "c44692d8c366425085b196c4e4013187";
var SCOPE_NAME = "x_cadso_email_spok";
var ALIAS = "956cc622c3ee4a1085b196c4e401317e";
var GUARD_CID = "777e0dc1-1672-443c-a82f-daef21d72a6c";
var REST_CID = "7d49315c-b657-4319-b150-f96c556c95d3";

function byName(list: Array<Rec>, name: string): Rec {
  var hit = list.filter(function (x) { return x.name === name; })[0];
  if (!hit) {
    throw new Error("no entry named " + name);
  }
  return hit;
}
function stepByLabel(list: Array<Rec>, label: string): Rec {
  return list.filter(function (s) { return s.label === label; })[0];
}
function values(step: Rec): Record<string, string> {
  var out: Record<string, string> = {};
  step.inputs.forEach(function (i: Rec) {
    out[i.name] = i.name === "script" ? String(i.value) : canonValue(i.value);
  });
  return out;
}
function scriptOf(step: Rec): string {
  return String(byName(step.inputs, "script").value);
}

/** The model before save 1: the REST step exists, no inputs, no guard. */
function preSave1(): { model: Rec; steps: Array<Rec> } {
  var model = clone(SAVE1.request);
  var rest = clone(stepByLabel(model.steps, "REST step"));
  rest.order = 1;
  model.inputs = [];
  model.label_cache = [];
  model.steps = null;
  return { model: model, steps: [rest] };
}

/** The model before save 2: exactly what the server returned from save 1. */
function preSave2(): { model: Rec; steps: Array<Rec> } {
  var model = clone(SAVE1.response.result) as Rec;
  var steps = model.steps;
  model.steps = null;
  return { model: model, steps: steps };
}

function save1Spec(): DefineActionSpec {
  return {
    inputs: ["host", "path", "content_type", "body"].map(function (n) {
      return { name: n, type: "string" as const, mandatory: true };
    }),
    steps: [
      { ref: "guard", type: "script", label: "Gaurd", script: scriptOf(stepByLabel(SAVE1.request.steps, "Gaurd")) },
      { ref: "rest", type: "rest", label: "REST step" },
    ],
  };
}

var HOST_CHOICES = [
  { value: "api", label: "API" },
  { value: "storage_us_east4", label: "US East 4" },
  { value: "storage_us_west1", label: "US West 1" },
  { value: "storage_europe_west1", label: "Europe West 1" },
];

function save2Spec(): DefineActionSpec {
  return {
    inputs: [
      { name: "host", type: "choice", choices: HOST_CHOICES, default: "api", maxLength: 32 },
      { name: "path", maxLength: 2000 },
      { name: "content_type", mandatory: false, maxLength: 8000 },
      { name: "body", mandatory: false, maxLength: 26000000 },
    ],
    steps: [
      {
        ref: "guard",
        type: "script",
        label: "Gaurd",
        script: scriptOf(stepByLabel(SAVE2.request.steps, "Gaurd")),
        inputs: { host_1: { value: "", mandatory: true }, path_1: { value: "", mandatory: true } },
        outputs: [
          { name: "base_url", label: "Base URL", type: "string" },
          { name: "error", label: "Error", type: "string" },
        ],
      },
      {
        ref: "rest",
        type: "rest",
        label: "REST step",
        errorHandling: "NEXT_STEP",
        values: {
          connection_alias: { value: ALIAS, display: "x_cadso_email_spok.Email_Spoke_Connection" },
          override_base_url: true,
          base_url: "{{steps.guard.base_url}}",
          resource_path: "{{action.path}}",
          http_method: "get",
          query_params: [],
          headers: [
            { name: "Content-Type", value: "{{action.content_type}}" },
            { name: "Accept", value: "application/json" },
          ],
          save_response_as_attachment: false,
          is_streaming: false,
          is_temporary_attachment: false,
          enable_retry_policy: false,
          override_default_policy_for_alias: false,
        },
      },
    ],
    outputs: [
      { name: "status_code", label: "Status Code", value: "{{steps.rest.status_code}}" },
      { name: "response_body", label: "Response Body", value: "{{steps.rest.response_body}}" },
      { name: "error", label: "Error", value: "{{steps.rest.error_message}}" },
    ],
  };
}

describe("planActionDefinition — reproduces the Designer's saves", function () {
  it("save 1: 4 action inputs + a new script step before the existing REST step", function () {
    var pre = preSave1();
    var plan = planActionDefinition({
      model: pre.model, steps: pre.steps, spec: save1Spec(), sysId: ACTION,
      newCid: function () { return GUARD_CID; },
    });
    var want = SAVE1.request;
    var body = plan.body as Rec;

    expect(body.inputs.map(function (i: Rec) { return [i.name, i.type, i.mandatory, i.order]; }))
      .toEqual(want.inputs.map(function (i: Rec) { return [i.name, i.type, i.mandatory, i.order]; }));

    var ident = function (s: Rec): Array<unknown> {
      return [s.DB_TYPE, s.cid, s.step_type_id, s.label, s.order, s.error_handling_type, s.action];
    };
    expect(body.steps.map(ident)).toEqual(want.steps.map(ident));
    // The Designer's 11-key step shape.
    body.steps.forEach(function (s: Rec) {
      expect(Object.keys(s).sort()).toEqual([
        "DB_TYPE", "action", "cid", "error_handling_type", "extended_inputs", "extended_outputs",
        "inputs", "label", "order", "section", "step_type_id",
      ]);
    });
    // A fresh script step: same input set as the Designer's, defaults, the script.
    var guard = stepByLabel(body.steps, "Gaurd");
    var wantGuard = stepByLabel(want.steps, "Gaurd");
    expect(guard.inputs.map(function (i: Rec) { return i.name; }))
      .toEqual(wantGuard.inputs.map(function (i: Rec) { return i.name; }));
    expect(values(guard)).toEqual(values(wantGuard));
    expect(byName(guard.inputs, "script")).toEqual({ name: "script", value: scriptOf(wantGuard) });
    // The REST step was untouched (cid kept, values as they were).
    expect(values(stepByLabel(body.steps, "REST step"))).toEqual(values(stepByLabel(want.steps, "REST step")));

    expect(plan.diff.inputs.added).toEqual(["host", "path", "content_type", "body"]);
    expect(plan.diff.steps.added.map(function (s) { return s.label; })).toEqual(["Gaurd"]);
    expect(plan.diff.steps.removed).toEqual([]);
    expect(plan.stepRefs).toEqual({ guard: GUARD_CID, rest: REST_CID });
  });

  it("save 2: choice input, script IO, REST step wired with pills, wired action outputs", function () {
    var pre = preSave2();
    var plan = planActionDefinition({ model: pre.model, steps: pre.steps, spec: save2Spec(), sysId: ACTION });
    var want = SAVE2.request;
    var body = plan.body as Rec;

    ["host", "path", "content_type", "body"].forEach(function (n) {
      var got = byName(body.inputs, n);
      var exp = byName(want.inputs, n);
      expect([got.type, got.type_label, got.mandatory, got.order, String(got.maxsize), got.defaultValue || ""])
        .toEqual([exp.type, exp.type_label, exp.mandatory, exp.order, String(exp.maxsize), exp.defaultValue || ""]);
    });
    expect(byName(body.inputs, "host").choices).toEqual(byName(want.inputs, "host").choices);
    expect(byName(body.inputs, "host").choiceType).toBe("1");

    // Action output wiring: the pill sits in the output's own value/display_value.
    ["status_code", "response_body", "error"].forEach(function (n) {
      var got = byName(body.outputs, n);
      var exp = byName(want.outputs, n);
      expect([got.label, got.type, got.value, got.display_value]).toEqual([exp.label, exp.type, exp.value, exp.display_value]);
    });
    // System outputs are carried through untouched.
    expect(byName(body.outputs, "__action_status__").value).toBe(byName(SAVE1.response.result.outputs, "__action_status__").value);

    var guard = stepByLabel(body.steps, "Gaurd");
    var wantGuard = stepByLabel(want.steps, "Gaurd");
    expect(guard.cid).toBe(GUARD_CID);
    expect(scriptOf(guard)).toBe(scriptOf(wantGuard));
    var io = function (list: Array<Rec>): Array<unknown> {
      return list.map(function (e) { return [e.name, e.type, e.mandatory, e.value === undefined ? "" : e.value]; });
    };
    expect(io(guard.extended_inputs)).toEqual(io(wantGuard.extended_inputs));
    expect(guard.extended_outputs.map(function (e: Rec) { return [e.name, e.label, e.type, e.cid, e.step_name]; }))
      .toEqual(wantGuard.extended_outputs.map(function (e: Rec) { return [e.name, e.label, e.type, e.cid, e.step_name]; }));

    var rest = stepByLabel(body.steps, "REST step");
    var wantRest = stepByLabel(want.steps, "REST step");
    expect(rest.cid).toBe(REST_CID);
    expect(rest.error_handling_type).toBe("NEXT_STEP");
    expect(values(rest)).toEqual(values(wantRest));
    expect(byName(rest.inputs, "base_url").value).toBe("{{step[" + GUARD_CID + "].base_url}}");
    expect(JSON.parse(byName(rest.inputs, "headers").value)).toEqual(JSON.parse(byName(wantRest.inputs, "headers").value));

    // The label cache lists every pill in use, like the Designer's. (The Designer's
    // also has the guard's `error` pill: save 2 added an action-status error
    // condition, which this spec does not author.)
    var cacheNames = body.label_cache.map(function (c: Rec) { return c.name; }).sort();
    expect(cacheNames).toEqual(want.label_cache.map(function (c: Rec) { return c.name; }).filter(function (n: string) {
      return n !== "{{step[" + GUARD_CID + "].error}}";
    }).sort());
  });

  it("re-planning the saved result is an empty diff", function () {
    var pre = preSave2();
    var first = planActionDefinition({ model: pre.model, steps: pre.steps, spec: save2Spec(), sysId: ACTION });
    var saved = clone(first.body) as Rec;
    var steps = saved.steps;
    saved.steps = null;
    var second = planActionDefinition({ model: saved, steps: steps, spec: save2Spec(), sysId: ACTION });
    expect(second.diff.empty).toBe(true);
  });
});

describe("planActionDefinition — pills and validation", function () {
  function plan(spec: DefineActionSpec): ReturnType<typeof planActionDefinition> {
    var pre = preSave2();
    return planActionDefinition({ model: pre.model, steps: pre.steps, spec: spec, sysId: ACTION });
  }

  it("resolves {{steps.<ref>.<out>}} to {{step[<cid>].<out>}} and keeps raw pills", function () {
    var p = plan({
      steps: [
        { ref: "g", type: "script", label: "Gaurd", outputs: [{ name: "base_url" }] },
        { ref: "r", type: "rest", label: "REST step", values: { base_url: "{{steps.g.base_url}}/x", resource_path: "{{step[" + GUARD_CID + "].base_url}}" } },
      ],
    });
    var rest = stepByLabel((p.body as Rec).steps, "REST step");
    expect(byName(rest.inputs, "base_url").value).toBe("{{step[" + GUARD_CID + "].base_url}}/x");
    expect(byName(rest.inputs, "resource_path").value).toBe("{{step[" + GUARD_CID + "].base_url}}");
  });

  it("rejects an unknown step ref, an unknown action input and an unknown step output", function () {
    expect(function () {
      plan({ outputs: [{ name: "x", value: "{{steps.nope.status_code}}" }] });
    }).toThrow(/unknown step ref 'nope'/);
    expect(function () {
      plan({ steps: [{ ref: "r", type: "rest", label: "REST step", values: { resource_path: "{{action.missing}}" } }] });
    }).toThrow(/unknown action input 'missing'/);
    expect(function () {
      plan({ steps: [{ ref: "r", type: "rest", label: "REST step" }], outputs: [{ name: "x", value: "{{steps.r.nope}}" }] });
    }).toThrow(/has no output 'nope'/);
  });

  it("rejects a pill that reads a step which runs later", function () {
    expect(function () {
      plan({
        steps: [
          { ref: "g", type: "script", label: "Gaurd", inputs: { status: "{{steps.r.status_code}}" } },
          { ref: "r", type: "rest", label: "REST step" },
        ],
      });
    }).toThrow(/does not run before this step/);
  });

  it("rejects unknown spec keys, an unsupported step type, bad names and unknown step inputs", function () {
    expect(function () { validateDefineSpec({ bogus: 1 }); }).toThrow(/unknown key 'bogus' in spec/);
    expect(function () {
      validateDefineSpec({ steps: [{ ref: "a", type: "rest", label: "A", colour: "red" }] });
    }).toThrow(/unknown key 'colour'/);
    expect(function () {
      validateDefineSpec({ steps: [{ ref: "a", type: "lookup", label: "A" }] });
    }).toThrow(/not a supported step type/);
    expect(function () { validateDefineSpec({ inputs: [{ name: "a^b" }] }); }).toThrow(/invalid/);
    expect(function () { validateDefineSpec({ inputs: [{ name: "a/b" }] }); }).toThrow(/invalid/);
    expect(function () { validateDefineSpec({ inputs: [{ name: "x", type: "reference" }] }); }).toThrow(/not supported/);
    expect(function () {
      plan({ steps: [{ ref: "r", type: "rest", label: "REST step", values: { verb: "get" } }] });
    }).toThrow(/has no input 'verb'/);
    expect(function () {
      plan({ steps: [{ ref: "r", type: "script", label: "REST step" }] });
    }).toThrow(/rest step/);
  });

  it("refuses to leave a dangling pill (removing an input still in use)", function () {
    var pre = preSave2();
    var first = planActionDefinition({ model: pre.model, steps: pre.steps, spec: save2Spec(), sysId: ACTION });
    var saved = clone(first.body) as Rec;
    var steps = saved.steps;
    saved.steps = null;
    expect(function () {
      planActionDefinition({ model: saved, steps: steps, spec: { inputs: [{ name: "path", remove: true }] }, sysId: ACTION });
    }).toThrow(/dangling data pills/);
  });

  it("matches by order when the label changed, keeping the cid, and renames", function () {
    var p = plan({
      steps: [
        { ref: "guard", type: "script", label: "Guard" },
        { ref: "call", type: "rest", label: "Call email service" },
      ],
    });
    var steps = (p.body as Rec).steps;
    expect(steps.map(function (s: Rec) { return [s.label, s.cid]; }))
      .toEqual([["Guard", GUARD_CID], ["Call email service", REST_CID]]);
    expect(p.diff.steps.added).toEqual([]);
    expect(p.diff.steps.changed.map(function (s) { return s.matchedBy; })).toEqual(["order", "order"]);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — a fake processflow server
// ---------------------------------------------------------------------------

interface Server {
  client: ServiceNowClient;
  puts: Array<Rec>;
  posts: Array<{ path: string; body: Rec }>;
  updateSets: Array<string>;
  gets: Array<string>;
}

function makeServer(start: { model: Rec; steps: Array<Rec> }): Server {
  var model = clone(start.model);
  var steps = clone(start.steps);
  var s: Server = { client: null as unknown as ServiceNowClient, puts: [], posts: [], updateSets: [], gets: [] };
  s.client = {
    table: {
      query: async function (table: string, query: string) {
        if (table === "sys_scope" && (query === "scope=" + SCOPE_NAME || query === "sys_id=" + SCOPE)) {
          return [{ sys_id: SCOPE, scope: SCOPE_NAME }];
        }
        if (table === "sys_alias" && query === "sys_id=" + ALIAS) {
          return [{ sys_id: ALIAS, id: "x_cadso_email_spok.Email_Spoke_Connection", name: "Email Spoke Connection" }];
        }
        return [];
      },
    },
    claude: {
      changeUpdateSet: async function (p: { sysId: string }) { s.updateSets.push(p.sysId); return {}; },
    },
    now: {
      get: async function (p: string) {
        s.gets.push(p);
        if (p.indexOf("/step_instances") !== -1) {
          return { result: { steps: clone(steps) } };
        }
        return { result: clone(model) };
      },
      put: async function (p: string, body: Rec) {
        s.puts.push(clone(body));
        steps = clone(body.steps);
        model = clone(body);
        model.steps = null;
        model.state = "draft";
        return { result: Object.assign(clone(body), { state: "draft" }) };
      },
      post: async function (p: string, body: Rec) {
        s.posts.push({ path: p, body: clone(body) });
        model.state = "published";
        return { result: { latest_snapshot: "9".repeat(32) } };
      },
    },
  } as unknown as ServiceNowClient;
  return s;
}

describe("defineActionType — dry-run / confirm / publish / idempotency", function () {
  it("dry-run by default: the planned diff, zero PUTs, zero publishes", async function () {
    var srv = makeServer(preSave2());
    var res = await defineActionType({ client: srv.client, sysId: ACTION, scope: SCOPE_NAME, spec: save2Spec() });
    expect(res.status).toBe("planned");
    expect(res.diff.empty).toBe(false);
    expect(res.diff.outputs.added).toEqual(["status_code", "response_body", "error"]);
    expect(res.diff.inputs.changed.map(function (c) { return c.name; })).toEqual(["host", "path", "content_type", "body"]);
    var rest = res.diff.steps.changed.filter(function (s) { return s.label === "REST step"; })[0];
    expect(rest.changes).toContain("base_url: 'https://api.mailgun.net' -> '{{step[" + GUARD_CID + "].base_url}}'");
    expect(srv.puts).toHaveLength(0);
    expect(srv.posts).toHaveLength(0);
  });

  it("dryRun:true wins over confirm:true", async function () {
    var srv = makeServer(preSave2());
    var res = await defineActionType({
      client: srv.client, sysId: ACTION, scope: SCOPE, spec: save2Spec(), confirm: true, dryRun: true, publish: true,
    });
    expect(res.status).toBe("planned");
    expect(srv.puts).toHaveLength(0);
    expect(srv.posts).toHaveLength(0);
  });

  it("confirm PUTs the full model to the action path, verifies, and does not publish", async function () {
    var srv = makeServer(preSave2());
    var res = await defineActionType({
      client: srv.client, sysId: ACTION, scope: SCOPE_NAME, spec: save2Spec(), confirm: true, updateSetSysId: "u".repeat(32),
    });
    expect(res.status).toBe("saved");
    expect(srv.puts).toHaveLength(1);
    expect(srv.posts).toHaveLength(0);
    expect(srv.updateSets).toEqual(["u".repeat(32)]);
    expect(Object.keys(srv.puts[0]).length).toBe(Object.keys(SAVE1.response.result).length);
    expect(res.verify && res.verify.ok).toBe(true);
    // Existing cids preserved through the save.
    expect(srv.puts[0].steps.map(function (s: Rec) { return s.cid; })).toEqual([GUARD_CID, REST_CID]);
  });

  it("is idempotent: re-applying the same spec is 'unchanged' with no PUT", async function () {
    var srv = makeServer(preSave2());
    await defineActionType({ client: srv.client, sysId: ACTION, scope: SCOPE_NAME, spec: save2Spec(), confirm: true });
    var again = await defineActionType({ client: srv.client, sysId: ACTION, scope: SCOPE_NAME, spec: save2Spec(), confirm: true });
    expect(again.status).toBe("unchanged");
    expect(again.diff.empty).toBe(true);
    expect(srv.puts).toHaveLength(1);
  });

  it("publishes only with publish:true — after the save, with the saved steps", async function () {
    var srv = makeServer(preSave2());
    var res = await defineActionType({
      client: srv.client, sysId: ACTION, scope: SCOPE_NAME, spec: save2Spec(), confirm: true, publish: true,
    });
    expect(srv.puts).toHaveLength(1);
    expect(srv.posts).toHaveLength(1);
    expect(srv.posts[0].path).toContain("/action_types/" + ACTION + "/snapshot?sysparm_transaction_scope=" + SCOPE);
    expect(srv.posts[0].body.steps.map(function (s: Rec) { return s.cid; })).toEqual([GUARD_CID, REST_CID]);
    expect(res.publish && res.publish.httpStatus).toBe(201);
    // Nothing changed and already published: no second publish.
    var again = await defineActionType({
      client: srv.client, sysId: ACTION, scope: SCOPE_NAME, spec: save2Spec(), confirm: true, publish: true,
    });
    expect(again.status).toBe("unchanged");
    expect(srv.posts).toHaveLength(1);
  });

  it("resolves a bare connection_alias sys_id to its display via sys_alias", async function () {
    var srv = makeServer(preSave1());
    var res = await defineActionType({
      client: srv.client, sysId: ACTION, scope: SCOPE_NAME, confirm: true,
      spec: { steps: [{ ref: "r", type: "rest", label: "REST step", values: { connection_alias: ALIAS } }] },
    });
    expect(res.status).toBe("unchanged"); // same alias sys_id as already set
    var srv2 = makeServer(preSave2());
    var res2 = await defineActionType({
      client: srv2.client, sysId: ACTION, scope: SCOPE_NAME,
      spec: { steps: [{ ref: "r", type: "rest", label: "REST step", values: { connection_alias: "a".repeat(32) } }] },
    }).catch(function (e: Error) { return e; });
    expect(String(res2)).toMatch(/no sys_alias record/);
  });

  it("refuses an invalid spec before any request, and a scope mismatch before any write", async function () {
    var srv = makeServer(preSave2());
    await expect(defineActionType({
      client: srv.client, sysId: ACTION, scope: SCOPE_NAME, spec: { nope: true } as unknown as DefineActionSpec,
    })).rejects.toThrow(/unknown key 'nope'/);
    expect(srv.gets).toHaveLength(0);

    var other = preSave2();
    other.model.scope = "b".repeat(32);
    var srv2 = makeServer(other);
    await expect(defineActionType({
      client: srv2.client, sysId: ACTION, scope: SCOPE_NAME, spec: save2Spec(), confirm: true,
    })).rejects.toThrow(/lives in scope/);
    expect(srv2.puts).toHaveLength(0);
  });
});

describe("the documented example spec (Email Service Request GET)", function () {
  it("plans cleanly against the action as saved, wires the guard, and re-plans empty", function () {
    var example = load("actionDefine.example.json") as DefineActionSpec;
    var model = clone(SAVE2.response.result) as Rec;
    var steps = model.steps;
    model.steps = null;
    var p = planActionDefinition({ model: model, steps: steps, spec: example, sysId: ACTION });
    var body = p.body as Rec;
    var guard = stepByLabel(body.steps, "Guard");
    var call = stepByLabel(body.steps, "Call email service");
    expect([guard.cid, call.cid]).toEqual([GUARD_CID, REST_CID]);
    expect(byName(guard.extended_inputs, "host_1").value).toBe("{{action.host}}");
    expect(byName(guard.extended_inputs, "path_1").value).toBe("{{action.path}}");
    expect(byName(call.inputs, "connection_timeout").value).toBe("25000");
    expect(byName(call.inputs, "base_url").value).toBe("{{step[" + GUARD_CID + "].base_url}}");
    expect(p.diff.steps.added).toEqual([]);

    var saved = clone(body);
    var savedSteps = saved.steps;
    saved.steps = null;
    var again = planActionDefinition({ model: saved, steps: savedSteps, spec: example, sysId: ACTION });
    expect(again.diff.empty).toBe(true);
  });
});
