import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { buildDescriptors, TOOL_NAMES } from "../registry";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-registry-"));
}

function descByName(deps: any, name: string) {
  var found = buildDescriptors(deps).find(function (d) { return d.name === name; });
  if (!found) throw new Error("missing descriptor: " + name);
  return found;
}

describe("registry", function () {
  it("exposes exactly the 7 tools in TOOL_NAMES", function () {
    expect(TOOL_NAMES.length).toBe(7);
    var built = buildDescriptors({}).map(function (d) { return d.name; });
    expect(built.sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("delete_plan removes an existing plan", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "to-del", content_md: "x" });
    var del = descByName(deps, "delete_plan");
    var res = await del.handler({ slug: "to-del" });
    expect(res.deleted).toBe(true);
    expect(fs.existsSync(path.join(root, "to-del.json"))).toBe(false);
  });

  it("delete_plan returns deleted:false for a missing slug", async function () {
    var root = mkTmp();
    var del = descByName({ storage: { rootDir: root } }, "delete_plan");
    var res = await del.handler({ slug: "no-such-plan" });
    expect(res.deleted).toBe(false);
  });

  it("push_plan persists via storage and returns the plan", async function () {
    var root = mkTmp();
    var desc = descByName({ storage: { rootDir: root } }, "push_plan");
    var result = await desc.handler({ title: "From MCP", content_md: "# yo" });
    expect(result.slug).toBe("from-mcp");
    expect(fs.existsSync(path.join(root, "from-mcp.json"))).toBe(true);
  });

  it("push_diagram rejects non-mermaid sources with a helpful message", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    var setup = descByName(deps, "push_plan");
    await setup.handler({ title: "p", content_md: "x" });
    var diagram = descByName(deps, "push_diagram");
    var res = await diagram.handler({
      plan_slug: "p",
      title: "bad",
      mermaid_source: "this is not mermaid"
    }).catch(function (e: Error) { return e; });
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/recognized diagram header/);
  });

  it("push_diagram accepts a graph header and stores as mermaid kind", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "p", content_md: "x" });
    var res = await descByName(deps, "push_diagram").handler({
      plan_slug: "p",
      title: "flow",
      mermaid_source: "graph TD; A-->B"
    });
    expect(res.kind).toBe("mermaid");
    expect(res.slug).toBe("flow");
  });

  it("update_plan_status enforces the state machine via the handler", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "p", content_md: "x" });
    var update = descByName(deps, "update_plan_status");
    var ok = await update.handler({ slug: "p", to: "APPROVED" });
    expect(ok.status).toBe("APPROVED");
    var err = await update.handler({ slug: "p", to: "DRAFT" }).catch(function (e: Error) { return e; });
    expect(err).toBeInstanceOf(Error);
  });

  it("get_plan throws when missing", async function () {
    var root = mkTmp();
    var get = descByName({ storage: { rootDir: root } }, "get_plan");
    var err = await get.handler({ slug: "nope" }).catch(function (e: Error) { return e; });
    expect(err).toBeInstanceOf(Error);
  });

  it("list_recent_plans returns newest first", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "alpha", content_md: "1" });
    await new Promise(function (r) { setTimeout(r, 5); });
    await descByName(deps, "push_plan").handler({ title: "beta", content_md: "2" });
    var list = await descByName(deps, "list_recent_plans").handler({});
    expect(list.plans[0].slug).toBe("beta");
  });
});
