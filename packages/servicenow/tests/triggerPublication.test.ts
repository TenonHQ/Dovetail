import { triggerPublication } from "../src/flowDesigner/triggerPublication";
import type { ServiceNowClient } from "../src/client";

interface Cap {
  pushes: Array<any>;
  queries: Array<{ table: string; query: string }>;
}

function mockClient(opts: {
  snapshotRowsAfterAttempt?: number;
  snapshotRows?: Array<any>;
  pushThrows?: boolean;
}): { client: ServiceNowClient; cap: Cap } {
  var cap: Cap = { pushes: [], queries: [] };
  var pollAttempt = 0;
  var snapshotAt = opts.snapshotRowsAfterAttempt != null ? opts.snapshotRowsAfterAttempt : 1;
  var rows = opts.snapshotRows || [{ sys_id: "snap1" }];
  var client: ServiceNowClient = {
    table: { query: async function () { return []; } },
    buildAgent: {
      runQuery: async function <T>(p: { table: string; query: string }): Promise<Array<T>> {
        cap.queries.push({ table: p.table, query: p.query });
        if (p.table === "sys_hub_flow_snapshot") {
          pollAttempt++;
          if (pollAttempt >= snapshotAt) return rows as Array<T>;
          return [] as Array<T>;
        }
        return [] as Array<T>;
      },
      getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; },
    },
    claude: {
      createRecord: async function () { return { sys_id: "x" }; },
      pushWithUpdateSet: async function (p: any) {
        cap.pushes.push(p);
        if (opts.pushThrows) throw new Error("ACL violation");
        return { sys_id: p.record_sys_id };
      },
      currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
    },
  };
  return { client: client, cap: cap };
}

var SUB_SYS = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
var US = "33333333333333333333333333333333";

describe("triggerPublication", function () {
  it("returns published when snapshot appears after the push", async function () {
    var ctx = mockClient({ snapshotRowsAfterAttempt: 1 });
    var r = await triggerPublication({
      client: ctx.client,
      sysId: SUB_SYS,
      kind: "subflow",
      updateSetSysId: US,
      snapshotTimeoutMs: 5000,
    });
    expect(r.status).toBe("published");
    expect(r.snapshotSysId).toBe("snap1");
    expect(r.pushSucceeded).toBe(true);
    expect(ctx.cap.pushes[0].fields).toEqual({ status: "published" });
    expect(ctx.cap.pushes[0].update_set_sys_id).toBe(US);
  });

  it("targets sys_hub_action_type_definition for kind=actionType", async function () {
    var ctx = mockClient({ snapshotRowsAfterAttempt: 1 });
    await triggerPublication({
      client: ctx.client,
      sysId: SUB_SYS,
      kind: "actionType",
      updateSetSysId: US,
      snapshotTimeoutMs: 5000,
    });
    expect(ctx.cap.pushes[0].table).toBe("sys_hub_action_type_definition");
  });

  it("returns snapshot-pending when push succeeds but snapshot never appears", async function () {
    var ctx = mockClient({ snapshotRowsAfterAttempt: 9999, snapshotRows: [] });
    var r = await triggerPublication({
      client: ctx.client,
      sysId: SUB_SYS,
      kind: "subflow",
      updateSetSysId: US,
      snapshotTimeoutMs: 800, // expire after the first 500ms wait
    });
    expect(r.status).toBe("snapshot-pending");
    expect(r.pushSucceeded).toBe(true);
    expect(r.uiPublishUrl).toBeDefined();
  });

  it("returns needs-ui-publish when the push throws (e.g. ACL)", async function () {
    var ctx = mockClient({ pushThrows: true });
    var r = await triggerPublication({
      client: ctx.client,
      sysId: SUB_SYS,
      kind: "subflow",
      updateSetSysId: US,
    });
    expect(r.status).toBe("needs-ui-publish");
    expect(r.pushSucceeded).toBe(false);
    expect(r.uiPublishUrl).toBeDefined();
    expect(r.uiPublishUrl).toContain(SUB_SYS);
  });

  it("uses an explicit instanceHost in the UI fallback URL", async function () {
    var ctx = mockClient({ pushThrows: true });
    var r = await triggerPublication({
      client: ctx.client,
      sysId: SUB_SYS,
      kind: "subflow",
      updateSetSysId: US,
      instanceHost: "tenonworkstudio.service-now.com",
    });
    expect(r.uiPublishUrl).toContain("https://tenonworkstudio.service-now.com");
  });
});
