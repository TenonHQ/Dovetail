/**
 * ClickUp Goals + Key Results tools: the two reads, and the gate / dry-run /
 * validation / execute paths of the four gated writes.
 * Uses an injected clientFactory so no real HTTP happens.
 */

import type { AxiosInstance } from "axios";
import { clickupGetGoals, clickupGetGoal } from "../tools/clickup";
import type { ClickUpDeps } from "../tools/clickup";
import {
  clickupCreateGoal,
  clickupUpdateGoal,
  clickupCreateKeyResult,
  clickupEditKeyResult
} from "../tools/clickup-write";

var GOAL = { id: "g-1", name: "DORA quality", key_results: [] };
var KR = { id: "kr-1", goal_id: "g-1", name: "Lead time" };

function makeClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn()
  };
}

type MockClient = ReturnType<typeof makeClient>;

function makeDeps(writesEnabled: boolean, client: MockClient, defaultTeamId?: string): ClickUpDeps {
  return {
    config: { token: "pk", defaultTeamId: defaultTeamId },
    clientFactory: function () {
      return client as unknown as AxiosInstance;
    },
    writesEnabled: writesEnabled
  };
}

describe("clickup goal reads", function () {
  it("clickup_get_goals lists goals for the default team", async function () {
    var client = makeClient();
    client.get.mockResolvedValue({ data: { goals: [GOAL] } });

    var res = await clickupGetGoals({}, makeDeps(false, client, "9017"));

    expect(client.get).toHaveBeenCalledWith("/api/v2/team/9017/goal", { params: {} });
    expect(res).toEqual({ goals: [GOAL], total: 1 });
  });

  it("clickup_get_goals requires a team when none is configured", async function () {
    await expect(clickupGetGoals({}, makeDeps(false, makeClient()))).rejects.toThrow(
      "teamId is required"
    );
  });

  it("clickup_get_goal returns the goal with key results", async function () {
    var client = makeClient();
    client.get.mockResolvedValue({ data: { goal: GOAL } });

    var res = await clickupGetGoal({ goalId: "g-1" }, makeDeps(false, client));

    expect(client.get).toHaveBeenCalledWith("/api/v2/goal/g-1");
    expect(res).toEqual(GOAL);
  });
});

describe("clickup goal write gate", function () {
  it("refuses every goal write when writesEnabled is false", async function () {
    var deps = makeDeps(false, makeClient(), "9017");
    await expect(
      clickupCreateGoal({ name: "n", dueDate: "2026-12-31", confirm: true }, deps)
    ).rejects.toThrow("writes are disabled");
    await expect(
      clickupUpdateGoal({ goalId: "g-1", name: "n", confirm: true }, deps)
    ).rejects.toThrow("writes are disabled");
    await expect(
      clickupCreateKeyResult(
        { goalId: "g-1", name: "n", type: "number", stepsStart: 0, stepsEnd: 5, confirm: true },
        deps
      )
    ).rejects.toThrow("writes are disabled");
    await expect(
      clickupEditKeyResult({ keyResultId: "kr-1", stepsCurrent: 1, note: "n", confirm: true }, deps)
    ).rejects.toThrow("writes are disabled");
  });
});

