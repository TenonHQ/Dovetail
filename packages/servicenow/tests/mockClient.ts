/**
 * Shared in-memory ServiceNowClient mock for unit tests.
 *
 * Reads are driven by a caller-supplied query function; every write call is
 * recorded on `calls` so tests can assert on it. Used by choices.test.ts and
 * all layout module tests.
 */

import type { ServiceNowClient } from "../src/client";

export type QueryFn = (table: string, query?: string, limit?: number) => Promise<Array<any>>;

export interface MockCalls {
  tableQuery: Array<{ table: string; query: string }>;
  createRecord: Array<any>;
  pushWithUpdateSet: Array<any>;
  deleteRecord: Array<any>;
  changeUpdateSet: Array<any>;
}

export interface MockClientCtx {
  client: ServiceNowClient;
  calls: MockCalls;
}

export function makeMockClient(overrides: { query?: QueryFn } = {}): MockClientCtx {
  var calls: MockCalls = {
    tableQuery: [],
    createRecord: [],
    pushWithUpdateSet: [],
    deleteRecord: [],
    changeUpdateSet: []
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
      },
      changeUpdateSet: async function (params) {
        calls.changeUpdateSet.push(params);
        return { sys_id: params.sysId };
      },
      deleteRecord: async function (params) {
        calls.deleteRecord.push(params);
        return { sys_id: params.sys_id };
      }
    }
  };
  return { client: client, calls: calls };
}
