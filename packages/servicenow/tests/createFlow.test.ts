import { createFlow, buildPublishModel } from "../src/flowDesigner/createFlow";
import type { ServiceNowClient } from "../src/client";

interface Cap {
  gets: Array<string>;
  posts: Array<{ path: string; body: any }>;
}

/**
 * Path-routing mock: createFlow makes a GET (template) then three POSTs
 * (create, create_version, snapshot) that each need a distinct response.
 */
function mockClient(routes: {
  get?: (path: string) => any;
  post?: (path: string, body: any) => any;
}): { client: ServiceNowClient; cap: Cap } {
  var cap: Cap = { gets: [], posts: [] };
  var client = {
    table: { query: async function () { return []; } },
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
    now: {
      get: async function <T>(path: string): Promise<T> {
        cap.gets.push(path);
        return (routes.get ? routes.get(path) : undefined) as T;
      },
      post: async function <T>(path: string, body: any): Promise<T> {
        cap.posts.push({ path: path, body: body });
        return (routes.post ? routes.post(path, body) : undefined) as T;
      },
    },
  } as ServiceNowClient;
  return { client: client, cap: cap };
}

var TEMPLATE = "99fbc9c4335d47147b18bc534d5c7b26";
var SCOPE = "5e9f5f8b87420250369f33373cbb3559";
var NEW = "aceb8e683395cb147b18bc534d5c7b5e";
var SNAP = "7ceb02a83395cb147b18bc534d5c7b03";

function templateModel(): any {
  return {
    id: TEMPLATE,
    scope: SCOPE,
    triggerInstances: [
      {
        id: "trig-old",
        flowSysId: TEMPLATE,
        triggerDefinitionId: "def-keep",
        inputs: [
          { name: "table", value: "customer_account", displayValue: "Account" },
          { name: "condition", value: "active=true", displayValue: "active=true" },
        ],
      },
    ],
    actionInstances: [
      {
        id: "act-old",
        flowSysId: TEMPLATE,
        uiUniqueIdentifier: "uuid-old",
        actionTypeSysId: "atype-keep",
        data: { table_name: "task", values: "short_description=Old" },
        inputs: [{ name: "message", value: "old", displayValue: "old" }],
      },
    ],
    flowLogicInstances: [],
  };
}

function publishedEnvelope(): any {
  return {
    id: NEW,
    internalName: "claude_flow_factory",
    scope: SCOPE,
    triggerInstances: [],
    actionInstances: [],
    flowLogicInstances: [],
  };
}

function routedPost(path: string): any {
  if (path.indexOf("/processflow/flow?") >= 0) {
    return { result: { data: publishedEnvelope() } };
  }
  if (path.indexOf("create_version") >= 0) {
    return { result: "", session: { notifications: [] } };
  }
  if (path.indexOf("/snapshot") >= 0) {
    return { result: { data: { id: NEW, status: "published", isPublished: true, active: true, latestSnapshot: SNAP } } };
  }
  return {};
}

describe("buildPublishModel", function () {
  it("grafts the template graph, remaps ids, and patches values", function () {
    var model = buildPublishModel(publishedEnvelope(), templateModel(), NEW, {
      client: {} as any,
      name: "New",
      templateSysId: TEMPLATE,
      scopeSysId: SCOPE,
      triggerTable: "customer_contact",
      logMessage: "hello",
    });
    expect(model.id).toBe(NEW);
    expect(model.status).toBe("draft");
    expect(model.triggerInstances).toHaveLength(1);
    expect(model.actionInstances).toHaveLength(1);
    var t = model.triggerInstances[0];
    var a = model.actionInstances[0];
    // re-parented + fresh id
    expect(t.flowSysId).toBe(NEW);
    expect(t.id).not.toBe("trig-old");
    expect(a.flowSysId).toBe(NEW);
    expect(a.id).not.toBe("act-old");
    expect(a.uiUniqueIdentifier).not.toBe("uuid-old");
    // definition refs preserved
    expect(t.triggerDefinitionId).toBe("def-keep");
    expect(a.actionTypeSysId).toBe("atype-keep");
    // values patched
    var tableInput = t.inputs.find(function (i: any) { return i.name === "table"; });
    expect(tableInput.value).toBe("customer_contact");
    expect(tableInput.displayValue).toBe("customer_contact");
    var msgInput = a.inputs.find(function (i: any) { return i.name === "message"; });
    expect(msgInput.value).toBe("hello");
    expect(a.data.values).toBe("short_description=hello");
  });

  it("does not mutate the source template", function () {
    var tpl = templateModel();
    buildPublishModel(publishedEnvelope(), tpl, NEW, {
      client: {} as any, name: "X", templateSysId: TEMPLATE, scopeSysId: SCOPE, triggerTable: "customer_contact",
    });
    expect(tpl.triggerInstances[0].flowSysId).toBe(TEMPLATE);
    expect(tpl.triggerInstances[0].id).toBe("trig-old");
  });
});

