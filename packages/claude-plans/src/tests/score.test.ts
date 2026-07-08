import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { listArtifacts, pushArtifact, pushPlan, getPlan } from "../storage";
import { scorePlanFeatures } from "../score";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-score-"));
}

describe("scorePlanFeatures", function () {
  it("scores a thin markdown-only plan below 1 and lists what is missing", function () {
    var root = mkTmp();
    var plan = pushPlan(
      { slug: "thin", title: "Thin", content_md: "short", categories: [] },
      { rootDir: root },
    );
    var s = scorePlanFeatures({ plan: plan, artifacts: [] });
    expect(s.score).toBeLessThan(1);
    expect(s.missing).toEqual(
      expect.arrayContaining([expect.stringContaining("diagram")]),
    );
    expect(s.hint).toContain("add");
  });

  it("awards full marks when every display feature is used", function () {
    var root = mkTmp();
    pushPlan(
      {
        slug: "rich",
        title: "Rich",
        content_structured: { sections: [{ type: "header", title: "Rich" }] },
        content_md: "x".repeat(500),
        pr_url: "https://example.com/pr/1",
        linked_artifacts: [{ plan_slug: "other", relation: "see-also" }],
        categories: ["servicenow"],
      },
      { rootDir: root },
    );
    pushArtifact(
      { plan_slug: "rich", kind: "markdown", title: "Doc", content: "notes" },
      { rootDir: root },
    );
    pushArtifact(
      {
        plan_slug: "rich",
        kind: "mermaid",
        title: "Flow",
        content: "graph TD; a-->b",
      },
      { rootDir: root },
    );

    var full = getPlan("rich", { rootDir: root });
    var s = scorePlanFeatures({
      plan: full!.plan,
      artifacts: listArtifacts("rich", { rootDir: root }),
    });
    expect(s.score).toBe(1);
    expect(s.missing).toEqual([]);
  });
});
