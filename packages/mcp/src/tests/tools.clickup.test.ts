var mockListMyTasks = jest.fn();
var mockListTeamTasks = jest.fn();
var mockGetTask = jest.fn();

jest.mock("@tenonhq/dovetail-clickup", function () {
  return {
    createClient: jest.fn(function () { return {} as any; }),
    listMyTasks: mockListMyTasks,
    listTeamTasks: mockListTeamTasks,
    getTask: mockGetTask
  };
});

import {
  clickupListTasks,
  clickupGetTask,
  clickupSearchTasks,
  clickupGetTeamSync
} from "../tools/clickup";

function makeDeps(extra: { defaultTeamId?: string } = {}) {
  return {
    config: { token: "pk_t", defaultTeamId: extra.defaultTeamId },
    clientFactory: function () { return {} as any; }
  };
}

describe("clickup tools", function () {
  beforeEach(function () {
    mockListMyTasks.mockReset();
    mockListTeamTasks.mockReset();
    mockGetTask.mockReset();
  });

  it("clickup_list_tasks calls listMyTasks with the resolved teamId", async function () {
    mockListMyTasks.mockResolvedValue({ tasks: [], byStatus: {}, total: 0 });
    await clickupListTasks(
      { teamId: "abc", statuses: ["open"] } as any,
      makeDeps()
    );
    var call = mockListMyTasks.mock.calls[0][0];
    expect(call.teamId).toBe("abc");
    expect(call.statuses).toEqual(["open"]);
  });

  it("clickup_list_tasks falls back to defaultTeamId when arg omitted", async function () {
    mockListMyTasks.mockResolvedValue({ tasks: [], byStatus: {}, total: 0 });
    await clickupListTasks({} as any, makeDeps({ defaultTeamId: "fallback" }));
    expect(mockListMyTasks.mock.calls[0][0].teamId).toBe("fallback");
  });

  it("clickup_list_tasks throws an actionable error when no teamId is resolvable", async function () {
    await expect(clickupListTasks({} as any, makeDeps())).rejects.toThrow(/teamId is required/);
  });

  it("clickup_get_task forwards taskId verbatim", async function () {
    mockGetTask.mockResolvedValue({ id: "T1" });
    var out = await clickupGetTask({ taskId: "T1" } as any, makeDeps());
    expect(out).toEqual({ id: "T1" });
    expect(mockGetTask.mock.calls[0][0].taskId).toBe("T1");
  });

  it("clickup_search_tasks filters team tasks by substring on name and description", async function () {
    mockListTeamTasks.mockResolvedValue({
      tasks: [
        { id: "1", name: "fix billing bug", description: "" },
        { id: "2", name: "Refactor", description: "Replace billing helper" },
        { id: "3", name: "unrelated", description: "" }
      ],
      byStatus: {},
      byAssignee: {},
      unassigned: [],
      total: 3
    });
    var out = await clickupSearchTasks(
      { query: "billing", teamId: "T" } as any,
      makeDeps()
    );
    var ids = out.tasks.map(function (t: any) { return t.id; });
    expect(ids).toEqual(["1", "2"]);
    expect(out.total).toBe(2);
    expect(out.query).toBe("billing");
  });

  it("clickup_get_team_sync builds JSON pipeline from listTeamTasks output", async function () {
    mockListTeamTasks.mockResolvedValue({
      tasks: [
        { id: "1", name: "A", status: { status: "in progress" }, list: { name: "L1" }, assignees: [{ username: "u1" }], date_updated: "10" },
        { id: "2", name: "B", status: { status: "blocked" }, list: { name: "L1" }, assignees: [], date_updated: "5" },
        { id: "3", name: "C", status: { status: "weird-stage" }, list: { name: "L2" }, assignees: [{ username: "u2" }], date_updated: "1" }
      ],
      byStatus: {},
      byAssignee: {},
      unassigned: [],
      total: 3
    });
    var out = await clickupGetTeamSync(
      { teamId: "T" } as any,
      makeDeps()
    );
    var blocked = out.stages.filter(function (s) { return s.stage === "Blocked"; })[0];
    var inProgress = out.stages.filter(function (s) { return s.stage === "In Progress"; })[0];
    expect(blocked.count).toBe(1);
    expect(blocked.tasks[0].id).toBe("2");
    expect(inProgress.count).toBe(1);
    expect(inProgress.tasks[0].id).toBe("1");
    expect(out.unmappedStatuses["weird-stage"]).toBe(1);
    expect(out.totalLists).toBe(2);
    expect(typeof out.syncTime).toBe("string");
  });
});
