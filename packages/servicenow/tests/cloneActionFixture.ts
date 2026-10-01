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
/** Live pill shape (tenonworkstudio 2026-09-30): step cid in brackets, output element after. */
export var PILL_STATUS_CODE = "{{step[7d49315c-b657-4319-b150-f96c556c95d3].status_code}}";
export var ACTION_STATUS_JSON = "{\"code\":\"{{step[7d49315c-b657-4319-b150-f96c556c95d3].status_code}}\",\"message\":\"\"}";
export var MAP_1 = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
export var MAP_2 = "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
export var MAP_3 = "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3";
export var DOC_IN = "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";
export var DOC_OUT = "f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2";
export var EXISTING_TARGET_DOC = "f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9";

export function varTable(table: string, model: string): string {
  return "var__m_" + table + "_" + model;
}

export var SCRIPT = "(function execute(inputs, outputs) {\n  outputs.body = inputs.responseBody;\n})(inputs, outputs);";

export interface Cap {
  tableQueries: Array<{ table: string; query: string }>;
  buildAgentCalls: number;
  creates: Array<{ table: string; fields: Record<string, unknown>; scope?: string; update_set_sys_id?: string; sys_id?: string }>;
  updateSets: Array<string>;
  gets: Array<string>;
  posts: Array<{ path: string; body: Record<string, unknown> }>;
  pushes: Array<{ table: string; record_sys_id: string; fields: Record<string, unknown>; update_set_sys_id: string }>;
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

export interface ClientOpts {
  existing?: boolean;
  /** The target already has a sys_documentation row for the cloned input `endpoint` (platform auto-created). */
  existingTargetLabel?: boolean;
  /** Output mapping `field` the instance "loses" on read-back — verify must fail. */
  dropMappingOnReadback?: string;
}

/** sys_element_mapping rows exactly as the live instance stores an action output wiring. */
function sourceMappings(): Array<Record<string, unknown>> {
  var table = varTable("sys_hub_action_output", SRC);
  return [
    { sys_id: MAP_1, id: SRC, table: table, field: "status_code", value: PILL_STATUS_CODE, sys_scope: { link: "l", value: SRC_SCOPE }, sys_mod_count: "0" },
    { sys_id: MAP_2, id: SRC, table: table, field: "__action_status__", value: ACTION_STATUS_JSON, sys_scope: SRC_SCOPE },
    { sys_id: MAP_3, id: SRC, table: table, field: "__dont_treat_as_error__", value: "false", sys_scope: SRC_SCOPE },
  ];
}

export function makeClient(opts: ClientOpts = {}): { client: ServiceNowClient; cap: Cap } {
  var cap: Cap = { tableQueries: [], buildAgentCalls: 0, creates: [], updateSets: [], gets: [], posts: [], pushes: [] };
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
      return [{
        sys_id: "1".repeat(32), element: "endpoint", label: "Endpoint", name: varTable("sys_hub_action_input", SRC),
        model_id: { link: "l", value: SRC }, sys_scope: SRC_SCOPE,
      }];
    }
    if (table === "sys_hub_action_output" && query === "model_id=" + SRC) {
      return [{
        sys_id: "2".repeat(32), element: "status_code", label: "Status Code", name: varTable("sys_hub_action_output", SRC),
        model_id: SRC, sys_scope: SRC_SCOPE,
      }];
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
      return [{
        sys_id: EXT_OUT_2, element: "body", name: varTable("sys_hub_step_ext_output", S2),
        model_id: { link: "l", value: S2 }, sys_scope: SRC_SCOPE,
      }];
    }
    if (table === "sys_element_mapping") {
      var m = /^id=([0-9a-f]{32})\^tableSTARTSWITHvar__m_sys_hub_action_output_$/.exec(query);
      if (!m) {
        return [];
      }
      var modelId = m[1];
      if (modelId === SRC) {
        return sourceMappings();
      }
      // Read-back of the clone: what was written.
      return cap.creates
        .filter(function (c) {
          return c.table === "sys_element_mapping" && c.fields.id === modelId && c.fields.field !== opts.dropMappingOnReadback;
        })
        .map(function (c) { return c.fields; });
    }
    if (table === "sys_documentation") {
      if (query === "name=" + varTable("sys_hub_action_input", SRC)) {
        return [{ sys_id: DOC_IN, name: varTable("sys_hub_action_input", SRC), element: "endpoint", label: "Endpoint", language: "en", sys_scope: SRC_SCOPE }];
      }
      if (query === "name=" + varTable("sys_hub_action_output", SRC)) {
        return [
          { sys_id: DOC_OUT, name: varTable("sys_hub_action_output", SRC), element: "status_code", label: "Status Code", plural: "Status Codes", language: "en", sys_scope: { link: "l", value: SRC_SCOPE } },
        ];
      }
      if (opts.existingTargetLabel && /^name=var__m_sys_hub_action_input_[0-9a-f]{32}\^element=endpoint\^language=en$/.test(query)) {
        return [{ sys_id: EXISTING_TARGET_DOC }];
      }
      return [];
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
      pushWithUpdateSet: async function (p: Cap["pushes"][number]) { cap.pushes.push(p); return { sys_id: p.record_sys_id }; },
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