describe("createFlow", function () {
  it("creates, versions, and publishes — returning the new sys_id + snapshot", async function () {
    var ctx = mockClient({
      get: function () { return { result: { data: templateModel() } }; },
      post: function (path) { return routedPost(path); },
    });
    var r = await createFlow({
      client: ctx.client,
      name: "Claude Flow Factory 0602",
      templateSysId: TEMPLATE,
      scopeSysId: SCOPE,
      triggerTable: "customer_contact",
      logMessage: "hello",
    });
    expect(r.status).toBe("published");
    expect(r.sysId).toBe(NEW);
    expect(r.snapshotSysId).toBe(SNAP);
    expect(r.active).toBe(true);
    expect(r.graph).toEqual({ triggers: 1, actions: 1, logic: 0 });
    // call order: GET template, POST create, POST create_version, POST snapshot
    expect(ctx.cap.gets[0]).toContain("/processflow/flow/" + TEMPLATE);
    expect(ctx.cap.posts[0].path).toContain("/processflow/flow?param_only_properties=true");
    expect(ctx.cap.posts[0].body.type).toBe("flow");
    expect(ctx.cap.posts[1].path).toContain("create_version");
    expect(ctx.cap.posts[1].body).toEqual({ item_sys_id: NEW, type: "Activate/Publish", annotation: "", favorite: false });
    expect(ctx.cap.posts[2].path).toBe("/api/now/processflow/flow/" + NEW + "/snapshot?sysparm_transaction_scope=" + SCOPE);
    expect(ctx.cap.posts[2].body.triggerInstances[0].flowSysId).toBe(NEW);
  });

  it("dry-run reads the template and writes nothing", async function () {
    var ctx = mockClient({ get: function () { return { result: { data: templateModel() } }; } });
    var r = await createFlow({
      client: ctx.client, name: "X", templateSysId: TEMPLATE, scopeSysId: SCOPE, dryRun: true,
    });
    expect(r.status).toBe("dry-run");
    expect(r.sysId).toBe("");
    expect(r.graph.triggers).toBe(1);
    expect(ctx.cap.posts).toHaveLength(0);
  });

  it("survives a failing create_version (best-effort) and still publishes", async function () {
    var ctx = mockClient({
      get: function () { return { result: { data: templateModel() } }; },
      post: function (path) {
        if (path.indexOf("create_version") >= 0) { throw new Error("500 boom"); }
        return routedPost(path);
      },
    });
    var r = await createFlow({
      client: ctx.client, name: "X", templateSysId: TEMPLATE, scopeSysId: SCOPE,
    });
    expect(r.status).toBe("published");
    expect(r.snapshotSysId).toBe(SNAP);
  });

  it("throws when the template has no trigger", async function () {
    var ctx = mockClient({
      get: function () { return { result: { data: { scope: SCOPE, triggerInstances: [], actionInstances: [] } } }; },
    });
    await expect(createFlow({ client: ctx.client, name: "X", templateSysId: TEMPLATE, scopeSysId: SCOPE }))
      .rejects.toThrow(/no trigger to graft/);
  });

  it("requires name, templateSysId, and scopeSysId", async function () {
    var ctx = mockClient({});
    await expect(createFlow({ client: ctx.client, name: "", templateSysId: TEMPLATE, scopeSysId: SCOPE }))
      .rejects.toThrow(/name is required/);
    await expect(createFlow({ client: ctx.client, name: "X", templateSysId: "", scopeSysId: SCOPE }))
      .rejects.toThrow(/templateSysId is required/);
    await expect(createFlow({ client: ctx.client, name: "X", templateSysId: TEMPLATE, scopeSysId: "" }))
      .rejects.toThrow(/scopeSysId is required/);
  });
});
