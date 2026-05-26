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
    isAxiosError: jest.fn(function (error: any) {
      return error && error.isAxiosError === true;
    }),
  };
});

// --- Imports (after mocks) ---

import axios from "axios";
import {
  createClient,
  createClickUpApi,
  getAuthorizedUser,
  getTask,
  listMyTasks,
  createTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  setCustomField,
  linkTask,
  normalizeChecklistMarkdown,
  addComment,
  getTeams,
  getSpaces,
  getFolders,
  getLists,
  getSpaceLists,
  getListTasks,
} from "../client";
import { makeClickUpTask, makeUser } from "./fixtures";

// --- Helpers ---

function makeAxiosError(status: number, data?: any): any {
  return {
    isAxiosError: true,
    response: {
      status: status,
      data: data || {},
    },
  };
}

// --- Tests ---

describe("createClient", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("creates axios instance with correct authorization header", function () {
    createClient({ token: "pk_test_token_123" });
    expect(axios.create).toHaveBeenCalledWith({
      baseURL: "https://api.clickup.com",
      headers: {
        "Authorization": "pk_test_token_123",
        "Content-Type": "application/json",
      },
    });
  });

  it("uses custom baseUrl when provided", function () {
    createClient({ token: "tk_123", baseUrl: "https://custom.api.com" });
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://custom.api.com",
      })
    );
  });

  it("defaults to ClickUp base URL when baseUrl omitted", function () {
    createClient({ token: "tk_123" });
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.clickup.com",
      })
    );
  });
});

describe("getAuthorizedUser", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("returns the user from response data", async function () {
    var mockUser = makeUser({ username: "daniel" });
    mockAxiosInstance.get.mockResolvedValue({ data: { user: mockUser } });

    var result = await getAuthorizedUser({ client: mockAxiosInstance as any });
    expect(result).toEqual(mockUser);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/user");
  });

  it("throws on 401 error", async function () {
    mockAxiosInstance.get.mockRejectedValue(makeAxiosError(401));

    await expect(
      getAuthorizedUser({ client: mockAxiosInstance as any })
    ).rejects.toThrow("authentication failed");
  });
});

describe("getTask", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("fetches task by ID and returns data", async function () {
    var mockTask = makeClickUpTask({ id: "abc123" });
    mockAxiosInstance.get.mockResolvedValue({ data: mockTask });

    var result = await getTask({ client: mockAxiosInstance as any, taskId: "abc123" });
    expect(result).toEqual(mockTask);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/task/abc123", {});
  });

  it("throws on 404 with task context", async function () {
    mockAxiosInstance.get.mockRejectedValue(makeAxiosError(404));

    await expect(
      getTask({ client: mockAxiosInstance as any, taskId: "missing123" })
    ).rejects.toThrow("not found");
  });

  it("throws on 429 rate limit", async function () {
    mockAxiosInstance.get.mockRejectedValue(makeAxiosError(429));

    await expect(
      getTask({ client: mockAxiosInstance as any, taskId: "abc" })
    ).rejects.toThrow("rate limit exceeded");
  });

  it("includes error message from response data", async function () {
    mockAxiosInstance.get.mockRejectedValue(makeAxiosError(500, { err: "Internal server error" }));

    await expect(
      getTask({ client: mockAxiosInstance as any, taskId: "abc" })
    ).rejects.toThrow("Internal server error");
  });

  it("re-throws non-axios errors", async function () {
    var error = new Error("Network failure");
    mockAxiosInstance.get.mockRejectedValue(error);

    await expect(
      getTask({ client: mockAxiosInstance as any, taskId: "abc" })
    ).rejects.toThrow("Network failure");
  });
});

