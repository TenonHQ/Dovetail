import { readFlow } from "../src/flowDesigner/readFlow";
import { readActionType } from "../src/flowDesigner/readActionType";
import { publishFlow } from "../src/flowDesigner/publishFlow";
import type { ServiceNowClient } from "../src/client";

interface Cap {
  gets: Array<string>;
  posts: Array<{ path: string; body: any }>;
}

function mockClient(opts: { getResponse?: any; postResponse?: any }): {
  client: ServiceNowClient;
  cap: Cap;
} {
  var cap: Cap = { gets: [], posts: [] };
  var client = {
    table: {
      query: async function () {
        return [];
      },
    },
    buildAgent: {
      runQuery: async function () {
        return [];
      },
      getTableSchema: async function () {
        return { fields: [], primary_key: "sys_id" };
      },
    },
    claude: {
      createRecord: async function () {
        return { sys_id: "x" };
      },
      pushWithUpdateSet: async function () {
        return { sys_id: "x" };
      },
      currentUpdateSet: async function () {
        return { sys_id: "u", name: "u" };
      },
      changeUpdateSet: async function () {
        return {};
      },
      deleteRecord: async function () {
        return {};
      },
    },
    now: {
      get: async function <T>(path: string): Promise<T> {
        cap.gets.push(path);
        return opts.getResponse as T;
      },
      post: async function <T>(path: string, body: any): Promise<T> {
        cap.posts.push({ path: path, body: body });
        return (opts.postResponse !== undefined ? opts.postResponse : {}) as T;
      },
    },
  } as ServiceNowClient;
  return { client: client, cap: cap };
}

var FLOW = "327c53bfc33e3250d4ddf1db05013135";
var SCOPE = "c710ee73c3541e5085b196c4e4013170";
var ACTION = "b4fdf831c3bf7ed0d4ddf1db0501314a";

// A small but representative processflow flow model: a Try block containing two
// actions and a nested If, plus a top-level action — exercises ordering + depth.
function flowModel() {
  return {
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
            order: "1",
            name: "Process Inputs / Outputs",
            uiUniqueIdentifier: "a1",
            parent: "try",
            deleted: false,
          },
          {
            order: "2",
            name: "Update Record",
            uiUniqueIdentifier: "a2",
            parent: "try",
            deleted: false,
          },
          {
            order: "8",
            name: "Update Record",
            uiUniqueIdentifier: "a8",
            parent: "if1",
            deleted: false,
          },
          {
            order: "99",
            name: "Removed Step",
            uiUniqueIdentifier: "z",
            parent: "try",
            deleted: true,
          },
        ],
        flowLogicInstances: [
          {
            order: "0",
            name: "Top Level Try:",
            uiUniqueIdentifier: "try",
            parent: "",
            deleted: false,
          },
          {
            order: "7",
            name: "If: No Phone Home",
            uiUniqueIdentifier: "if1",
            parent: "try",
            deleted: false,
          },
        ],
        flowVariables: [
          {
            name: "phone",
            label: "Phone",
            type: "string",
            type_label: "String",
          },
          {
            name: "send_at",
            label: "Send At",
            type: "glide_date_time",
            type_label: "Date/Time",
          },
        ],
      },
    },
  };
}

describe("readFlow", function () {
  it("merges action + logic instances, drops deleted, sorts by order, computes nesting depth", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    var r = await readFlow({ client: ctx.client, sysId: FLOW });

    expect(ctx.cap.gets[0]).toBe("/api/now/processflow/flow/" + FLOW);
    expect(r.name).toBe("Send Automated SMS - Single Send");
    expect(r.type).toBe("SubFlow");
    expect(r.scopeSysId).toBe(SCOPE);
    expect(r.published).toBe(true);
    expect(r.userCanRead).toBe(true);

    // 6 instances total in the model, 1 deleted -> 5 live steps, ordered.
    expect(r.steps.length).toBe(5);
    expect(
      r.steps.map(function (s) {
        return s.order;
      }),
    ).toEqual([0, 1, 2, 7, 8]);
    expect(
      r.steps.map(function (s) {
        return s.kind;
      }),
    ).toEqual(["logic", "action", "action", "logic", "action"]);

    // Depth: Try=0; its children (a1,a2,if1)=1; the If's child a8=2.
    var byLabel: Record<string, number> = {};
    r.steps.forEach(function (s) {
      byLabel[s.label] = s.depth;
    });
    expect(byLabel["Top Level Try:"]).toBe(0);
    expect(byLabel["Process Inputs / Outputs"]).toBe(1);
    expect(byLabel["If: No Phone Home"]).toBe(1);
    expect(byLabel["Update Record"]).toBe(2); // the deepest Update Record (a8, under if1)

    // counts reflect the raw model arrays (including the deleted action).
    expect(r.counts).toEqual({ action: 4, logic: 2, total: 6 });

    // Variables surfaced with label + human type.
    expect(r.variables).toEqual([
      { name: "phone", label: "Phone", type: "String" },
      { name: "send_at", label: "Send At", type: "Date/Time" },
    ]);

    // raw omitted unless requested.
    expect(r.raw).toBeUndefined();
  });

  it("includes the raw model when raw:true", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    var r = await readFlow({ client: ctx.client, sysId: FLOW, raw: true });
    expect(r.raw).toBeTruthy();
    expect(r.raw.actionInstances.length).toBe(4);
  });

  it("requires sysId", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    await expect(readFlow({ client: ctx.client, sysId: "" })).rejects.toThrow(
      /sysId is required/,
    );
  });

  it("throws on an unexpected (non-object) response", async function () {
    var ctx = mockClient({ getResponse: "not json" });
    await expect(readFlow({ client: ctx.client, sysId: FLOW })).rejects.toThrow(
      /unexpected response/,
    );
  });
});

