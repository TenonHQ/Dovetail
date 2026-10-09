import { editFlow } from "../src/flowDesigner/editFlow";
import { testFlow, DEFAULT_RUN_FLOW_PATH, LEGACY_RUN_FLOW_PATH } from "../src/flowDesigner/testFlow";
import type { ServiceNowClient } from "../src/client";

interface Cap {
  gets: Array<string>;
  posts: Array<{ path: string; body: any }>;
  invokes: Array<{ method: string; path: string; body: any }>;
  queries: Array<{ table: string; query: string }>;
}

function mockClient(opts: {
  getResponse?: any;
  getResponses?: Array<any>;
  postResponse?: any;
  postThrows?: Error;
  // Consumed sequentially by now.invoke; the last entry repeats.
  invokeResponses?: Array<{ status: number; body: unknown }>;
  queryRows?: Array<Record<string, unknown>>;
}): {
  client: ServiceNowClient;
  cap: Cap;
} {
  var cap: Cap = { gets: [], posts: [], invokes: [], queries: [] };
  var invokeIdx = 0;
  // getResponses (if provided) is consumed sequentially — index 0 is the initial
  // model read, index 1 the post-publish verify read. Falls back to getResponse.
  var getIdx = 0;
  var client = {
    table: {
      query: async function (table: string, query: string) {
        cap.queries.push({ table: table, query: query });
        return (opts.queryRows || []) as any;
      },
    },
    buildAgent: {
      runQuery: async function () { return []; },
      getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; },
    },
    claude: {
      createRecord: async function () { return { sys_id: "x" }; },
      pushWithUpdateSet: async function () { return { sys_id: "x" }; },
      currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
      changeUpdateSet: async function () { return {}; },
      deleteRecord: async function () { return {}; },
    },
    attachment: {
      listFor: async function () { return []; },
      upload: async function () { return { sys_id: "att", file_name: "", content_type: "" }; },
      remove: async function () { return undefined; }
    },
    now: {
      put: async function () { return {} as any; },
      delete: async function () { return {} as any; },
      invoke: async function (p: { method: string; path: string; body?: unknown }) {
        cap.invokes.push({ method: p.method, path: p.path, body: p.body });
        var list = opts.invokeResponses || [{ status: 200, body: {} }];
        var r = list[invokeIdx] !== undefined ? list[invokeIdx] : list[list.length - 1];
        invokeIdx += 1;
        return r;
      },
      get: async function <T>(path: string): Promise<T> {
        cap.gets.push(path);
        if (opts.getResponses) {
          var r = opts.getResponses[getIdx] !== undefined ? opts.getResponses[getIdx] : opts.getResponses[opts.getResponses.length - 1];
          getIdx += 1;
          return r as T;
        }
        return opts.getResponse as T;
      },
      post: async function <T>(path: string, body: any): Promise<T> {
        cap.posts.push({ path: path, body: body });
        if (opts.postThrows) {
          throw opts.postThrows;
        }
        return (opts.postResponse !== undefined ? opts.postResponse : {}) as T;
      },
    },
  } as ServiceNowClient;
  return { client: client, cap: cap };
}

var FLOW = "327c53bfc33e3250d4ddf1db05013135";
var SCOPE = "c710ee73c3541e5085b196c4e4013170";

function flowModel(over?: any) {
  var base = {
    result: {
      data: {
        id: FLOW,
        name: "Send Automated SMS - Single Send",
        internalName: "send_automated_sms__single_send",
        type: "SubFlow",
        scope: SCOPE,
        isPublished: true,
        userCanRead: true,
        status: "published",
        actionInstances: [
          {
            order: "28",
            name: "Calculate SMS Send At",
            uiUniqueIdentifier: "calc",
            parent: "try",
            deleted: false,
            inputs: [
              { name: "send_rate", value: "0" },
              { name: "timezone", value: "UTC" },
            ],
          },
        ],
        flowLogicInstances: [
          { order: "0", name: "Top Level Try:", uiUniqueIdentifier: "try", parent: "", deleted: false },
        ],
        flowVariables: [
          { name: "phone", label: "Phone", type: "string" },
          { name: "send_at", label: "Send At", type: "glide_date_time" },
        ],
      },
    },
  };
  if (over) {
    Object.assign(base.result.data, over);
  }
  return base;
}

