import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildHandoffBundle,
  deletePlan,
  getPlan,
  listArtifacts,
  listPlans,
  parsePromptCycleContent,
  pushArtifact,
  pushPlan,
  slugify,
  updatePlanStatus
} from "../storage";

function validCycle(overrides: any = {}): string {
  var payload = Object.assign(
    {
      schema_version: 1,
      original_draft: "draft text",
      lint_before: { score: 50, missing: ["done"], antipatterns: [], ceremony: [] },
      open_questions: [{ question: "Q1", options: ["a", "b"], answer: "a" }],
      rewritten_prompt: "<prompt><done>Done = it works</done></prompt>",
      lint_after: { score: 100, missing: [], ceremony: ["ultrathink"] }
    },
    overrides
  );
  return JSON.stringify(payload);
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-test-"));
}

describe("slugify", function () {
  it("kebab-cases and strips punctuation", function () {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  --foo--BAR  ")).toBe("foo-bar");
    expect(slugify("")).toBe("untitled");
  });
});

describe("plan CRUD", function () {
  it("round-trips a plan with auto-slug, content_hash, and timestamps", function () {
    var root = mkTmp();
    var p = pushPlan({ title: "My First Plan", content_md: "# hi" }, { rootDir: root });
    expect(p.slug).toBe("my-first-plan");
    expect(p.status).toBe("DRAFT");
    expect(p.content_hash).toHaveLength(64);
    expect(p.created_at).toBe(p.updated_at);

    var got = getPlan("my-first-plan", { rootDir: root });
    expect(got).not.toBeNull();
    expect(got && got.plan.title).toBe("My First Plan");
    expect(got && got.artifacts).toEqual([]);
  });

  it("preserves created_at and bumps updated_at on update", async function () {
    var root = mkTmp();
    var p1 = pushPlan({ title: "X", content_md: "v1" }, { rootDir: root });
    await new Promise(function (r) { setTimeout(r, 10); });
    var p2 = pushPlan({ title: "X", content_md: "v2" }, { rootDir: root });
    expect(p2.created_at).toBe(p1.created_at);
    expect(p2.updated_at > p1.updated_at).toBe(true);
    expect(p2.content_hash).not.toBe(p1.content_hash);
  });

  it("returns empty list when storage dir does not exist", function () {
    var root = path.join(mkTmp(), "does-not-exist");
    expect(listPlans({ rootDir: root })).toEqual([]);
  });

  it("orders plans newest first and filters by status", function () {
    var root = mkTmp();
    pushPlan({ title: "alpha", content_md: "a" }, { rootDir: root });
    pushPlan({ title: "beta", content_md: "b" }, { rootDir: root });
    updatePlanStatus("alpha", "APPROVED", { rootDir: root });
    var all = listPlans({ rootDir: root });
    expect(all.length).toBe(2);
    expect(all[0].slug).toBe("alpha");
    var drafts = listPlans({ rootDir: root, status: "DRAFT" });
    expect(drafts.length).toBe(1);
    expect(drafts[0].slug).toBe("beta");
  });
});

describe("status transitions", function () {
  it("allows DRAFT->APPROVED->EXITED", function () {
    var root = mkTmp();
    pushPlan({ title: "t", content_md: "x" }, { rootDir: root });
    expect(updatePlanStatus("t", "APPROVED", { rootDir: root }).status).toBe("APPROVED");
    expect(updatePlanStatus("t", "EXITED", { rootDir: root }).status).toBe("EXITED");
  });

  it("rejects reverses and skips", function () {
    var root = mkTmp();
    pushPlan({ title: "t", content_md: "x" }, { rootDir: root });
    updatePlanStatus("t", "EXITED", { rootDir: root });
    expect(function () {
      updatePlanStatus("t", "APPROVED", { rootDir: root });
    }).toThrow(/invalid transition/);
  });

  it("rejects missing plan", function () {
    var root = mkTmp();
    expect(function () {
      updatePlanStatus("nope", "EXITED", { rootDir: root });
    }).toThrow(/plan not found/);
  });
});

