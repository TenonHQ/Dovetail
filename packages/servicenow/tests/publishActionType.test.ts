import { publishActionType } from "../src/flowDesigner/publishActionType";
import type { ServiceNowClient } from "../src/client";

interface Cap {
  gets: Array<string>;
  posts: Array<{ path: string; body: any }>;
}

function mockClient(opts: {
  getModel?: any;
  postResponse?: any;
}): { client: ServiceNowClient; cap: Cap } {
  var cap: Cap = { gets: [], posts: [] };
  var model = opts.getModel !== undefined
    ? opts.getModel
    : { name: "x", internal_name: "x", state: "draft", steps: null };
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
        return model as T;
      },
      post: async function <T>(path: string, body: any): Promise<T> {
        cap.posts.push({ path: path, body: body });
        return (opts.postResponse !== undefined
          ? opts.postResponse
          : { latest_snapshot: "snap-xyz" }) as T;
      },
    },
  } as ServiceNowClient;
  return { client: client, cap: cap };
}

var SYS = "60e6743e33814bd07b18bc534d5c7b9e";
var SCOPE = "cd61acbbc3c85a1085b196c4e40131bd";

describe("publishActionType", function () {
  it("GETs the model, grafts caller steps (remapping action), POSTs to /snapshot, returns published", async function () {
    var ctx = mockClient({});
    var steps = [
      { DB_TYPE: "SCRIPT", cid: "step-1", action: "OLD_ACTION_SYSID", order: 1 },
    ];
    var r = await publishActionType({
      client: ctx.client,
      sysId: SYS,
      scopeSysId: SCOPE,
      steps: steps,
    });

    expect(r.status).toBe("published");
    expect(r.httpStatus).toBe(201);
    expect(r.snapshotSysId).toBe("snap-xyz");

    // GET hit the model endpoint with the scope query param.
    expect(ctx.cap.gets[0]).toBe(
      "/api/now/processflow/action/action_types/" + SYS + "?sysparm_transaction_scope=" + SCOPE
    );

    // POST hit the /snapshot endpoint.
    expect(ctx.cap.posts.length).toBe(1);
    expect(ctx.cap.posts[0].path).toBe(
      "/api/now/processflow/action/action_types/" + SYS + "/snapshot?sysparm_transaction_scope=" + SCOPE
    );

    // The grafted body carries the steps with action remapped to the target sysId.
    var body = ctx.cap.posts[0].body;
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps.length).toBe(1);
    expect(body.steps[0].action).toBe(SYS);
    expect(body.steps[0].cid).toBe("step-1");

    // Caller's step object is not mutated (action still OLD on the input).
    expect(steps[0].action).toBe("OLD_ACTION_SYSID");
  });

  it("extracts snapshotSysId when the snapshot ref comes back as an object", async function () {
    var ctx = mockClient({ postResponse: { snapshot: { sys_id: "snap-obj" } } });
    var r = await publishActionType({
      client: ctx.client,
      sysId: SYS,
      scopeSysId: SCOPE,
      steps: [{ cid: "step-1", action: "OLD" }],
    });
    expect(r.snapshotSysId).toBe("snap-obj");
  });

  it("falls back to the model's own steps when no caller steps are provided", async function () {
    var ctx = mockClient({
      getModel: {
        name: "x",
        steps: [{ DB_TYPE: "SCRIPT", cid: "preexisting", action: "whatever" }],
      },
    });
    var r = await publishActionType({
      client: ctx.client,
      sysId: SYS,
      scopeSysId: SCOPE,
    });
    expect(r.status).toBe("published");
    expect(ctx.cap.posts[0].body.steps[0].cid).toBe("preexisting");
  });

  it("throws a clear error when steps are null and none supplied (steps-fixture caveat)", async function () {
    var ctx = mockClient({ getModel: { name: "x", steps: null } });
    await expect(
      publishActionType({ client: ctx.client, sysId: SYS, scopeSysId: SCOPE })
    ).rejects.toThrow(/must supply a steps fixture/);
    expect(ctx.cap.posts.length).toBe(0);
  });

  it("requires sysId and scopeSysId", async function () {
    var ctx = mockClient({});
    await expect(
      publishActionType({ client: ctx.client, sysId: "", scopeSysId: SCOPE })
    ).rejects.toThrow(/sysId is required/);
    await expect(
      publishActionType({ client: ctx.client, sysId: SYS, scopeSysId: "" })
    ).rejects.toThrow(/scopeSysId is required/);
  });
});
