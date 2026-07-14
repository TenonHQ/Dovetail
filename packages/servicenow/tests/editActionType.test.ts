import { editActionType } from "../src/flowDesigner/editActionType";
import type { ServiceNowClient } from "../src/client";

interface Cap {
  gets: Array<string>;
  posts: Array<{ path: string; body: any }>;
  updateSets: Array<string>;
}

// getResponses is consumed sequentially: index 0 = the model GET (steps:null),
// index 1 = the /step_instances GET (carries the script).
function mockClient(getResponses: Array<any>, postResponse?: any): { client: ServiceNowClient; cap: Cap } {
  var cap: Cap = { gets: [], posts: [], updateSets: [] };
  var idx = 0;
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
      changeUpdateSet: async function (p: { sysId: string }) { cap.updateSets.push(p.sysId); return {}; },
      deleteRecord: async function () { return {}; },
    },
    attachment: {
      listFor: async function () { return []; },
      upload: async function () { return { sys_id: "att", file_name: "", content_type: "" }; },
      remove: async function () { return undefined; }
    },
    now: {
      get: async function <T>(path: string): Promise<T> {
        cap.gets.push(path);
        var r = getResponses[idx] !== undefined ? getResponses[idx] : getResponses[getResponses.length - 1];
        idx += 1;
        return r as T;
      },
      post: async function <T>(path: string, body: any): Promise<T> {
        cap.posts.push({ path: path, body: body });
        return (postResponse !== undefined ? postResponse : { latest_snapshot: { sys_id: "snap1" } }) as T;
      },
    },
  } as unknown as ServiceNowClient;
  return { client: client, cap: cap };
}

var SYS = "a7bfc7d6c3458310d4ddf1db05013105";
var SCOPE = "5e9f5f8b87420250369f33373cbb3559";
var SCRIPT_OLD =
  "(function execute(inputs, outputs) {\n" +
  "  const e = new x_cadso_automate.TenonEmailUtils();\n" +
  "  outputs.recipients = e.grabHashData(inputs.sendId);\n" +
  "})(inputs, outputs);";

function fixtures(scriptValue: string): Array<any> {
  return [
    { result: { outputs: [{ name: "to_address_list", type: "Array.String" }], steps: null, scope: SCOPE } },
    { result: { steps: [{ action: "orig", inputs: [{ name: "script", value: scriptValue }] }] } },
  ];
}

describe("editActionType", function () {
  it("dry-run previews a script patch without writing", async function () {
    var m = mockClient(fixtures(SCRIPT_OLD));
    var res = await editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE,
      ops: { patchScript: { find: "grabHashData", replace: "grabRecipients" } },
    });
    expect(res.status).toBe("preview");
    expect(m.cap.posts.length).toBe(0);
    expect(res.scriptBefore).toContain("grabHashData");
    expect(res.scriptAfter).toContain("grabRecipients(inputs.sendId)");
    expect(res.changes.length).toBe(1);
    // it still reads both the model and the steps
    expect(m.cap.gets.length).toBe(2);
    expect(m.cap.gets[1]).toContain("/step_instances");
  });

  it("apply patches the script and republishes via /snapshot with action remapped + update set pinned", async function () {
    var m = mockClient(fixtures(SCRIPT_OLD));
    var res = await editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE,
      ops: { patchScript: { find: "grabHashData", replace: "grabRecipients" } },
      apply: true, updateSetSysId: "us1",
    });
    expect(res.status).toBe("published");
    expect(res.snapshotSysId).toBe("snap1");
    expect(m.cap.updateSets).toEqual(["us1"]);
    expect(m.cap.posts.length).toBe(1);
    expect(m.cap.posts[0].path).toContain("/snapshot");
    var posted = m.cap.posts[0].body;
    expect(posted.steps[0].action).toBe(SYS); // remapped from "orig"
    expect(posted.steps[0].inputs[0].value).toContain("grabRecipients(inputs.sendId)");
    expect(posted.steps[0].inputs[0].value).not.toContain("grabHashData");
  });

  it("merges an output variable into the model by name (append)", async function () {
    var m = mockClient(fixtures(SCRIPT_OLD));
    var recipients = {
      name: "recipients",
      type: "array.object",
      children: [{ name: "recipients.recipient.address", type: "string" }],
    };
    var res = await editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE,
      ops: { mergeOutputs: [recipients] }, apply: true,
    });
    expect(res.outputsMerged).toEqual(["recipients"]);
    var names = m.cap.posts[0].body.outputs.map(function (o: any) { return o.name; });
    expect(names).toContain("recipients");
    expect(names).toContain("to_address_list");
  });

  it("warns when patchScript.find is absent and makes no change", async function () {
    var m = mockClient(fixtures("(function execute(inputs, outputs){ outputs.x = 1; })(inputs, outputs);"));
    var res = await editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE,
      ops: { patchScript: { find: "grabHashData", replace: "grabRecipients" } },
    });
    expect(res.warnings.join(" ")).toContain("not present");
    expect(res.changes.length).toBe(0);
  });

  it("throws when no ops are supplied", async function () {
    var m = mockClient(fixtures(SCRIPT_OLD));
    await expect(
      editActionType({ client: m.client, sysId: SYS, scopeSysId: SCOPE, ops: {} })
    ).rejects.toThrow(/no ops/);
  });
});