describe("listMyTasks", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("fetches user first, then queries team tasks", async function () {
    var mockUser = makeUser({ id: 42 });
    var tasks = [
      makeClickUpTask({ id: "t1", status: { status: "in progress", color: "#000", type: "open", orderindex: 1 } }),
      makeClickUpTask({ id: "t2", status: { status: "done", color: "#000", type: "closed", orderindex: 2 } }),
    ];

    // First call: getAuthorizedUser, Second call: team tasks
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { user: mockUser } })
      .mockResolvedValueOnce({ data: { tasks: tasks } });

    var result = await listMyTasks({
      client: mockAxiosInstance as any,
      teamId: "team1",
    });

    expect(result.total).toBe(2);
    expect(result.byStatus["in progress"]).toHaveLength(1);
    expect(result.byStatus["done"]).toHaveLength(1);
  });

  it("passes status filters to API", async function () {
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { user: makeUser() } })
      .mockResolvedValueOnce({ data: { tasks: [] } });

    await listMyTasks({
      client: mockAxiosInstance as any,
      teamId: "team1",
      statuses: ["in progress", "blocked"],
    });

    var callArgs = mockAxiosInstance.get.mock.calls[1];
    expect(callArgs[1].params["statuses[]"]).toEqual(["in progress", "blocked"]);
  });

  it("handles empty tasks array", async function () {
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { user: makeUser() } })
      .mockResolvedValueOnce({ data: { tasks: [] } });

    var result = await listMyTasks({
      client: mockAxiosInstance as any,
      teamId: "team1",
    });

    expect(result.total).toBe(0);
    expect(result.tasks).toEqual([]);
  });

  it("groups tasks with unknown status under 'unknown'", async function () {
    var task = makeClickUpTask({ status: { status: "", color: "", type: "", orderindex: 0 } });
    // Simulate missing status.status
    (task as any).status = null;

    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: { user: makeUser() } })
      .mockResolvedValueOnce({ data: { tasks: [task] } });

    var result = await listMyTasks({
      client: mockAxiosInstance as any,
      teamId: "team1",
    });

    expect(result.byStatus["unknown"]).toHaveLength(1);
  });
});

describe("createTask", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("creates task with minimal params (name only)", async function () {
    var mockTask = makeClickUpTask({ name: "New Task" });
    mockAxiosInstance.post.mockResolvedValue({ data: mockTask });

    var result = await createTask({
      client: mockAxiosInstance as any,
      listId: "list1",
      name: "New Task",
    });

    expect(result.name).toBe("New Task");
    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/v2/list/list1/task",
      { name: "New Task" }
    );
  });

  it("includes all optional fields when provided", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: makeClickUpTask() });

    await createTask({
      client: mockAxiosInstance as any,
      listId: "list1",
      name: "Full Task",
      description: "A description",
      assignees: [1, 2],
      status: "in progress",
      priority: 2,
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/v2/list/list1/task",
      {
        name: "Full Task",
        description: "A description",
        assignees: [1, 2],
        status: "in progress",
        priority: 2,
      }
    );
  });

  it("omits undefined optional fields from body", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: makeClickUpTask() });

    await createTask({
      client: mockAxiosInstance as any,
      listId: "list1",
      name: "Task",
    });

    var sentBody = mockAxiosInstance.post.mock.calls[0][1];
    expect(sentBody).not.toHaveProperty("description");
    expect(sentBody).not.toHaveProperty("assignees");
    expect(sentBody).not.toHaveProperty("status");
    expect(sentBody).not.toHaveProperty("priority");
  });
});

describe("updateTask", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("sends PUT with only changed fields", async function () {
    mockAxiosInstance.put.mockResolvedValue({ data: makeClickUpTask() });

    await updateTask({
      client: mockAxiosInstance as any,
      taskId: "t1",
      name: "Updated Name",
    });

    expect(mockAxiosInstance.put).toHaveBeenCalledWith(
      "/api/v2/task/t1",
      { name: "Updated Name" },
      {}
    );
    var sentBody = mockAxiosInstance.put.mock.calls[0][1];
    expect(sentBody).not.toHaveProperty("description");
    expect(sentBody).not.toHaveProperty("status");
  });
});

describe("updateTaskStatus", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("delegates to updateTask with status only", async function () {
    mockAxiosInstance.put.mockResolvedValue({ data: makeClickUpTask() });

    await updateTaskStatus({
      client: mockAxiosInstance as any,
      taskId: "t1",
      status: "done",
    });

    expect(mockAxiosInstance.put).toHaveBeenCalledWith(
      "/api/v2/task/t1",
      { status: "done" },
      {}
    );
  });
});

describe("deleteTask", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("calls DELETE with correct endpoint", async function () {
    mockAxiosInstance.delete.mockResolvedValue({});

    await deleteTask({ client: mockAxiosInstance as any, taskId: "t1" });
    expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v2/task/t1");
  });

  it("throws on error", async function () {
    mockAxiosInstance.delete.mockRejectedValue(makeAxiosError(404));

    await expect(
      deleteTask({ client: mockAxiosInstance as any, taskId: "t1" })
    ).rejects.toThrow("not found");
  });
});

describe("addComment", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("posts comment with correct body", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: { id: "c1", comment_text: "Hello" } });

    var result = await addComment({
      client: mockAxiosInstance as any,
      taskId: "t1",
      commentText: "Hello from Dovetail",
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/v2/task/t1/comment",
      { comment_text: "Hello from Dovetail" }
    );
  });
});