describe("editFlow", function () {
  it("dry-run computes the rename + step-input diff without publishing", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    var r = await editFlow({
      client: ctx.client,
      sysId: FLOW,
      ops: {
        rename: { name: "Renamed Flow" },
        description: "new desc",
        patchStepInputs: [{ step: "Calculate SMS Send At", input: "send_rate", value: "5" }],
      },
    });
    expect(r.status).toBe("dry-run");
    expect(r.changes).toContain("name -> Renamed Flow");
    expect(r.changes).toContain("description updated");
    expect(r.changes.some(function (c) { return c.indexOf("send_rate") >= 0; })).toBe(true);
    expect(r.warnings).toHaveLength(0);
    expect(ctx.cap.posts).toHaveLength(0); // dry-run => no publish
  });

  it("apply republishes the patched model + verifies persistence (no warning when it took)", async function () {
    var ctx = mockClient({
      // get[0] = initial read (timezone UTC); get[1] = verify read (now Denver = persisted)
      getResponses: [flowModel(), flowModel({
        actionInstances: [{
          order: "28", name: "Calculate SMS Send At", uiUniqueIdentifier: "calc", parent: "try", deleted: false,
          inputs: [{ name: "send_rate", value: "0" }, { name: "timezone", value: "America/Denver" }],
        }],
      })],
      postResponse: { result: { data: { latestSnapshot: "snap-edit" } } },
    });
    var r = await editFlow({
      client: ctx.client,
      sysId: FLOW,
      apply: true,
      ops: { patchStepInputs: [{ step: "calc", input: "timezone", value: "America/Denver" }] },
    });
    expect(r.status).toBe("applied");
    expect(r.snapshotSysId).toBe("snap-edit");
    expect(r.warnings).toHaveLength(0); // verify read confirmed it persisted
    expect(ctx.cap.posts).toHaveLength(1);
    expect(ctx.cap.posts[0].path).toContain("/snapshot");
    var calc = ctx.cap.posts[0].body.actionInstances[0];
    var tz = calc.inputs.filter(function (x: any) { return x.name === "timezone"; })[0];
    expect(tz.value).toBe("America/Denver");
  });

  it("warns when a step-input change did not persist (snapshot POST no-op)", async function () {
    var ctx = mockClient({
      // get[0] = initial read (mutated in place by editFlow); get[1] = FRESH verify
      // read still showing UTC -> the change didn't persist server-side.
      getResponses: [flowModel(), flowModel()],
      postResponse: { result: { data: { latestSnapshot: "snap-x" } } },
    });
    var r = await editFlow({
      client: ctx.client,
      sysId: FLOW,
      apply: true,
      ops: { patchStepInputs: [{ step: "calc", input: "timezone", value: "America/Denver" }] },
    });
    expect(r.status).toBe("applied");
    expect(r.warnings.some(function (w) { return w.indexOf("did not persist") >= 0; })).toBe(true);
  });

  it("metadata-only edits write the record (no snapshot recompile)", async function () {
    // Capture the update-set-aware record write.
    var pushes: Array<any> = [];
    var ctx = mockClient({ getResponse: flowModel() });
    ctx.client.claude.pushWithUpdateSet = async function (p: any) { pushes.push(p); return { sys_id: p.record_sys_id }; };

    var r = await editFlow({
      client: ctx.client,
      sysId: FLOW,
      apply: true,
      updateSetSysId: "us_sys_id_000000000000000000000000",
      ops: { rename: { name: "Renamed" }, description: "new desc" },
    });
    expect(r.status).toBe("applied");
    expect(r.snapshotSysId).toBeUndefined();   // no step change => no recompile
    expect(ctx.cap.posts).toHaveLength(0);      // no /snapshot POST
    // The record write hit sys_hub_flow with name + description in the given update set.
    expect(pushes).toHaveLength(1);
    expect(pushes[0].table).toBe("sys_hub_flow");
    expect(pushes[0].record_sys_id).toBe(FLOW);
    expect(pushes[0].fields.name).toBe("Renamed");
    expect(pushes[0].fields.description).toBe("new desc");
    expect(pushes[0].update_set_sys_id).toBe("us_sys_id_000000000000000000000000");
  });

  it("throws when rename/description is applied without an update set", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    await expect(editFlow({
      client: ctx.client,
      sysId: FLOW,
      apply: true,
      ops: { description: "x" },
    })).rejects.toThrow(/updateSetSysId is required/);
  });

  it("reports unmatched steps/inputs as warnings and does not publish a no-op", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    var r = await editFlow({
      client: ctx.client,
      sysId: FLOW,
      apply: true,
      ops: { patchStepInputs: [{ step: "NoSuchStep", input: "x", value: "1" }] },
    });
    expect(r.warnings).toContain("step not found: NoSuchStep");
    expect(r.changes).toHaveLength(0);
    expect(r.status).toBe("dry-run"); // nothing matched -> no publish even with apply
    expect(ctx.cap.posts).toHaveLength(0);
  });

  it("requires sysId", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    await expect(editFlow({ client: ctx.client, sysId: "", ops: {} })).rejects.toThrow(/sysId is required/);
  });
});

