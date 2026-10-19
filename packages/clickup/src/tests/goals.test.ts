// --- Mock setup (must be before imports) ---

var mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

jest.mock("axios", function () {
  return {
    create: jest.fn(function () {
      return mockAxiosInstance;
    }),
    isAxiosError: jest.fn(function (error: { isAxiosError?: boolean } | undefined) {
      return !!error && error.isAxiosError === true;
    }),
  };
});

// --- Imports (after mocks) ---

import { AxiosInstance } from "axios";
import {
  createClickUpApi,
  getGoals,
  getGoal,
  createGoal,
  updateGoal,
  deleteGoal,
  createKeyResult,
  editKeyResult,
  deleteKeyResult,
} from "../client";

// --- Helpers ---

var client = mockAxiosInstance as unknown as AxiosInstance;

function makeAxiosError(status: number, data?: Record<string, unknown>) {
  return {
    isAxiosError: true,
    response: { status: status, data: data || {} },
  };
}

var GOAL = { id: "g-1", name: "DORA quality", key_results: [] };
var KR = { id: "kr-1", goal_id: "g-1", name: "Lead time", steps_current: 3 };

beforeEach(function () {
  jest.clearAllMocks();
});

// --- Tests ---

describe("getGoals", function () {
  it("GETs the team goal list and unwraps goals", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: { goals: [GOAL], folders: [] } });

    var result = await getGoals({ client: client, teamId: "9017" });

    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/team/9017/goal", { params: {} });
    expect(result).toEqual([GOAL]);
  });

  it("passes include_completed when asked", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: { goals: [] } });

    await getGoals({ client: client, teamId: "9017", includeCompleted: true });

    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/team/9017/goal", {
      params: { include_completed: true },
    });
  });

  it("throws when the envelope is missing", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: {} });

    await expect(getGoals({ client: client, teamId: "9017" })).rejects.toThrow(
      "response missing 'goals'"
    );
  });
});

describe("getGoal", function () {
  it("GETs one goal (URL-encoded id) and unwraps goal", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: { goal: GOAL } });

    var result = await getGoal({ client: client, goalId: "g 1/x" });

    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/goal/g%201%2Fx");
    expect(result).toEqual(GOAL);
  });

  it("throws on 404 with goal context", async function () {
    mockAxiosInstance.get.mockRejectedValue(makeAxiosError(404));

    await expect(getGoal({ client: client, goalId: "nope" })).rejects.toThrow(
      "ClickUp goal 'nope' not found"
    );
  });
});

describe("createGoal", function () {
  it("POSTs the goal body with derived multiple_owners", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: { goal: GOAL } });

    var result = await createGoal({
      client: client,
      teamId: "9017",
      name: "DORA quality",
      dueDate: 1798675200000,
      owners: [1, 2],
      color: "#32a852",
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v2/team/9017/goal", {
      name: "DORA quality",
      due_date: 1798675200000,
      description: "",
      multiple_owners: true,
      owners: [1, 2],
      color: "#32a852",
    });
    expect(result).toEqual(GOAL);
  });

  it("defaults owners to [] and omits color", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: { goal: GOAL } });

    await createGoal({ client: client, teamId: "9017", name: "TTV", dueDate: 1 });

    expect(mockAxiosInstance.post.mock.calls[0][1]).toEqual({
      name: "TTV",
      due_date: 1,
      description: "",
      multiple_owners: false,
      owners: [],
    });
  });

  it("surfaces the ClickUp err message", async function () {
    mockAxiosInstance.post.mockRejectedValue(makeAxiosError(400, { err: "Goal limit reached" }));

    await expect(
      createGoal({ client: client, teamId: "9017", name: "x", dueDate: 1 })
    ).rejects.toThrow("Goal limit reached");
  });
});

describe("updateGoal", function () {
  it("PUTs only the defined fields", async function () {
    mockAxiosInstance.put.mockResolvedValue({ data: { goal: GOAL } });

    await updateGoal({ client: client, goalId: "g-1", name: "Renamed", addOwners: [3] });

    expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v2/goal/g-1", {
      name: "Renamed",
      add_owners: [3],
    });
  });
});

describe("deleteGoal", function () {
  it("DELETEs the goal", async function () {
    mockAxiosInstance.delete.mockResolvedValue({ data: {} });

    await deleteGoal({ client: client, goalId: "g-1" });

    expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v2/goal/g-1");
  });
});

describe("createKeyResult", function () {
  it("POSTs the key result with snake_case steps and defaults", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: { key_result: KR } });

    var result = await createKeyResult({
      client: client,
      goalId: "g-1",
      name: "Lead time",
      type: "number",
      stepsStart: 20,
      stepsEnd: 10,
      unit: "days",
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v2/goal/g-1/key_result", {
      name: "Lead time",
      owners: [],
      type: "number",
      steps_start: 20,
      steps_end: 10,
      unit: "days",
      task_ids: [],
      list_ids: [],
    });
    expect(result).toEqual(KR);
  });

  it("passes task and list ids for automatic key results", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: { key_result: KR } });

    await createKeyResult({
      client: client,
      goalId: "g-1",
      name: "Certs",
      type: "automatic",
      stepsStart: 0,
      stepsEnd: 4,
      listIds: ["l1"],
    });

    var body = mockAxiosInstance.post.mock.calls[0][1];
    expect(body.type).toBe("automatic");
    expect(body.list_ids).toEqual(["l1"]);
  });
});

describe("editKeyResult", function () {
  it("PUTs steps_current and note, unwraps key_result", async function () {
    mockAxiosInstance.put.mockResolvedValue({ data: { key_result: KR } });

    var result = await editKeyResult({
      client: client,
      keyResultId: "kr-1",
      stepsCurrent: 3,
      note: "2026-W42 — https://example.com/evidence",
    });

    expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v2/key_result/kr-1", {
      steps_current: 3,
      note: "2026-W42 — https://example.com/evidence",
    });
    expect(result).toEqual(KR);
  });

  it("throws on 404 with key result context", async function () {
    mockAxiosInstance.put.mockRejectedValue(makeAxiosError(404));

    await expect(
      editKeyResult({ client: client, keyResultId: "kr-x", stepsCurrent: 1, note: "n" })
    ).rejects.toThrow("not found");
  });
});

describe("deleteKeyResult", function () {
  it("DELETEs the key result", async function () {
    mockAxiosInstance.delete.mockResolvedValue({ data: {} });

    await deleteKeyResult({ client: client, keyResultId: "kr-1" });

    expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v2/key_result/kr-1");
  });
});

describe("createClickUpApi goals surface", function () {
  it("exposes every goal method", function () {
    var api = createClickUpApi({ token: "test" });
    [
      "getGoals",
      "getGoal",
      "createGoal",
      "updateGoal",
      "deleteGoal",
      "createKeyResult",
      "editKeyResult",
      "deleteKeyResult",
    ].forEach(function (name) {
      expect(typeof (api as unknown as Record<string, unknown>)[name]).toBe("function");
    });
  });

  it("delegates editKeyResult with the bound client", async function () {
    mockAxiosInstance.put.mockResolvedValue({ data: { key_result: KR } });
    var api = createClickUpApi({ token: "test" });

    await api.editKeyResult({ keyResultId: "kr-1", stepsCurrent: 5, note: "n" });

    expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v2/key_result/kr-1", {
      steps_current: 5,
      note: "n",
    });
  });
});
