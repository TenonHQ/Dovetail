import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  deletePlan,
  getPlan,
  listArtifacts,
  listPlans,
  pushArtifact,
  pushPlan,
  slugify,
  updatePlanStatus
} from "../storage";

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
