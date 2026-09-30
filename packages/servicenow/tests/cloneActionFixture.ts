/**
 * Shared fake ServiceNowClient for cloneActionType / action_clone tests: a
 * two-step source action (REST + Script) with ext inputs/outputs, served over the
 * Table API and the processflow /step_instances + /snapshot endpoints. buildAgent
 * throws — clone must never touch it.
 */

import type { ServiceNowClient } from "../src/client";

export var SRC = "44444444444444444444444444444444";
export var SRC_SCOPE = "55555555555555555555555555555555";
export var TARGET_SCOPE = "66666666666666666666666666666666";
export var TARGET_SCOPE_NAME = "x_cadso_email_spok";
export var US = "33333333333333333333333333333333";
export var S1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
export var S2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
export var EXT_IN_1 = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
export var EXT_OUT_2 = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
export var SCRIPT = "(function execute(inputs, outputs) {\n  outputs.body = inputs.responseBody;\n})(inputs, outputs);";

export interface Cap {
  tableQueries: Array<{ table: string; query: string }>;
  buildAgentCalls: number;
  creates: Array<{ table: string; fields: Record<string, unknown>; scope?: string; update_set_sys_id?: string; sys_id?: string }>;
  updateSets: Array<string>;
  gets: Array<string>;
  posts: Array<{ path: string; body: Record<string, unknown> }>;
}

function sourceSteps(): Array<Record<string, unknown>> {
  return [
    {
      sys_id: { value: S1 },
      cid: "cid_rest",
      label: "REST Step",
      action: SRC,
      inputs: [
        { name: "http_method", value: "get", display_value: "GET" },
        { name: "rest_endpoint", value: "/api/x" },
      ],
      extended_inputs: [
        { name: "payload", type: "string", sys_id: EXT_IN_1, model_id: S1, value: "" },
      ],
    },
    {
      sys_id: S2,
      cid: "cid_script",
      label: "Script Step",
      action: { value: SRC },
      inputs: [{ name: "script", value: SCRIPT }],
      extended_outputs: [
        { name: "body", type: "string", sys_id: EXT_OUT_2, model_id: S2, value: "" },
      ],
    },
  ];
}

export function makeClient(opts: { existing?: boolean } = {}): { client: ServiceNowClient; cap: Cap } {
  var cap: Cap = { tableQueries: [], buildAgentCalls: 0, creates: [], updateSets: [], gets: [], posts: [] };
  var lastPublishedSteps: Array<Record<string, unknown>> | null = null;

  var rowsFor = function (table: string, query: string): Array<Record<string, unknown>> {
    if (table === "sys_scope") {
      if (query === "scope=" + TARGET_SCOPE_NAME || query === "sys_id=" + TARGET_SCOPE) {
        return [{ sys_id: TARGET_SCOPE, scope: TARGET_SCOPE_NAME }];
      }
      return [];
    }
    if (table === "sys_hub_action_type_definition") {
      if (query.indexOf("name=") === 0) {
        return opts.existing ? [{ sys_id: "e".repeat(32), internal_name: "already_there" }] : [];
      }
      if (query === "sys_id=" + SRC) {
        return [{
          sys_id: SRC,
          name: "Send REST",
          internal_name: "send_rest",
          sys_scope: { link: "https://x/api/now/table/sys_scope/" + SRC_SCOPE, value: SRC_SCOPE },
          sys_package: { link: "l", value: SRC_SCOPE },
          state: "published",
          description: "source desc",
          master_snapshot: { link: "l", value: "f".repeat(32) },
          latest_snapshot: "f".repeat(32),
          sys_update_name: "sys_hub_action_type_definition_" + SRC,
          copied_from: "",
          sys_created_on: "2025-01-01",
          sys_mod_count: "4",
        }];
      }
      return [];
    }
    if (table === "sys_hub_action_input" && query === "model_id=" + SRC) {
      return [{ sys_id: "1".repeat(32), element: "endpoint", model_id: { link: "l", value: SRC }, sys_scope: SRC_SCOPE }];
    }
    if (table === "sys_hub_action_output" && query === "model_id=" + SRC) {
      return [{ sys_id: "2".repeat(32), element: "status", model_id: SRC, sys_scope: SRC_SCOPE }];
    }
    if (table === "sys_hub_step_instance" && query === "action=" + SRC) {
      return [
        { sys_id: S1, label: "REST Step", action: { link: "l", value: SRC }, sys_scope: SRC_SCOPE, order: "1" },
        { sys_id: S2, label: "Script Step", action: SRC, sys_scope: SRC_SCOPE, order: "2" },
      ];
    }
    if (table === "sys_hub_step_ext_input" && query === "model_id=" + S1) {
      return [{ sys_id: EXT_IN_1, element: "payload", model_id: S1, sys_scope: SRC_SCOPE }];
    }
    if (table === "sys_hub_step_ext_output" && query === "model_id=" + S2) {
      return [{ sys_id: EXT_OUT_2, element: "body", model_id: { link: "l", value: S2 }, sys_scope: SRC_SCOPE }];
    }
    return [];
  };

  var client = {
    table: {
      query: async function (table: string, query: string) {
        cap.tableQueries.push({ table: table, query: query });
        return rowsFor(table, query);
      },
    },
    buildAgent: {
      runQuery: async function () {
        cap.buildAgentCalls += 1;
        throw new Error("buildAgent must never be called — it 401s on our instances");
      },
      getTableSchema: async function () {
        cap.buildAgentCalls += 1;
        throw new Error("buildAgent must never be called");
      },
    },
    claude: {
      createRecord: async function (params: Cap["creates"][number]) {
        cap.creates.push(params);
        return { sys_id: String(params.sys_id) };
      },
      pushWithUpdateSet: async function () { return { sys_id: "x" }; },
      currentUpdateSet: async function () { return { sys_id: "u", name: "u" }; },
      changeUpdateSet: async function (p: { sysId: string }) { cap.updateSets.push(p.sysId); return {}; },
      deleteRecord: async function () { return {}; },
    },
    attachment: {
      listFor: async function () { return []; },
      upload: async function () { return { sys_id: "att", file_name: "", content_type: "" }; },
      remove: async function () { return undefined; },
    },
    now: {
      get: async function (path: string) {
        cap.gets.push(path);
        if (path.indexOf("/action_types/" + SRC + "/step_instances") !== -1) {
          return { result: { steps: sourceSteps() } };
        }
        if (path.indexOf("/step_instances") !== -1) {
          // Read-back of the clone: what was published.
          return { result: { steps: lastPublishedSteps || [] } };
        }
        return { result: { name: "model", steps: null } };
      },
      post: async function (path: string, body: Record<string, unknown>) {
        cap.posts.push({ path: path, body: body });
        lastPublishedSteps = JSON.parse(JSON.stringify(body.steps));
        return { result: { latest_snapshot: { sys_id: "9".repeat(32) } } };
      },
      put: async function () { return {}; },
      delete: async function () { return {}; },
      invoke: async function () { return { status: 200, body: {} }; },
    },
  } as unknown as ServiceNowClient;
  return { client: client, cap: cap };
}

