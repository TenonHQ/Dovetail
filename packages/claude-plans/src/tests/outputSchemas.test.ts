import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";

import { buildDescriptors } from "../registry";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-outputschema-"));
}

function descByName(deps: any, name: string) {
  var found = buildDescriptors(deps).find(function (d) {
    return d.name === name;
  });
  if (!found) throw new Error("missing descriptor: " + name);
  return found;
}

// Mirror the MCP SDK's validateToolOutput: it reconstructs z.object(shape)
// (strip mode) and safeParses the handler's structuredContent, THROWING on
// failure. A schema that doesn't accept the real return would break the tool
// against a live client even though unit tests calling the handler directly pass.
function assertValidates(shape: any, value: any): void {
  var result = z.object(shape).safeParse(value);
  if (!result.success) {
    throw new Error(
      "output schema rejected the real handler return: " + JSON.stringify(result.error.issues)
    );
  }
  expect(result.success).toBe(true);
}

describe("claude-plans outputSchemas accept real handler returns", function () {
  it("push_plan", async function () {
    var deps = { storage: { rootDir: mkTmp() } };
    var desc = descByName(deps, "push_plan");
    var out = await desc.handler({ title: "Schema Plan", content_md: "# body" });
    assertValidates(desc.outputSchema, out);
  });

  it("pull_plan", async function () {
    var deps = { storage: { rootDir: mkTmp() } };
    await descByName(deps, "push_plan").handler({ title: "p", content_md: "x" });
    var desc = descByName(deps, "pull_plan");
    var out = await desc.handler({ plan_slug: "p" });
    assertValidates(desc.outputSchema, out);
  });

  it("get_handoff_bundle", async function () {
    var deps = { storage: { rootDir: mkTmp() } };
    await descByName(deps, "push_plan").handler({ title: "h", content_md: "# b" });
    var desc = descByName(deps, "get_handoff_bundle");
    var out = await desc.handler({ slug: "h" });
    assertValidates(desc.outputSchema, out);
  });

  it("list_recent_plans", async function () {
    var deps = { storage: { rootDir: mkTmp() } };
    await descByName(deps, "push_plan").handler({ title: "a", content_md: "1" });
    var desc = descByName(deps, "list_recent_plans");
    var out = await desc.handler({});
    assertValidates(desc.outputSchema, out);
  });

  it("get_answers", async function () {
    var deps = { storage: { rootDir: mkTmp() } };
    await descByName(deps, "push_plan").handler({ title: "qa", content_md: "x" });
    await descByName(deps, "push_question").handler({ plan_slug: "qa", question: "Q?" });
    var desc = descByName(deps, "get_answers");
    var out = await desc.handler({ plan_slug: "qa" });
    assertValidates(desc.outputSchema, out);
  });

  it("schema'd descriptors carry outputSchema; an un-schema'd one does not", function () {
    var deps = { storage: { rootDir: mkTmp() } };
    ["push_plan", "pull_plan", "get_handoff_bundle", "list_recent_plans", "get_answers"].forEach(
      function (name) {
        expect(descByName(deps, name).outputSchema).toBeDefined();
      }
    );
    expect(descByName(deps, "delete_plan").outputSchema).toBeUndefined();
  });
});
