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
  it("exposes exactly the v1+v2 tool set", function () {
    expect(TOOL_NAMES.length).toBe(16); // v1=12 + lint(2) + Phase C set_stage + pull_plan
    var built = buildDescriptors({}).map(function (d) { return d.name; });
    expect(built.sort()).toEqual([...TOOL_NAMES].sort());
    expect((TOOL_NAMES as readonly string[]).indexOf("get_handoff_bundle")).toBeGreaterThan(-1);
    expect((TOOL_NAMES as readonly string[]).indexOf("push_question")).toBeGreaterThan(-1);
    expect((TOOL_NAMES as readonly string[]).indexOf("record_answer")).toBeGreaterThan(-1);
    expect((TOOL_NAMES as readonly string[]).indexOf("get_answers")).toBeGreaterThan(-1);
    expect((TOOL_NAMES as readonly string[]).indexOf("push_prompt")).toBeGreaterThan(-1);
    expect((TOOL_NAMES as readonly string[]).indexOf("push_lint_event")).toBeGreaterThan(-1);
    expect((TOOL_NAMES as readonly string[]).indexOf("get_lint_events")).toBeGreaterThan(-1);
    expect((TOOL_NAMES as readonly string[]).indexOf("set_stage")).toBeGreaterThan(-1);
    expect((TOOL_NAMES as readonly string[]).indexOf("pull_plan")).toBeGreaterThan(-1);
  });

  it("push_lint_event stores a global lint event (no plan required)", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    var res = await descByName(deps, "push_lint_event").handler({
      score: 35,
      missing: ["<done>", "<target>"],
      antipatterns: ["vague verb"],
      threshold: 50,
      prompt_excerpt: "fix this thing",
      source: "hook"
    });
    expect(res.id).toMatch(/^le_[0-9a-f]{8}$/);
    expect(res.score).toBe(35);
    expect(res.missing).toEqual(["<done>", "<target>"]);
    expect(fs.existsSync(path.join(root, "_lint-events", res.id + ".json"))).toBe(true);
  });

  it("get_lint_events lists events with a limit", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_lint_event").handler({ score: 10, missing: [] });
    await descByName(deps, "push_lint_event").handler({ score: 20, missing: [] });
    await descByName(deps, "push_lint_event").handler({ score: 30, missing: [] });
    var res = await descByName(deps, "get_lint_events").handler({ limit: 2 });
    expect(res.events.length).toBe(2);
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

  it("push_plan returns a dashboard deep-link url honoring CLAUDE_PLANS_DASHBOARD_URL", async function () {
    var root = mkTmp();
    var desc = descByName({ storage: { rootDir: root } }, "push_plan");

    var prev = process.env.CLAUDE_PLANS_DASHBOARD_URL;
    delete process.env.CLAUDE_PLANS_DASHBOARD_URL;
    try {
      var defaultRes = await desc.handler({ title: "URL Default", content_md: "x" });
      expect(defaultRes.url).toBe("http://localhost:3456/claude-plans?plan=url-default");

      process.env.CLAUDE_PLANS_DASHBOARD_URL = "https://plans.example.com/";
      var overrideRes = await desc.handler({ title: "URL Override", content_md: "x" });
      expect(overrideRes.url).toBe("https://plans.example.com/claude-plans?plan=url-override");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLANS_DASHBOARD_URL;
      else process.env.CLAUDE_PLANS_DASHBOARD_URL = prev;
    }
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

  it("push_diagram rejects a sequenceDiagram with ';' in message text", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "p", content_md: "x" });
    var res = await descByName(deps, "push_diagram").handler({
      plan_slug: "p",
      title: "seq",
      mermaid_source: "sequenceDiagram\n    A->>B: restore transform; return PNG"
    }).catch(function (e: Error) { return e; });
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/statement separator/);
    expect((res as Error).message).toMatch(/line 2/);
  });

  it("push_diagram rejects a ';' inside a sequenceDiagram Note", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "p", content_md: "x" });
    var res = await descByName(deps, "push_diagram").handler({
      plan_slug: "p",
      title: "seq-note",
      mermaid_source: "sequenceDiagram\n    Note over A,B: best-effort; unaffected"
    }).catch(function (e: Error) { return e; });
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/statement separator/);
  });

  it("push_diagram accepts a clean sequenceDiagram (no semicolons)", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "p", content_md: "x" });
    var res = await descByName(deps, "push_diagram").handler({
      plan_slug: "p",
      title: "seq-ok",
      mermaid_source: "sequenceDiagram\n    A->>B: restore transform, return PNG"
    });
    expect(res.kind).toBe("mermaid");
  });

  it("push_diagram strips a wrapping markdown code fence before storing", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "p", content_md: "x" });
    var res = await descByName(deps, "push_diagram").handler({
      plan_slug: "p",
      title: "fenced",
      mermaid_source: "```mermaid\nflowchart TD\n    A-->B\n```"
    });
    expect(res.kind).toBe("mermaid");
    var stored = JSON.parse(
      fs.readFileSync(path.join(root, "p", "artifacts", "fenced.json"), "utf8")
    );
    expect(stored.content).toBe("flowchart TD\n    A-->B");
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

  it("push_artifact accepts a prompt-cycle JSON payload via the handler", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "host", content_md: "x" });
    var res = await descByName(deps, "push_artifact").handler({
      plan_slug: "host",
      slug: "cycle",
      kind: "prompt-cycle",
      title: "cycle",
      content: JSON.stringify({
        schema_version: 1,
        original_draft: "go",
        lint_before: { score: 50, missing: ["done"], antipatterns: [], ceremony: [] },
        open_questions: [{ question: "Q", options: ["a", "b"], answer: "a" }],
        rewritten_prompt: "<prompt><done>Done = ok</done></prompt>",
        lint_after: { score: 100, missing: [], ceremony: ["ultrathink"] }
      })
    });
    expect(res.kind).toBe("prompt-cycle");
  });

  it("push_prompt persists a prompt with scores via the handler", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "host", content_md: "x" });
    var res = await descByName(deps, "push_prompt").handler({
      plan_slug: "host",
      title: "Rewrite v1",
      content: "<prompt><done>Done = green</done></prompt>",
      source_draft: "make it better",
      score_before: 17,
      score_after: 92
    });
    expect(res.slug).toBe("rewrite-v1");
    expect(res.score_before).toBe(17);
    expect(res.score_after).toBe(92);
    var diskPath = path.join(root, "host", "prompts", "rewrite-v1.json");
    expect(fs.existsSync(diskPath)).toBe(true);
  });

  it("push_prompt rejects missing plan_slug via Zod", async function () {
    var root = mkTmp();
    var desc = descByName({ storage: { rootDir: root } }, "push_prompt");
    var err = await desc.handler({ title: "x", content: "y" }).catch(function (e: Error) { return e; });
    expect(err).toBeInstanceOf(Error);
  });

  it("push_prompt rejects score_after > 100 via Zod", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "host", content_md: "x" });
    var err = await descByName(deps, "push_prompt")
      .handler({ plan_slug: "host", title: "t", content: "c", score_after: 150 })
      .catch(function (e: Error) { return e; });
    expect(err).toBeInstanceOf(Error);
  });

  it("push_prompt throws when plan does not exist", async function () {
    var root = mkTmp();
    var desc = descByName({ storage: { rootDir: root } }, "push_prompt");
    var err = await desc
      .handler({ plan_slug: "ghost", title: "x", content: "y" })
      .catch(function (e: Error) { return e; });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/plan not found/);
  });

  it("push_artifact rejects an invalid prompt-cycle payload via the handler", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "host", content_md: "x" });
    var res = await descByName(deps, "push_artifact").handler({
      plan_slug: "host",
      kind: "prompt-cycle",
      title: "bad",
      content: "not-json"
    }).catch(function (e: Error) { return e; });
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/not valid JSON/);
  });

  it("push_plan stores linked_artifacts via the handler", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    var res = await descByName(deps, "push_plan").handler({
      title: "linker",
      content_md: "x",
      linked_artifacts: [{ plan_slug: "target", relation: "improves" }]
    });
    expect(res.linked_artifacts[0].plan_slug).toBe("target");
  });

  it("get_handoff_bundle returns markdown for an existing plan", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "handed", content_md: "# body" });
    var res = await descByName(deps, "get_handoff_bundle").handler({ slug: "handed" });
    expect(res.slug).toBe("handed");
    expect(res.markdown).toMatch(/# Handoff: handed/);
    expect(res.ready_to_paste_prompt).toBeNull();
  });

  it("get_handoff_bundle hoists a prompt-cycle's rewritten prompt", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "h", content_md: "x" });
    await descByName(deps, "push_artifact").handler({
      plan_slug: "h",
      slug: "c",
      kind: "prompt-cycle",
      title: "c",
      content: JSON.stringify({
        schema_version: 1,
        original_draft: "go",
        lint_before: { score: 50, missing: ["done"] },
        open_questions: [],
        rewritten_prompt: "<prompt><done>Done = ship</done></prompt>",
        lint_after: { score: 100, missing: [] }
      })
    });
    var res = await descByName(deps, "get_handoff_bundle").handler({ slug: "h" });
    expect(res.ready_to_paste_prompt).toMatch(/Done = ship/);
    expect(res.markdown).toMatch(/READY-TO-PASTE PROMPT/);
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

  it("push_question / record_answer / get_answers round-trip via handlers", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "qa-plan", content_md: "x" });

    var pushed = await descByName(deps, "push_question").handler({
      plan_slug: "qa-plan",
      question: "Pick the storage shape?",
      header: "Storage",
      options: ["nested", "split"],
      stage: "plan",
      asked_by: "idea-shaper"
    });
    expect(pushed.id).toMatch(/^q_[0-9a-f]{8}$/);
    expect(pushed.question).toBe("Pick the storage shape?");
    expect(pushed.stage).toBe("plan");

    var answered = await descByName(deps, "record_answer").handler({
      plan_slug: "qa-plan",
      question_id: pushed.id,
      answer: "nested",
      answered_by: "daniel"
    });
    expect(answered.answer).toBe("nested");
    expect(answered.answered_by).toBe("daniel");
    expect(typeof answered.answered_at).toBe("string");

    var listed = await descByName(deps, "get_answers").handler({ plan_slug: "qa-plan" });
    expect(listed.plan_slug).toBe("qa-plan");
    expect(listed.questions.length).toBe(1);
    expect(listed.questions[0].id).toBe(pushed.id);
    expect(listed.questions[0].answer).toBe("nested");
  });

  it("get_answers filters by answered and by stage", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "qa-filter", content_md: "x" });
    var q1 = await descByName(deps, "push_question").handler({
      plan_slug: "qa-filter", question: "stage1?", stage: "research"
    });
    await descByName(deps, "push_question").handler({
      plan_slug: "qa-filter", question: "stage2?", stage: "plan"
    });
    await descByName(deps, "record_answer").handler({
      plan_slug: "qa-filter", question_id: q1.id, answer: "yes"
    });

    var answered = await descByName(deps, "get_answers").handler({
      plan_slug: "qa-filter", answered: true
    });
    expect(answered.questions.length).toBe(1);
    expect(answered.questions[0].stage).toBe("research");

    var unanswered = await descByName(deps, "get_answers").handler({
      plan_slug: "qa-filter", answered: false
    });
    expect(unanswered.questions.length).toBe(1);
    expect(unanswered.questions[0].stage).toBe("plan");

    var byStage = await descByName(deps, "get_answers").handler({
      plan_slug: "qa-filter", stage: "plan"
    });
    expect(byStage.questions.length).toBe(1);
    expect(byStage.questions[0].question).toBe("stage2?");
  });

  it("push_question errors when the plan does not exist", async function () {
    var root = mkTmp();
    var res = await descByName({ storage: { rootDir: root } }, "push_question").handler({
      plan_slug: "missing", question: "Q?"
    }).catch(function (e: Error) { return e; });
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/plan not found/);
  });

  it("record_answer rejects an id that doesn't match q_<8-hex>", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "rej", content_md: "x" });
    var res = await descByName(deps, "record_answer").handler({
      plan_slug: "rej", question_id: "not-a-real-id", answer: "x"
    }).catch(function (e: Error) { return e; });
    expect(res).toBeInstanceOf(Error);
  });

  it("record_answer errors when the question id is unknown", async function () {
    var root = mkTmp();
    var deps = { storage: { rootDir: root } };
    await descByName(deps, "push_plan").handler({ title: "qa-miss", content_md: "x" });
    var res = await descByName(deps, "record_answer").handler({
      plan_slug: "qa-miss", question_id: "q_00000000", answer: "x"
    }).catch(function (e: Error) { return e; });
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/question not found/);
  });
});