// --- per-step ops: multi-step scripts, step-level IO, pill wiring (issue #216) ---

var PARSE_CID = "c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
var HANDLE_CID = "c2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function stepGraph(): Array<any> {
  return [
    {
      cid: PARSE_CID,
      label: "Parse Response",
      action: "orig",
      inputs: [{ name: "script", value: SCRIPT_OLD }],
      extended_inputs: [
        { name: "responseBody", label: "Response Body", type: "string", type_label: "String",
          order: 100, mandatory: true, sys_id: "sib1", value: "{{step[c0].payload}}" }
      ],
      extended_outputs: [
        { name: "body", label: "Body", type: "string", type_label: "String",
          order: 100, mandatory: false, sys_id: "sib2", value: "" }
      ]
    },
    {
      cid: HANDLE_CID,
      label: "Handle Error",
      action: "orig",
      inputs: [{ name: "script", value: "(function execute(inputs, outputs) { outputs.done = true; })(inputs, outputs);" }],
      extended_inputs: [
        { name: "errorMessage", label: "Error Message", type: "string", type_label: "String",
          order: 100, mandatory: false, sys_id: "sib3", value: "" }
      ],
      extended_outputs: []
    }
  ];
}

/** GET model, GET step_instances, then (on apply) the verify-pass GET step_instances. */
function stepFixtures(readBack?: Array<any>): Array<any> {
  return [
    { result: { outputs: [], steps: null, scope: SCOPE } },
    { result: { steps: stepGraph() } },
    { result: { steps: readBack || stepGraph() } }
  ];
}

var STEP_OPS = {
  patchStepScripts: [{ step: "Parse Response", setScript: "(function execute(inputs, outputs) { outputs.body = JSON.parse(inputs.responseBody); })(inputs, outputs);" }],
  addStepOutputs: [{ step: "Parse Response", name: "isRetryable", type: "boolean" }],
  addStepInputs: [{
    step: "Handle Error", name: "isRetryable", type: "boolean",
    pillFrom: { step: "Parse Response", output: "isRetryable" }
  }]
};