describe("getTeams", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("returns teams array", async function () {
    var teams = [{ id: "team1", name: "Tenon" }];
    mockAxiosInstance.get.mockResolvedValue({ data: { teams: teams } });

    var result = await getTeams({ client: mockAxiosInstance as any });
    expect(result).toEqual(teams);
  });

  it("returns empty array when teams is undefined", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: {} });

    var result = await getTeams({ client: mockAxiosInstance as any });
    expect(result).toEqual([]);
  });
});

describe("getSpaces", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("returns spaces for a team", async function () {
    var spaces = [{ id: "s1", name: "Engineering" }];
    mockAxiosInstance.get.mockResolvedValue({ data: { spaces: spaces } });

    var result = await getSpaces({ client: mockAxiosInstance as any, teamId: "team1" });
    expect(result).toEqual(spaces);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/team/team1/space");
  });
});

describe("getFolders", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("returns folders for a space", async function () {
    var folders = [{ id: "f1", name: "Sprint" }];
    mockAxiosInstance.get.mockResolvedValue({ data: { folders: folders } });

    var result = await getFolders({ client: mockAxiosInstance as any, spaceId: "s1" });
    expect(result).toEqual(folders);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/space/s1/folder");
  });
});

describe("getLists", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("returns lists for a folder", async function () {
    var lists = [{ id: "l1", name: "Backlog" }];
    mockAxiosInstance.get.mockResolvedValue({ data: { lists: lists } });

    var result = await getLists({ client: mockAxiosInstance as any, folderId: "f1" });
    expect(result).toEqual(lists);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/folder/f1/list");
  });
});

describe("getSpaceLists", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("returns folderless lists for a space", async function () {
    var lists = [{ id: "l1", name: "Quick Tasks" }];
    mockAxiosInstance.get.mockResolvedValue({ data: { lists: lists } });

    var result = await getSpaceLists({ client: mockAxiosInstance as any, spaceId: "s1" });
    expect(result).toEqual(lists);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/space/s1/list");
  });
});

describe("getListTasks", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("fetches tasks with default pagination", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: { tasks: [makeClickUpTask()] } });

    var result = await getListTasks({ client: mockAxiosInstance as any, listId: "l1" });
    expect(result).toHaveLength(1);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      "/api/v2/list/l1/task",
      expect.objectContaining({
        params: expect.objectContaining({
          page: 0,
          subtasks: true,
          include_closed: false,
        }),
      })
    );
  });

  it("passes page number when provided", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: { tasks: [] } });

    await getListTasks({ client: mockAxiosInstance as any, listId: "l1", page: 3 });
    var callParams = mockAxiosInstance.get.mock.calls[0][1].params;
    expect(callParams.page).toBe(3);
  });

  it("passes includeClosed flag", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: { tasks: [] } });

    await getListTasks({ client: mockAxiosInstance as any, listId: "l1", includeClosed: true });
    var callParams = mockAxiosInstance.get.mock.calls[0][1].params;
    expect(callParams.include_closed).toBe(true);
  });
});

describe("getTask (custom IDs)", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("passes custom_task_ids and team_id when customTaskIds is set", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: makeClickUpTask({ id: "x" }) });

    await getTask({
      client: mockAxiosInstance as any,
      taskId: "DEV-225",
      customTaskIds: true,
      teamId: "team9",
    });

    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/task/DEV-225", {
      params: { custom_task_ids: true, team_id: "team9" },
    });
  });
});

describe("createTask (markdown + custom fields)", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("sends normalized markdown_content instead of description", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: makeClickUpTask() });

    await createTask({
      client: mockAxiosInstance as any,
      listId: "list1",
      name: "Task",
      markdownContent: "- [ ] A   - [ ] B",
    });

    var body = mockAxiosInstance.post.mock.calls[0][1];
    expect(body.markdown_content).toBe("- [ ] A\n- [ ] B");
    expect(body).not.toHaveProperty("description");
  });

  it("sends custom_fields when provided", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: makeClickUpTask() });

    await createTask({
      client: mockAxiosInstance as any,
      listId: "list1",
      name: "Task",
      customFields: [{ id: "f1", value: "v1" }],
    });

    var body = mockAxiosInstance.post.mock.calls[0][1];
    expect(body.custom_fields).toEqual([{ id: "f1", value: "v1" }]);
  });
});

describe("updateTask (markdown + custom IDs)", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("sends normalized markdown_content and the custom-ID query", async function () {
    mockAxiosInstance.put.mockResolvedValue({ data: makeClickUpTask() });

    await updateTask({
      client: mockAxiosInstance as any,
      taskId: "DEV-224",
      markdownContent: "intro\n- [ ] A   - [x] B",
      customTaskIds: true,
      teamId: "team9",
    });

    expect(mockAxiosInstance.put).toHaveBeenCalledWith(
      "/api/v2/task/DEV-224",
      { markdown_content: "intro\n- [ ] A\n- [x] B" },
      { params: { custom_task_ids: true, team_id: "team9" } }
    );
  });
});