describe("readActionType", function () {
  it("GETs with the scope param and surfaces identity, inputs, outputs", async function () {
    var ctx = mockClient({
      getResponse: {
        result: {
          sys_id: ACTION,
          displayName: "Send SMS / MMS",
          internal_name: "send_sms_mms",
          description: "Send a text",
          inputs: [
            { name: "to", label: "To", type: "string", type_label: "String" },
          ],
          outputs: [
            { name: "message_id", label: "Message ID", type: "string" },
            {
              name: "ok",
              label: "Success",
              type: "boolean",
              type_label: "True/False",
            },
          ],
        },
      },
    });
    var r = await readActionType({
      client: ctx.client,
      sysId: ACTION,
      scopeSysId: SCOPE,
    });

    expect(ctx.cap.gets[0]).toBe(
      "/api/now/processflow/action/action_types/" +
        ACTION +
        "?sysparm_transaction_scope=" +
        SCOPE,
    );
    expect(r.name).toBe("Send SMS / MMS");
    expect(r.internalName).toBe("send_sms_mms");
    expect(r.counts).toEqual({ inputs: 1, outputs: 2 });
    expect(r.inputs[0]).toEqual({ name: "to", label: "To", type: "String" });
    expect(r.outputs[1]).toEqual({
      name: "ok",
      label: "Success",
      type: "True/False",
    });
  });

  it("requires sysId and scopeSysId", async function () {
    var ctx = mockClient({ getResponse: { result: {} } });
    await expect(
      readActionType({ client: ctx.client, sysId: "", scopeSysId: SCOPE }),
    ).rejects.toThrow(/sysId is required/);
    await expect(
      readActionType({ client: ctx.client, sysId: ACTION, scopeSysId: "" }),
    ).rejects.toThrow(/scopeSysId is required/);
  });
});

describe("publishFlow", function () {
  it("fetches the model, POSTs it to /snapshot with the model's scope, returns published", async function () {
    var ctx = mockClient({
      getResponse: flowModel(),
      postResponse: { result: { data: { latestSnapshot: "snap-new" } } },
    });
    var r = await publishFlow({ client: ctx.client, sysId: FLOW });

    expect(ctx.cap.gets[0]).toBe("/api/now/processflow/flow/" + FLOW);
    expect(ctx.cap.posts.length).toBe(1);
    expect(ctx.cap.posts[0].path).toBe(
      "/api/now/processflow/flow/" +
        FLOW +
        "/snapshot?sysparm_transaction_scope=" +
        SCOPE,
    );
    // The posted body is the fetched model (carries the instance graph).
    expect(ctx.cap.posts[0].body.actionInstances.length).toBe(4);
    expect(r.status).toBe("published");
    expect(r.snapshotSysId).toBe("snap-new");
  });

  it("publishes a caller-supplied edited model without re-fetching", async function () {
    var ctx = mockClient({ postResponse: {} });
    var edited = {
      scope: SCOPE,
      actionInstances: [],
      flowLogicInstances: [],
      name: "edited",
    };
    var r = await publishFlow({
      client: ctx.client,
      sysId: FLOW,
      model: edited,
    });

    expect(ctx.cap.gets.length).toBe(0); // no GET — used the supplied model
    expect(ctx.cap.posts[0].body.name).toBe("edited");
    expect(r.status).toBe("published");
  });

  it("uses an explicit scopeSysId over the model's scope", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    await publishFlow({
      client: ctx.client,
      sysId: FLOW,
      scopeSysId: "OTHER_SCOPE",
    });
    expect(ctx.cap.posts[0].path).toContain(
      "sysparm_transaction_scope=OTHER_SCOPE",
    );
  });

  it("throws when no scope can be resolved", async function () {
    var ctx = mockClient({ postResponse: {} });
    await expect(
      publishFlow({
        client: ctx.client,
        sysId: FLOW,
        model: { actionInstances: [] },
      }),
    ).rejects.toThrow(/scopeSysId is required/);
  });

  it("requires sysId", async function () {
    var ctx = mockClient({ getResponse: flowModel() });
    await expect(
      publishFlow({ client: ctx.client, sysId: "" }),
    ).rejects.toThrow(/sysId is required/);
  });
});
