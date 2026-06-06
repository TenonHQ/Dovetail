import { z } from "zod";
import { flowViewOutput, actionViewOutput } from "../src/mcp/outputSchemas";
import { buildDescriptors } from "../src/mcp/registry";

// Mirror the MCP SDK's validateToolOutput: z.object(shape) (strip mode) safeParse,
// throwing on failure. Representative returns mirror ReadFlowResult /
// ReadActionTypeResult, so this asserts schema ⊇ the real shape.
function assertValidates(schema: any, value: any): void {
  var result = z.object(schema.shape).safeParse(value);
  if (!result.success) {
    throw new Error("output schema rejected the return shape: " + JSON.stringify(result.error.issues));
  }
  expect(result.success).toBe(true);
}

describe("servicenow outputSchemas accept the documented return shapes", function () {
  it("flow_view → ReadFlowResult", function () {
    assertValidates(flowViewOutput, {
      sysId: "s",
      name: "My Flow",
      internalName: "my_flow",
      type: "Flow",
      scopeSysId: "scope",
      published: true,
      userCanRead: true,
      status: "published",
      steps: [{ kind: "action", order: 1, label: "Send", uiId: "u", parent: "", depth: 0 }],
      variables: [{ name: "v", label: "V", type: "string" }],
      counts: { action: 1, logic: 0, total: 1 }
    });
  });

  it("action_view → ReadActionTypeResult", function () {
    assertValidates(actionViewOutput, {
      sysId: "s",
      name: "My Action",
      internalName: "my_action",
      description: "d",
      inputs: [{ name: "i", label: "I", type: "string" }],
      outputs: [{ name: "o", label: "O", type: "string" }],
      counts: { inputs: 1, outputs: 1 }
    });
  });

  it("the two read tools declare outputSchema; a write tool does not", function () {
    var byName: Record<string, any> = {};
    buildDescriptors().forEach(function (d) {
      byName[d.name] = d;
    });
    expect(byName["flow_view"].outputSchema).toBeDefined();
    expect(byName["action_view"].outputSchema).toBeDefined();
    expect(byName["flow_publish"].outputSchema).toBeUndefined();
  });
});
