import { copyFlow } from "../src/flowDesigner/copyFlow";
import type { ServiceNowClient } from "../src/client";

interface Cap {
  gets: Array<string>;
  posts: Array<{ path: string; body: any }>;
}

function mockClient(opts: { getResponse?: any; postResponse?: any }): { client: ServiceNowClient; cap: Cap } {
  var cap: Cap = { gets: [], posts: [] };
  var client = {
    table: { query: async function () { return []; } },
    buildAgent: { runQuery: async function () { return []; }, getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; } },
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
      get: async function <T>(path: string): Promise<T> { cap.gets.push(path); return opts.getResponse as T; },
      post: async function <T>(path: string, body: any): Promise<T> { cap.posts.push({ path: path, body: body }); return opts.postResponse as T; },
    },
  } as ServiceNowClient;
  return { client: client, cap: cap };
}

var SOURCE = "cd5dd7553336b2907b18bc534d5c7b9c";
var SCOPE = "5e9f5f8b87420250369f33373cbb3559";
var NEW = "52c5bdffc3090350d4ddf1db050131e8";

describe("copyFlow", function () {
  it("POSTs the copy endpoint with name+scope and returns the new sys_id (result.data string)", async function () {
    var ctx = mockClient({ postResponse: { result: { data: NEW, errorMessage: "" } } });
    var r = await copyFlow({ client: ctx.client, sourceSysId: SOURCE, newName: "IGNORE - copy", scopeSysId: SCOPE });

    expect(ctx.cap.gets).toHaveLength(0); // explicit scope => no scope-resolution GET
    expect(ctx.cap.posts).toHaveLength(1);
    expect(ctx.cap.posts[0].path).toBe(
      "/api/now/processflow/flow/" + SOURCE + "/copy?sysparm_transaction_scope=" + SCOPE
    );
    expect(ctx.cap.posts[0].body).toEqual({ name: "IGNORE - copy", scope: SCOPE });
    expect(r.sysId).toBe(NEW);
    expect(r.name).toBe("IGNORE - copy");
    expect(r.scopeSysId).toBe(SCOPE);
  });

  it("defaults the target scope to the source flow's scope when not given", async function () {
    var ctx = mockClient({
      getResponse: { result: { data: { scope: SCOPE } } },
      postResponse: { result: { data: NEW } },
    });
    var r = await copyFlow({ client: ctx.client, sourceSysId: SOURCE, newName: "IGNORE - copy" });
    expect(ctx.cap.gets[0]).toBe("/api/now/processflow/flow/" + SOURCE);
    expect(ctx.cap.posts[0].path).toContain("sysparm_transaction_scope=" + SCOPE);
    expect(r.scopeSysId).toBe(SCOPE);
  });

  it("extracts the sys_id when the response nests it under result.data.id", async function () {
    var ctx = mockClient({ postResponse: { result: { data: { id: NEW } } } });
    var r = await copyFlow({ client: ctx.client, sourceSysId: SOURCE, newName: "X", scopeSysId: SCOPE });
    expect(r.sysId).toBe(NEW);
  });

  it("throws when the response carries no new sys_id", async function () {
    var ctx = mockClient({ postResponse: { result: { data: "", errorMessage: "nope" } } });
    await expect(copyFlow({ client: ctx.client, sourceSysId: SOURCE, newName: "X", scopeSysId: SCOPE }))
      .rejects.toThrow(/no new flow sys_id/);
  });

  it("requires sourceSysId and newName", async function () {
    var ctx = mockClient({ postResponse: { result: { data: NEW } } });
    await expect(copyFlow({ client: ctx.client, sourceSysId: "", newName: "X", scopeSysId: SCOPE }))
      .rejects.toThrow(/sourceSysId is required/);
    await expect(copyFlow({ client: ctx.client, sourceSysId: SOURCE, newName: "", scopeSysId: SCOPE }))
      .rejects.toThrow(/newName is required/);
  });
});
