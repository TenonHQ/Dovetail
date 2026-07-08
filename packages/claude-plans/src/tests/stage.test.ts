/**
 * Integration tests for setStage + loadPlanFull (Phase C). State-machine
 * unit-level coverage lives in state-machine.test.ts; this file exercises
 * the storage layer that wires the helpers together.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { pushPlan, setStage, loadPlanFull, pushQuestion } from "../storage";
import {
  IllegalTransitionError,
  ConflictRejectedError,
} from "../state-machine";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-plans-stage-"));
}

function rawPlan(root: string, slug: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, slug + ".json"), "utf8"));
}

describe("setStage — happy path", function () {
  it("moves a fresh plan to a legal start stage and issues a token", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    var res = setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
    expect(res.stage).toBe("research");
    expect(res.history_length).toBe(1);
    expect(res.token.token).toMatch(/^tok_[0-9a-f]{24}$/);
    expect(res.token.issued_for_stage).toBe("research");
    expect(Date.parse(res.token.expires_at)).toBeGreaterThan(
      Date.parse(res.token.issued_at),
    );

    var disk = rawPlan(root, "t");
    expect(disk.stage).toBe("research");
    expect(disk.stage_history).toHaveLength(1);
    expect(disk.stage_history[0]).toMatchObject({
      from: null,
      to: "research",
      source: "code",
    });
    expect(disk.dispatch_token.token).toBe(res.token.token);
    expect(disk.schema_version).toBe(2);
  });

  it("rotates the token on every transition", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    var t1 = setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
    var t2 = setStage({ plan_slug: "t", to: "planning" }, { rootDir: root });
    expect(t2.token.token).not.toBe(t1.token.token);
    expect(t2.token.issued_for_stage).toBe("planning");
    expect(t2.history_length).toBe(2);

    var disk = rawPlan(root, "t");
    expect(disk.dispatch_token.token).toBe(t2.token.token);
  });

  it("honors DOVE_CLAUDE_PLANS_TOKEN_TTL_MS override", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    var prev = process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS;
    process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS = "1000"; // 1s
    try {
      var res = setStage({ plan_slug: "t", to: "research" }, { rootDir: root });
      var dt =
        Date.parse(res.token.expires_at) - Date.parse(res.token.issued_at);
      expect(dt).toBe(1000);
    } finally {
      if (prev === undefined) delete process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS;
      else process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS = prev;
    }
  });
});

describe("setStage — illegal transitions", function () {
  it("rejects a skip-forward jump with IllegalTransitionError", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    expect(function () {
      setStage({ plan_slug: "t", to: "test-first" }, { rootDir: root });
    }).toThrow(IllegalTransitionError);
  });

  it("rejects code-sourced writes within the dashboard grace window", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    setStage(
      { plan_slug: "t", to: "research", source: "dashboard" },
      { rootDir: root },
    );
    // Try to follow up with a code-sourced move within 30s — rejected.
    expect(function () {
      setStage(
        { plan_slug: "t", to: "planning", source: "code" },
        { rootDir: root },
      );
    }).toThrow(ConflictRejectedError);
  });

  it("does not write to disk when the transition is rejected", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    var beforeStr = fs.readFileSync(path.join(root, "t.json"), "utf8");
    try {
      setStage({ plan_slug: "t", to: "test-first" }, { rootDir: root });
    } catch (e) {
      // expected
    }
    var afterStr = fs.readFileSync(path.join(root, "t.json"), "utf8");
    expect(afterStr).toBe(beforeStr);
  });
});

describe("setStage — preservation across pushPlan", function () {
  it("pushPlan on a staged plan preserves stage / history / token", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "v1" }, { rootDir: root });
    var staged = setStage(
      { plan_slug: "t", to: "research" },
      { rootDir: root },
    );
    // Updating content via pushPlan must NOT wipe stage state.
    pushPlan({ title: "T", content_md: "v2" }, { rootDir: root });
    var disk = rawPlan(root, "t");
    expect(disk.stage).toBe("research");
    expect(disk.stage_history).toHaveLength(1);
    expect(disk.dispatch_token.token).toBe(staged.token.token);
    expect(disk.content_md).toBe("v2");
  });
});

describe("loadPlanFull — single-read snapshot", function () {
  it("returns plan + artifacts + prompts + questions + stage state", function () {
    var root = mkTmp();
    pushPlan({ title: "T", content_md: "x" }, { rootDir: root });
    pushQuestion(
      { plan_slug: "t", question: "?", stage: "research" },
      { rootDir: root },
    );
    setStage({ plan_slug: "t", to: "research" }, { rootDir: root });

    var full = loadPlanFull("t", { rootDir: root });
    expect(full).not.toBeNull();
    if (!full) return; // type-narrow
    expect(full.plan.slug).toBe("t");
    expect(full.questions).toHaveLength(1);
    expect(full.stage).toBe("research");
    expect(full.stage_history).toHaveLength(1);
    expect(full.dispatch_log).toEqual([]);
    expect(full.artifacts).toEqual([]);
    expect(full.prompts).toEqual([]);
  });

  it("returns null when the plan doesn't exist", function () {
    var root = mkTmp();
    expect(loadPlanFull("no-such-plan", { rootDir: root })).toBeNull();
  });

  it("returns sensible defaults for a v1 record (stage:null, empty history)", function () {
    var root = mkTmp();
    var slug = "legacy";
    fs.writeFileSync(
      path.join(root, slug + ".json"),
      JSON.stringify({
        slug: slug,
        title: "Legacy",
        status: "DRAFT",
        content_md: "x",
        content_hash: "0".repeat(64),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        session_id: null,
      }),
    );
    var full = loadPlanFull(slug, { rootDir: root });
    expect(full).not.toBeNull();
    if (!full) return;
    expect(full.stage).toBeNull();
    expect(full.stage_history).toEqual([]);
    expect(full.dispatch_log).toEqual([]);
    expect(full.plan.schema_version).toBe(2); // migrateV1OnLoad applied
  });
});