describe("editActionType — per-step ops", function () {
  it("dry-run returns the per-step before/after and writes nothing", async function () {
    var m = mockClient(stepFixtures());
    var res = await editActionType({ client: m.client, sysId: SYS, scopeSysId: SCOPE, ops: STEP_OPS });

    expect(res.status).toBe("preview");
    expect(m.cap.posts.length).toBe(0);
    expect(res.changes.length).toBe(3);
    expect(res.stepsBefore![0].extendedOutputs.map(function (o) { return o.name; })).toEqual(["body"]);
    expect(res.stepsAfter![0].extendedOutputs.map(function (o) { return o.name; })).toEqual(["body", "isRetryable"]);
    expect(res.stepsAfter![1].extendedInputs[1].value).toBe("{{step[" + PARSE_CID + "].isRetryable}}");
    expect(res.verified).toBeUndefined();
  });

  it("apply publishes ONE snapshot carrying every step op, with action remapped", async function () {
    var m = mockClient(stepFixtures());
    var res = await editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE, ops: STEP_OPS,
      apply: true, updateSetSysId: "us1"
    });

    expect(res.status).toBe("published");
    expect(m.cap.updateSets).toEqual(["us1"]);
    expect(m.cap.posts.length).toBe(1);

    var posted = m.cap.posts[0].body;
    expect(posted.steps[0].action).toBe(SYS);
    expect(posted.steps[0].inputs[0].value).toContain("JSON.parse");
    expect(posted.steps[0].extended_outputs[1].name).toBe("isRetryable");
    expect(posted.steps[1].extended_inputs[1].value).toBe("{{step[" + PARSE_CID + "].isRetryable}}");
  });

  it("verifies the publish by reading the steps back", async function () {
    // The read-back reflects the edit: patched script + the new output + the wired input.
    var landed = stepGraph();
    landed[0].inputs[0].value = STEP_OPS.patchStepScripts[0].setScript;
    landed[0].extended_outputs.push({ name: "isRetryable", label: "isRetryable", type: "boolean",
      type_label: "Boolean", order: 101, mandatory: false, sys_id: "new1", value: "" });
    landed[1].extended_inputs.push({ name: "isRetryable", label: "isRetryable", type: "boolean",
      type_label: "Boolean", order: 101, mandatory: false, sys_id: "new2",
      value: "{{step[" + PARSE_CID + "].isRetryable}}" });

    var m = mockClient(stepFixtures(landed));
    var res = await editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE, ops: STEP_OPS, apply: true
    });

    expect(res.verified!.ok).toBe(true);
    expect(m.cap.gets.length).toBe(3);
    expect(m.cap.gets[2]).toContain("/step_instances");
  });

  it("flags a publish that compiled but did NOT land the edit", async function () {
    // 201 back, but the instance still reports the original graph.
    var m = mockClient(stepFixtures(stepGraph()));
    var res = await editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE, ops: STEP_OPS, apply: true
    });

    expect(res.status).toBe("published");
    expect(res.verified!.ok).toBe(false);
    expect(res.verified!.notes.join(" ")).toContain("absent on read-back");
    expect(res.warnings.join(" ")).toContain("VERIFY FAILED");
  });

  it("skips the read-back GET entirely when every op was a no-op", async function () {
    var m = mockClient(stepFixtures());
    var res = await editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE,
      // 'body' is already an output on Parse Response — idempotent skip, nothing changes.
      ops: { addStepOutputs: [{ step: "Parse Response", name: "body", type: "string" }] },
      apply: true
    });

    expect(res.changes.length).toBe(0);
    expect(res.verified!.ok).toBe(true);
    expect(res.verified!.notes.join(" ")).toContain("nothing to verify");
    // Only the model GET + the step_instances GET — no third, wasted round-trip.
    expect(m.cap.gets.length).toBe(2);
  });

  it("refuses to mix the auto-detect script ops with explicit per-step ops", async function () {
    var m = mockClient(stepFixtures());
    await expect(editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE,
      ops: {
        setScript: "x",
        patchStepScripts: [{ step: "Parse Response", setScript: "y" }]
      }
    })).rejects.toThrow(/cannot be combined/);
  });

  it("surfaces an unknown step ref as an error naming the steps that exist", async function () {
    var m = mockClient(stepFixtures());
    await expect(editActionType({
      client: m.client, sysId: SYS, scopeSysId: SCOPE,
      ops: { addStepOutputs: [{ step: "Nonexistent Step", name: "x" }] }
    })).rejects.toThrow(/step not found: 'Nonexistent Step'/);
  });
});
