import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  getPlan,
  getVersion,
  listVersions,
  pushPlan,
  restoreVersion,
  MAX_PLAN_VERSIONS
} from "../storage";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-versions-"));
}

describe("plan version history", function () {
  it("snapshots the prior record only when content changes", function () {
    var root = mkTmp();
    pushPlan({ slug: "p", title: "P", content_md: "one" }, { rootDir: root });
    // Identical re-push — no snapshot.
    pushPlan({ slug: "p", title: "P", content_md: "one" }, { rootDir: root });
    expect(listVersions("p", { rootDir: root }).length).toBe(0);

    // Content change — snapshots the prior ("one") as v1.
    pushPlan({ slug: "p", title: "P", content_md: "two" }, { rootDir: root });
    var versions = listVersions("p", { rootDir: root });
    expect(versions.length).toBe(1);
    expect(versions[0].version).toBe(1);

    var v1 = getVersion("p", 1, { rootDir: root });
    expect(v1&& v1.plan.content_md).toBe("one");
  });

  it("restore re-pushes a prior version as the new current, non-destructively", function () {
    var root = mkTmp();
    pushPlan({ slug: "p", title: "P", content_md: "v-a" }, { rootDir: root });
    pushPlan({ slug: "p", title: "P", content_md: "v-b" }, { rootDir: root }); // snapshots v-a as v1
    pushPlan({ slug: "p", title: "P", content_md: "v-c" }, { rootDir: root }); // snapshots v-b as v2

    var restored = restoreVersion("p", 1, { rootDir: root }); // restore v-a
    expect(restored.content_md).toBe("v-a");

    // Current is now v-a; the pre-restore current (v-c) was snapshotted too.
    var current = getPlan("p", { rootDir: root });
    expect(current && current.plan.content_md).toBe("v-a");
    var contents = listVersions("p", { rootDir: root })
      .map(function (m) { return getVersion("p", m.version, { rootDir: root }); })
      .map(function (v) { return v && v.plan.content_md; });
    expect(contents).toContain("v-c"); // nothing lost
  });

  it("caps history at MAX_PLAN_VERSIONS, pruning oldest", function () {
    var root = mkTmp();
    for (var i = 0; i < MAX_PLAN_VERSIONS + 5; i++) {
      pushPlan({ slug: "p", title: "P", content_md: "body-" + i }, { rootDir: root });
    }
    var versions = listVersions("p", { rootDir: root });
    expect(versions.length).toBe(MAX_PLAN_VERSIONS);
    // Newest-first; oldest snapshots pruned.
    expect(versions[0].version).toBeGreaterThan(versions[versions.length - 1].version);
  });
});