describe("artifacts", function () {
  it("rejects artifact when plan does not exist", function () {
    var root = mkTmp();
    expect(function () {
      pushArtifact(
        { plan_slug: "ghost", kind: "markdown", title: "x", content: "y" },
        { rootDir: root }
      );
    }).toThrow(/plan not found/);
  });

  it("stores and lists artifacts in created order", function () {
    var root = mkTmp();
    pushPlan({ title: "p", content_md: "x" }, { rootDir: root });
    pushArtifact(
      { plan_slug: "p", kind: "markdown", title: "first", content: "1" },
      { rootDir: root }
    );
    pushArtifact(
      { plan_slug: "p", kind: "mermaid", title: "second", content: "graph TD; A-->B" },
      { rootDir: root }
    );
    var arts = listArtifacts("p", { rootDir: root });
    expect(arts.map(function (a) { return a.slug; })).toEqual(["first", "second"]);
    expect(arts[1].kind).toBe("mermaid");
  });

  it("deletePlan removes file and nested artifacts dir", function () {
    var root = mkTmp();
    pushPlan({ title: "z", content_md: "x" }, { rootDir: root });
    pushArtifact(
      { plan_slug: "z", kind: "markdown", title: "a", content: "a" },
      { rootDir: root }
    );
    expect(deletePlan("z", { rootDir: root })).toBe(true);
    expect(getPlan("z", { rootDir: root })).toBeNull();
    expect(fs.existsSync(path.join(root, "z"))).toBe(false);
  });
});

describe("linked_artifacts on plans", function () {
  it("persists linked_artifacts when provided", function () {
    var root = mkTmp();
    var p = pushPlan(
      {
        title: "child",
        content_md: "x",
        linked_artifacts: [
          { plan_slug: "parent", relation: "improves", note: "n" }
        ]
      },
      { rootDir: root }
    );
    expect(p.linked_artifacts).toEqual([
      { plan_slug: "parent", relation: "improves", note: "n" }
    ]);
    var got = getPlan("child", { rootDir: root });
    expect(got && got.plan.linked_artifacts && got.plan.linked_artifacts[0].relation).toBe("improves");
  });

  it("preserves prior links on subsequent push without the field", function () {
    var root = mkTmp();
    pushPlan(
      {
        title: "child",
        content_md: "v1",
        linked_artifacts: [{ plan_slug: "parent", relation: "built-from" }]
      },
      { rootDir: root }
    );
    var updated = pushPlan({ title: "child", content_md: "v2" }, { rootDir: root });
    expect(updated.linked_artifacts && updated.linked_artifacts[0].plan_slug).toBe("parent");
  });

  it("clears prior links when caller passes an empty array explicitly", function () {
    var root = mkTmp();
    pushPlan(
      {
        title: "child",
        content_md: "v1",
        linked_artifacts: [{ plan_slug: "parent", relation: "built-from" }]
      },
      { rootDir: root }
    );
    var cleared = pushPlan(
      { title: "child", content_md: "v2", linked_artifacts: [] },
      { rootDir: root }
    );
    expect(cleared.linked_artifacts).toEqual([]);
  });
});

describe("prompt-cycle artifact kind", function () {
  it("accepts a valid prompt-cycle payload and round-trips it", function () {
    var root = mkTmp();
    pushPlan({ title: "host", content_md: "x" }, { rootDir: root });
    var a = pushArtifact(
      {
        plan_slug: "host",
        slug: "cycle",
        kind: "prompt-cycle",
        title: "improve cycle",
        content: validCycle()
      },
      { rootDir: root }
    );
    expect(a.kind).toBe("prompt-cycle");
    var got = getPlan("host", { rootDir: root });
    expect(got && got.artifacts[0].kind).toBe("prompt-cycle");
    var parsed = parsePromptCycleContent(got!.artifacts[0].content);
    expect(parsed.lint_after.score).toBe(100);
    expect(parsed.open_questions[0].answer).toBe("a");
  });

  it("rejects malformed JSON", function () {
    var root = mkTmp();
    pushPlan({ title: "host", content_md: "x" }, { rootDir: root });
    expect(function () {
      pushArtifact(
        { plan_slug: "host", kind: "prompt-cycle", title: "bad", content: "{not json" },
        { rootDir: root }
      );
    }).toThrow(/not valid JSON/);
  });

  it("rejects payload missing required fields", function () {
    var root = mkTmp();
    pushPlan({ title: "host", content_md: "x" }, { rootDir: root });
    expect(function () {
      pushArtifact(
        {
          plan_slug: "host",
          kind: "prompt-cycle",
          title: "bad",
          content: JSON.stringify({ schema_version: 1, original_draft: "x" })
        },
        { rootDir: root }
      );
    }).toThrow(/failed validation/);
  });
});

