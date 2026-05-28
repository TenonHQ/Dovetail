import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  pushLintEvent,
  listLintEvents,
  getLintEvents
} from "../storage";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-lint-"));
}

describe("prompt lint events", function () {
  it("pushes a global event with score and missing tags", function () {
    var root = mkTmp();
    var e = pushLintEvent(
      {
        score: 40,
        missing: ["<done>", "<output>"],
        antipatterns: ["vague verb"],
        threshold: 50,
        prompt_excerpt: "clean this up please",
        source: "hook"
      },
      { rootDir: root }
    );
    expect(e.id).toMatch(/^le_[0-9a-f]{8}$/);
    expect(e.score).toBe(40);
    expect(e.missing).toEqual(["<done>", "<output>"]);
    expect(e.threshold).toBe(50);
    expect(e.source).toBe("hook");
  });

  it("requires no plan — events live in the global _lint-events dir", function () {
    var root = mkTmp();
    var e = pushLintEvent({ score: 10, missing: [] }, { rootDir: root });
    var p = path.join(root, "_lint-events", e.id + ".json");
    expect(fs.existsSync(p)).toBe(true);
    var stored = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(stored.score).toBe(10);
    expect(stored.plan_slug).toBeUndefined();
  });

  it("lists events newest first", async function () {
    var root = mkTmp();
    var first = pushLintEvent({ score: 10, missing: [] }, { rootDir: root });
    await new Promise(function (r) { setTimeout(r, 5); });
    var second = pushLintEvent({ score: 20, missing: [] }, { rootDir: root });
    var events = listLintEvents({}, { rootDir: root });
    expect(events.length).toBe(2);
    expect(events[0].id).toBe(second.id);
    expect(events[1].id).toBe(first.id);
  });

  it("returns an empty list when no events exist", function () {
    var root = mkTmp();
    expect(listLintEvents({}, { rootDir: root })).toEqual([]);
    expect(getLintEvents({}, { rootDir: root }).events).toEqual([]);
  });

  it("filters by session_id and plan_slug", function () {
    var root = mkTmp();
    pushLintEvent({ score: 10, missing: [], session_id: "s1" }, { rootDir: root });
    pushLintEvent({ score: 20, missing: [], session_id: "s2" }, { rootDir: root });
    pushLintEvent({ score: 30, missing: [], plan_slug: "my-plan" }, { rootDir: root });
    expect(listLintEvents({ session_id: "s1" }, { rootDir: root }).length).toBe(1);
    expect(listLintEvents({ session_id: "s2" }, { rootDir: root }).length).toBe(1);
    expect(listLintEvents({ plan_slug: "my-plan" }, { rootDir: root }).length).toBe(1);
  });

  it("honors limit", function () {
    var root = mkTmp();
    for (var i = 0; i < 5; i++) {
      pushLintEvent({ score: i * 10, missing: [] }, { rootDir: root });
    }
    expect(getLintEvents({ limit: 3 }, { rootDir: root }).events.length).toBe(3);
  });
});
