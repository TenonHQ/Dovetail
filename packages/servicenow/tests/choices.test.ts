import { addChoicesToField } from "../src/choices";
import type { ServiceNowClient } from "../src/client";

type QueryFn = (table: string, query?: string, limit?: number) => Promise<Array<any>>;

function makeClient(overrides: { query?: QueryFn } = {}): {
  client: ServiceNowClient;
  calls: {
    tableQuery: Array<{ table: string; query: string }>;
    createRecord: Array<any>;
    pushWithUpdateSet: Array<any>;
  };
} {
  var calls = {
    tableQuery: [] as Array<{ table: string; query: string }>,
    createRecord: [] as Array<any>,
    pushWithUpdateSet: [] as Array<any>
  };
  var queryImpl: QueryFn = overrides.query || (async function () { return []; });
  var queryFn = async function <T = any>(
    table: string,
    query: string,
    limitOrOptions?: number | { limit?: number; fields?: string[] }
  ): Promise<Array<T>> {
    calls.tableQuery.push({ table: table, query: query });
    var limit = typeof limitOrOptions === "number"
      ? limitOrOptions
      : (limitOrOptions && limitOrOptions.limit);
    return (await queryImpl(table, query, limit)) as Array<T>;
  };
  var client: ServiceNowClient = {
    table: {
      query: queryFn as ServiceNowClient["table"]["query"]
    },
    buildAgent: {
      runQuery: async function () { return [] as any; },
      getTableSchema: async function () { return { fields: [], primary_key: "sys_id" }; }
    },
    claude: {
      createRecord: async function (params) {
        calls.createRecord.push(params);
        return { sys_id: "new_" + calls.createRecord.length };
      },
      pushWithUpdateSet: async function (params) {
        calls.pushWithUpdateSet.push(params);
        return { sys_id: params.record_sys_id };
      },
      currentUpdateSet: async function () {
        return { sys_id: "cur", name: "cur" };
      }
    }
  };
  return { client: client, calls: calls };
}

describe("addChoicesToField", function () {
  var dictRow = {
    sys_id: "dict1",
    name: "x_cadso_core_event",
    element: "state",
    choice: "0",
    sys_scope: "scope_core"
  };
  var updateSetRow = {
    sys_id: "us1",
    name: "Tenon - Core - Sinch DLR Tables",
    state: "in progress",
    application: "scope_core"
  };

  it("creates new choices and flips sys_dictionary.choice to 3", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [dictRow];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_choice") return [];
        return [];
      }
    });

    var result = await addChoicesToField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      updateSetSysId: "us1",
      choices: [
        { value: "delivered", label: "Delivered" },
        { value: "failed", label: "Failed" }
      ]
    });

    expect(result.dictionary.choiceWas).toBe(0);
    expect(result.dictionary.choiceNow).toBe(3);
    expect(result.choices.map(c => c.action)).toEqual(["created", "created"]);
    expect(ctx.calls.createRecord).toHaveLength(2);
    expect(ctx.calls.createRecord[0].table).toBe("sys_choice");
    expect(ctx.calls.createRecord[0].fields.name).toBe("x_cadso_core_event");
    expect(ctx.calls.createRecord[0].fields.element).toBe("state");
    expect(ctx.calls.createRecord[0].fields.sys_scope).toBe("scope_core");
    expect(ctx.calls.createRecord[0].update_set_sys_id).toBe("us1");
    expect(ctx.calls.createRecord[0].scope).toBe("x_cadso_core");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
    expect(ctx.calls.pushWithUpdateSet[0].table).toBe("sys_dictionary");
    expect(ctx.calls.pushWithUpdateSet[0].fields.choice).toBe("3");
  });

  it("is idempotent — returns unchanged for matching existing rows", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [{ ...dictRow, choice: "3" }];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_choice") {
          return [
            {
              sys_id: "ch1",
              value: "delivered",
              label: "Delivered",
              sequence: "",
              language: "en",
              inactive: "false"
            }
          ];
        }
        return [];
      }
    });

    var result = await addChoicesToField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      updateSetSysId: "us1",
      choices: [{ value: "delivered", label: "Delivered" }]
    });

    expect(result.choices[0].action).toBe("unchanged");
    expect(ctx.calls.createRecord).toHaveLength(0);
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(0);
  });

  it("updates label when existing value has different label", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [{ ...dictRow, choice: "3" }];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        if (table === "sys_choice") {
          return [
            {
              sys_id: "ch1",
              value: "delivered",
              label: "OLD",
              sequence: "",
              language: "en",
              inactive: "false"
            }
          ];
        }
        return [];
      }
    });

    var result = await addChoicesToField(ctx.client, {
      table: "x_cadso_core_event",
      column: "state",
      updateSetSysId: "us1",
      choices: [{ value: "delivered", label: "Delivered" }]
    });

    expect(result.choices[0].action).toBe("updated");
    expect(ctx.calls.pushWithUpdateSet).toHaveLength(1);
    expect(ctx.calls.pushWithUpdateSet[0].fields.label).toBe("Delivered");
  });

  it("rejects when sys_dictionary record is missing", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [];
        if (table === "sys_update_set") return [updateSetRow];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        return [];
      }
    });

    await expect(
      addChoicesToField(ctx.client, {
        table: "bogus",
        column: "column",
        updateSetSysId: "us1",
        choices: [{ value: "x", label: "X" }]
      })
    ).rejects.toThrow(/sys_dictionary record not found/);
  });

  it("rejects when update set is not in progress", async function () {
    var ctx = makeClient({
      query: async function (table: string, _query?: string) {
        if (table === "sys_dictionary") return [dictRow];
        if (table === "sys_update_set") return [{ ...updateSetRow, state: "complete" }];
        if (table === "sys_scope") return [{ sys_id: "scope_core", scope: "x_cadso_core", name: "x_cadso_core" }];
        return [];
      }
    });

    await expect(
      addChoicesToField(ctx.client, {
        table: "x_cadso_core_event",
        column: "state",
        updateSetSysId: "us1",
        choices: [{ value: "x", label: "X" }]
      })
    ).rejects.toThrow(/in progress/);
  });

  it("rejects empty updateSetSysId", async function () {
    var ctx = makeClient();
    await expect(
      addChoicesToField(ctx.client, {
        table: "t",
        column: "c",
        updateSetSysId: "",
        choices: [{ value: "x", label: "X" }]
      })
    ).rejects.toThrow(/updateSetSysId is required/);
  });
});