describe("buildHandoffBundle", function () {
  it("includes plan content + linked plans section + artifacts and hoists the rewritten prompt", function () {
    var root = mkTmp();
    pushPlan(
      { title: "parent plan", content_md: "# parent body" },
      { rootDir: root }
    );
    pushPlan(
      {
        title: "child plan",
        content_md: "# child body",
        linked_artifacts: [
          { plan_slug: "parent-plan", relation: "improves", note: "drives this" }
        ]
      },
      { rootDir: root }
    );
    pushArtifact(
      {
        plan_slug: "child-plan",
        slug: "cycle",
        kind: "prompt-cycle",
        title: "the cycle",
        content: validCycle({
          rewritten_prompt: "<prompt><done>Done = ship it</done></prompt>",
          source_plan_slug: "parent-plan"
        })
      },
      { rootDir: root }
    );

    var bundle = buildHandoffBundle("child-plan", { rootDir: root, follow_links: true });
    expect(bundle.slug).toBe("child-plan");
    expect(bundle.markdown).toMatch(/# Handoff: child plan/);
    expect(bundle.markdown).toMatch(/# child body/);
    expect(bundle.markdown).toMatch(/## Linked plans/);
    expect(bundle.markdown).toMatch(/improves →/);
    expect(bundle.markdown).toMatch(/## Linked plan: parent plan/);
    expect(bundle.markdown).toMatch(/# parent body/);
    expect(bundle.markdown).toMatch(/READY-TO-PASTE PROMPT/);
    expect(bundle.markdown).toMatch(/Done = ship it/);
    expect(bundle.ready_to_paste_prompt).toMatch(/Done = ship it/);
  });

  it("skips linked-plan expansion when follow_links is false", function () {
    var root = mkTmp();
    pushPlan({ title: "parent plan", content_md: "P" }, { rootDir: root });
    pushPlan(
      {
        title: "child plan",
        content_md: "C",
        linked_artifacts: [{ plan_slug: "parent-plan", relation: "improves" }]
      },
      { rootDir: root }
    );
    var bundle = buildHandoffBundle("child-plan", { rootDir: root });
    expect(bundle.markdown).toMatch(/## Linked plans/);
    expect(bundle.markdown).not.toMatch(/## Linked plan: parent plan/);
  });

  it("omits the hoist when no prompt-cycle artifact is present", function () {
    var root = mkTmp();
    pushPlan({ title: "no cycle here", content_md: "X" }, { rootDir: root });
    pushArtifact(
      { plan_slug: "no-cycle-here", kind: "markdown", title: "doc", content: "hello" },
      { rootDir: root }
    );
    var bundle = buildHandoffBundle("no-cycle-here", { rootDir: root });
    expect(bundle.ready_to_paste_prompt).toBeNull();
    expect(bundle.markdown).not.toMatch(/READY-TO-PASTE PROMPT/);
  });

  it("throws when the plan is missing", function () {
    var root = mkTmp();
    expect(function () {
      buildHandoffBundle("ghost", { rootDir: root });
    }).toThrow(/plan not found/);
  });
});

describe("atomic writes", function () {
  it("survives many concurrent writes without producing torn files", async function () {
    var root = mkTmp();
    pushPlan({ title: "race", content_md: "0" }, { rootDir: root });
    var jobs: Promise<void>[] = [];
    for (var i = 0; i < 25; i++) {
      var body = "iteration " + i;
      jobs.push(
        new Promise<void>(function (resolve) {
          setImmediate(function () {
            pushPlan({ title: "race", content_md: body }, { rootDir: root });
            resolve();
          });
        })
      );
    }
    await Promise.all(jobs);
    var got = getPlan("race", { rootDir: root });
    expect(got).not.toBeNull();
    expect(got && got.plan.content_md.indexOf("iteration ")).toBe(0);
  });
});