describe("setCustomField", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("POSTs the value to the field endpoint", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: {} });

    await setCustomField({
      client: mockAxiosInstance as any,
      taskId: "t1",
      fieldId: "f1",
      value: "hello",
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/v2/task/t1/field/f1",
      { value: "hello" },
      {}
    );
  });

  it("supports the users add/rem value shape and custom-ID query", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: {} });

    await setCustomField({
      client: mockAxiosInstance as any,
      taskId: "DEV-225",
      fieldId: "f1",
      value: { add: [1], rem: [] },
      customTaskIds: true,
      teamId: "team9",
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/v2/task/DEV-225/field/f1",
      { value: { add: [1], rem: [] } },
      { params: { custom_task_ids: true, team_id: "team9" } }
    );
  });

  it("throws on 404 with field context", async function () {
    mockAxiosInstance.post.mockRejectedValue(makeAxiosError(404));

    await expect(
      setCustomField({
        client: mockAxiosInstance as any,
        taskId: "t1",
        fieldId: "f1",
        value: "x",
      })
    ).rejects.toThrow("not found");
  });
});

describe("linkTask", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("POSTs to the link endpoint", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: {} });

    await linkTask({
      client: mockAxiosInstance as any,
      taskId: "t1",
      linksTo: "t2",
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/v2/task/t1/link/t2",
      {},
      {}
    );
  });

  it("includes the custom-ID query for both IDs", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: {} });

    await linkTask({
      client: mockAxiosInstance as any,
      taskId: "DEV-226",
      linksTo: "DEV-365",
      customTaskIds: true,
      teamId: "team9",
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/v2/task/DEV-226/link/DEV-365",
      {},
      { params: { custom_task_ids: true, team_id: "team9" } }
    );
  });
});

describe("normalizeChecklistMarkdown", function () {
  it("splits an inline checkbox run onto separate lines", function () {
    expect(normalizeChecklistMarkdown("- [ ] A   - [ ] B   - [x] C")).toBe(
      "- [ ] A\n- [ ] B\n- [x] C"
    );
  });

  it("leaves a single-checkbox line untouched", function () {
    expect(normalizeChecklistMarkdown("- [ ] only one")).toBe("- [ ] only one");
  });

  it("is idempotent on already-split content", function () {
    var already = "- [ ] A\n- [x] B";
    expect(normalizeChecklistMarkdown(already)).toBe(already);
  });

  it("does not touch non-checkbox lines", function () {
    var md = "## Title\n\nSome prose with - dashes - inline.";
    expect(normalizeChecklistMarkdown(md)).toBe(md);
  });
});

describe("createClickUpApi", function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  it("returns object with all expected methods", function () {
    var api = createClickUpApi({ token: "test" });

    expect(typeof api.getAuthorizedUser).toBe("function");
    expect(typeof api.getTask).toBe("function");
    expect(typeof api.listMyTasks).toBe("function");
    expect(typeof api.listTeamTasks).toBe("function");
    expect(typeof api.createTask).toBe("function");
    expect(typeof api.updateTask).toBe("function");
    expect(typeof api.updateTaskStatus).toBe("function");
    expect(typeof api.deleteTask).toBe("function");
    expect(typeof api.setCustomField).toBe("function");
    expect(typeof api.linkTask).toBe("function");
    expect(typeof api.addComment).toBe("function");
    expect(typeof api.getTeams).toBe("function");
    expect(typeof api.getSpaces).toBe("function");
    expect(typeof api.getFolders).toBe("function");
    expect(typeof api.getLists).toBe("function");
    expect(typeof api.getSpaceLists).toBe("function");
    expect(typeof api.getListTasks).toBe("function");
  });

  it("delegates getTask to the correct endpoint", async function () {
    mockAxiosInstance.get.mockResolvedValue({ data: makeClickUpTask({ id: "delegated" }) });

    var api = createClickUpApi({ token: "test" });
    var result = await api.getTask({ taskId: "delegated" });

    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v2/task/delegated", {});
    expect(result.id).toBe("delegated");
  });

  it("delegates addComment with correct params", async function () {
    mockAxiosInstance.post.mockResolvedValue({ data: {} });

    var api = createClickUpApi({ token: "test" });
    await api.addComment({ taskId: "t1", commentText: "Test comment" });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/api/v2/task/t1/comment",
      { comment_text: "Test comment" }
    );
  });
});