describe("clickup goal write dry-run (no confirm)", function () {
  it("previews every goal write and performs no HTTP", async function () {
    var client = makeClient();
    var deps = makeDeps(true, client, "9017");

    var created = await clickupCreateGoal({ name: "DORA quality", dueDate: "2026-12-31" }, deps);
    var updated = await clickupUpdateGoal({ goalId: "g-1", color: "#32a852" }, deps);
    var kr = await clickupCreateKeyResult(
      { goalId: "g-1", name: "Lead time", type: "number", stepsStart: 20, stepsEnd: 10, unit: "days" },
      deps
    );
    var edited = await clickupEditKeyResult(
      { keyResultId: "kr-1", stepsCurrent: 14, note: "2026-W42 https://example.com/e" },
      deps
    );

    expect(created).toMatchObject({ dryRun: true, action: "create_goal", teamId: "9017" });
    expect(updated).toMatchObject({ dryRun: true, action: "update_goal", goalId: "g-1" });
    expect(kr).toMatchObject({ dryRun: true, action: "create_key_result" });
    expect(edited).toMatchObject({
      dryRun: true,
      action: "edit_key_result",
      stepsCurrent: 14,
      progressNote: "2026-W42 https://example.com/e"
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
  });
});

describe("clickup goal write validation", function () {
  var deps = makeDeps(true, makeClient(), "9017");

  it("rejects an impossible due date", async function () {
    await expect(clickupCreateGoal({ name: "n", dueDate: "2026-13-45" }, deps)).rejects.toThrow(
      "not a real calendar date"
    );
  });

  it("rejects a day that would roll over into the next month", async function () {
    await expect(clickupCreateGoal({ name: "n", dueDate: "2026-02-30" }, deps)).rejects.toThrow(
      "not a real calendar date"
    );
    await expect(
      clickupUpdateGoal({ goalId: "g-1", dueDate: "2026-02-29" }, deps)
    ).rejects.toThrow("not a real calendar date");
  });

  it("accepts a leap day", async function () {
    var res = await clickupCreateGoal({ name: "n", dueDate: "2028-02-29" }, deps);
    expect(res).toMatchObject({ dryRun: true, fields: { dueDate: "2028-02-29" } });
  });

  it("rejects a key result with no range", async function () {
    await expect(
      clickupCreateKeyResult({ goalId: "g-1", name: "n", type: "number", stepsStart: 5, stepsEnd: 5 }, deps)
    ).rejects.toThrow("must differ");
  });

  it("rejects an automatic key result with no tasks or lists", async function () {
    await expect(
      clickupCreateKeyResult(
        { goalId: "g-1", name: "n", type: "automatic", stepsStart: 0, stepsEnd: 4, listIds: [] },
        deps
      )
    ).rejects.toThrow("taskIds or listIds");
  });

  it("forces boolean key results to 0 → 1", async function () {
    var res = await clickupCreateKeyResult(
      { goalId: "g-1", name: "Shipped", type: "boolean", stepsStart: 3, stepsEnd: 3 },
      deps
    );
    expect(res).toMatchObject({ fields: { stepsStart: 0, stepsEnd: 1 } });
  });

  it("rejects a blank note", async function () {
    await expect(
      clickupEditKeyResult({ keyResultId: "kr-1", stepsCurrent: 1, note: "   " }, deps)
    ).rejects.toThrow("note is required");
  });
});

describe("clickup goal write execute (confirm:true)", function () {
  it("creates a goal with the due date as end-of-day epoch ms", async function () {
    var client = makeClient();
    client.post.mockResolvedValue({ data: { goal: GOAL } });

    var res = await clickupCreateGoal(
      { name: "DORA quality", dueDate: "2026-12-31", owners: [7], confirm: true },
      makeDeps(true, client, "9017")
    );

    expect(client.post).toHaveBeenCalledWith("/api/v2/team/9017/goal", {
      name: "DORA quality",
      due_date: Date.parse("2026-12-31T23:59:59Z"),
      description: "",
      multiple_owners: false,
      owners: [7]
    });
    expect(res).toEqual(GOAL);
  });

  it("updates a goal", async function () {
    var client = makeClient();
    client.put.mockResolvedValue({ data: { goal: GOAL } });

    await clickupUpdateGoal(
      { goalId: "g-1", remOwners: [7], confirm: true },
      makeDeps(true, client)
    );

    expect(client.put).toHaveBeenCalledWith("/api/v2/goal/g-1", { rem_owners: [7] });
  });

  it("creates a percentage key result", async function () {
    var client = makeClient();
    client.post.mockResolvedValue({ data: { key_result: KR } });

    await clickupCreateKeyResult(
      { goalId: "g-1", name: "Coverage", type: "percentage", stepsStart: 0, stepsEnd: 100, confirm: true },
      makeDeps(true, client)
    );

    expect(client.post).toHaveBeenCalledWith("/api/v2/goal/g-1/key_result", {
      name: "Coverage",
      owners: [],
      type: "percentage",
      steps_start: 0,
      steps_end: 100,
      unit: "",
      task_ids: [],
      list_ids: []
    });
  });

  it("edits a key result with the trimmed note", async function () {
    var client = makeClient();
    client.put.mockResolvedValue({ data: { key_result: KR } });

    var res = await clickupEditKeyResult(
      { keyResultId: "kr-1", stepsCurrent: 14, note: "  2026-W42 https://example.com/e  ", confirm: true },
      makeDeps(true, client)
    );

    expect(client.put).toHaveBeenCalledWith("/api/v2/key_result/kr-1", {
      steps_current: 14,
      note: "2026-W42 https://example.com/e"
    });
    expect(res).toEqual(KR);
  });
});
