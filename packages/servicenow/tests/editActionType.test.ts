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