describe("testFlow", function () {
  it("validate (default) confirms published + checks inputs against declared variables", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    var r = await testFlow({ client: ctx.client, sysId: FLOW, inputs: { phone: "+15551234567" } });
    expect(r.mode).toBe("validate");
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toContain("published: yes");
    expect(ctx.cap.posts).toHaveLength(0); // never executes
  });

  it("validate flags an unpublished flow and unknown inputs", async function () {
    var ctx = mockClient({ getResponse: flowModel({ isPublished: false }) });
    var r = await testFlow({ client: ctx.client, sysId: FLOW, inputs: { bogus: 1 } });
    expect(r.ok).toBe(false);
    expect(r.notes.join(" ")).toContain("NOT PUBLISHED");
    expect(r.notes.join(" ")).toContain("does not match any declared flow variable");
  });

  it("execute requires confirm=true", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    await expect(testFlow({ client: ctx.client, sysId: FLOW, mode: "execute" }))
      .rejects.toThrow(/requires confirm=true/);
    expect(ctx.cap.posts).toHaveLength(0);
  });

  it("execute with confirm POSTs the Dovetail Core runFlow op and returns the context id", async function () {
    var ctx = mockClient({
      invokeResponses: [{
        status: 200,
        body: { result: { ok: true, name: "x_cadso_core.send_sms", contextId: "ctx-123", outputs: { ok: true } } },
      }],
    });
    var r = await testFlow({
      client: ctx.client,
      sysId: FLOW,
      mode: "execute",
      confirm: true,
      inputs: { phone: "x" },
    });
    expect(r.mode).toBe("execute");
    expect(r.ok).toBe(true);
    expect(r.contextSysId).toBe("ctx-123");
    expect(r.httpStatus).toBe(200);
    expect(r.runnerPath).toBe("/api/cadso/dovetail_core/runFlow");
    expect(DEFAULT_RUN_FLOW_PATH).toBe("/api/cadso/dovetail_core/runFlow");
    expect(ctx.cap.invokes).toHaveLength(1);
    expect(ctx.cap.invokes[0].method).toBe("POST");
    expect(ctx.cap.invokes[0].path).toBe("/api/cadso/dovetail_core/runFlow");
    expect(ctx.cap.invokes[0].body).toEqual({ flowSysId: FLOW, inputs: { phone: "x" } });
    expect(r.notes.join(" ")).toContain("x_cadso_core.send_sms");
  });

  it("execute with target='action' sends actionSysId, not flowSysId", async function () {
    var ctx = mockClient({ invokeResponses: [{ status: 200, body: { result: { ok: true, contextId: "c", outputs: {} } } }] });
    await testFlow({ client: ctx.client, sysId: FLOW, target: "action", mode: "execute", confirm: true });
    expect(ctx.cap.invokes[0].body).toEqual({ actionSysId: FLOW, inputs: {} });
  });

  it("execute falls back to the legacy path once when the core route 404s", async function () {
    var warn = jest.spyOn(console, "warn").mockImplementation(function () { return undefined; });
    var ctx = mockClient({
      invokeResponses: [
        { status: 404, body: { error: { message: "Requested URI does not represent any resource" }, status: "failure" } },
        { status: 200, body: { result: { ok: true, contextId: "ctx-legacy", outputs: {} } } },
      ],
    });
    var r = await testFlow({ client: ctx.client, sysId: FLOW, mode: "execute", confirm: true });
    expect(ctx.cap.invokes.map(function (c) { return c.path; })).toEqual([
      "/api/cadso/dovetail_core/runFlow",
      LEGACY_RUN_FLOW_PATH,
    ]);
    expect(LEGACY_RUN_FLOW_PATH).toBe("/api/cadso/dovetail/runFlow");
    expect(r.ok).toBe(true);
    expect(r.contextSysId).toBe("ctx-legacy");
    expect(r.runnerPath).toBe("/api/cadso/dovetail/runFlow");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("execute does NOT fall back when the op itself answers 404 (unknown sys_id)", async function () {
    var ctx = mockClient({
      invokeResponses: [{ status: 404, body: { result: { ok: false, error: "sys_hub_flow not found: " + FLOW } } }],
    });
    var r = await testFlow({ client: ctx.client, sysId: FLOW, mode: "execute", confirm: true });
    expect(ctx.cap.invokes).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(404);
    expect(r.notes.join(" ")).toContain("sys_hub_flow not found");
  });

  it("execute surfaces the op's role guard (403) as a rejected run", async function () {
    var ctx = mockClient({
      invokeResponses: [{ status: 403, body: { result: { ok: false, error: "runFlow requires the admin or dovetail_user role" } } }],
    });
    var r = await testFlow({ client: ctx.client, sysId: FLOW, mode: "execute", confirm: true });
    expect(ctx.cap.invokes).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(403);
    expect(r.notes.join(" ")).toContain("dovetail_user");
  });

  it("an explicit runnerPath wins and never falls back", async function () {
    var ctx = mockClient({ invokeResponses: [{ status: 404, body: { error: { message: "no route" } } }] });
    await expect(testFlow({
      client: ctx.client,
      sysId: FLOW,
      mode: "execute",
      confirm: true,
      runnerPath: "/api/custom/runner",
    })).rejects.toThrow(/no runFlow endpoint found \(tried \/api\/custom\/runner\)/);
    expect(ctx.cap.invokes).toHaveLength(1);
    expect(ctx.cap.invokes[0].path).toBe("/api/custom/runner");
  });

  it("execute surfaces a clear error when neither runner route exists (404 on both)", async function () {
    var warn = jest.spyOn(console, "warn").mockImplementation(function () { return undefined; });
    var ctx = mockClient({ invokeResponses: [{ status: 404, body: { error: { message: "no route" } } }] });
    await expect(testFlow({ client: ctx.client, sysId: FLOW, mode: "execute", confirm: true }))
      .rejects.toThrow(/ships with the Dovetail app/);
    expect(ctx.cap.invokes).toHaveLength(2);
    warn.mockRestore();
  });

  it("execute throws on a non-contract auth failure instead of reporting a run", async function () {
    var ctx = mockClient({ invokeResponses: [{ status: 401, body: { error: { message: "User Not Authenticated" } } }] });
    await expect(testFlow({ client: ctx.client, sysId: FLOW, mode: "execute", confirm: true }))
      .rejects.toThrow(/HTTP 401/);
  });

  it("rejects a malformed sysId before any request", async function () {
    var ctx = mockClient({});
    await expect(testFlow({ client: ctx.client, sysId: "not-a-sys-id", mode: "execute", confirm: true }))
      .rejects.toThrow(/32-character hex/);
    expect(ctx.cap.invokes).toHaveLength(0);
  });

  it("validate with target='action' checks the record and its declared inputs", async function () {
    var ctx = mockClient({
      queryRows: [{ sys_id: FLOW, name: "Send SMS", internal_name: "send_sms", sys_scope: SCOPE }],
      getResponse: { result: { displayName: "Send SMS", inputs: [{ name: "phone", label: "Phone", type: "string" }], outputs: [] } },
    });
    var r = await testFlow({ client: ctx.client, sysId: FLOW, target: "action", inputs: { phone: "1", bogus: 2 } });
    expect(r.mode).toBe("validate");
    expect(r.ok).toBe(true);
    expect(ctx.cap.queries[0].table).toBe("sys_hub_action_type_definition");
    expect(r.notes.join(" ")).toContain("'bogus' does not match any declared action input");
    expect(ctx.cap.invokes).toHaveLength(0);
  });

  it("validate with target='action' fails when the action has no internal_name", async function () {
    var ctx = mockClient({
      queryRows: [{ sys_id: FLOW, name: "Broken", internal_name: "", sys_scope: SCOPE }],
      getResponse: { result: { inputs: [], outputs: [] } },
    });
    var r = await testFlow({ client: ctx.client, sysId: FLOW, target: "action" });
    expect(r.ok).toBe(false);
    expect(r.notes.join(" ")).toContain("NO internal_name");
  });

  it("requires sysId", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    await expect(testFlow({ client: ctx.client, sysId: "" })).rejects.toThrow(/sysId is required/);
  });
});
