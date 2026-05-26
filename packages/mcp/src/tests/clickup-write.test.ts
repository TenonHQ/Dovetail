/**
 * Phase-2 gated ClickUp write tools: gate, dry-run, and execute paths.
 * Uses an injected clientFactory so no real HTTP happens.
 */

import {
  clickupUpdateTask,
  clickupSetCustomField,
  clickupCreateTask,
  clickupLinkTasks
} from "../tools/clickup-write";
import type { ClickUpDeps } from "../tools/clickup";

function makeClient() {
  return {
    get: jest.fn(),
    post: jest.fn().mockResolvedValue({ data: { id: "created" } }),
    put: jest.fn().mockResolvedValue({ data: { id: "t1" } }),
    delete: jest.fn()
  };
}

function makeDeps(writesEnabled: boolean, client: any): ClickUpDeps {
  return {
    config: { token: "pk" },
    clientFactory: function () {
      return client;
    },
    writesEnabled: writesEnabled
  };
}

describe("clickup write gate", function () {
  it("refuses every write when writesEnabled is false", async function () {
    var deps = makeDeps(false, makeClient());
    await expect(
      clickupUpdateTask({ taskId: "t1", confirm: true } as any, deps)
    ).rejects.toThrow("writes are disabled");
    await expect(
      clickupSetCustomField({ taskId: "t1", fieldId: "f", value: "v", confirm: true } as any, deps)
    ).rejects.toThrow("writes are disabled");
    await expect(
      clickupCreateTask({ listId: "l", name: "n", confirm: true } as any, deps)
    ).rejects.toThrow("writes are disabled");
    await expect(
      clickupLinkTasks({ taskId: "t1", linksTo: "t2", confirm: true } as any, deps)
    ).rejects.toThrow("writes are disabled");
  });
});

describe("clickup write dry-run (no confirm)", function () {
  it("returns a preview and performs no HTTP", async function () {
    var client = makeClient();
    var deps = makeDeps(true, client);

    var res = await clickupUpdateTask({ taskId: "t1", status: "draft" } as any, deps);
    expect(res.dryRun).toBe(true);
    expect(res.action).toBe("update_task");
    expect(client.put).not.toHaveBeenCalled();
  });
});

describe("clickup write execute (confirm:true)", function () {
  it("updateTask PUTs the body and normalizes markdown", async function () {
    var client = makeClient();
    var deps = makeDeps(true, client);

    var res = await clickupUpdateTask(
      { taskId: "t1", markdownContent: "- [ ] A   - [ ] B", confirm: true } as any,
      deps
    );

    expect(res).toEqual({ id: "t1" });
    var call = client.put.mock.calls[0];
    expect(call[0]).toBe("/api/v2/task/t1");
    expect(call[1].markdown_content).toBe("- [ ] A\n- [ ] B");
  });

  it("setCustomField POSTs to the field endpoint and returns ok", async function () {
    var client = makeClient();
    var deps = makeDeps(true, client);

    var res = await clickupSetCustomField(
      { taskId: "t1", fieldId: "f1", value: "hello", confirm: true } as any,
      deps
    );

    expect(res.ok).toBe(true);
    expect(client.post).toHaveBeenCalledWith(
      "/api/v2/task/t1/field/f1",
      { value: "hello" },
      {}
    );
  });

  it("createTask POSTs to the list endpoint", async function () {
    var client = makeClient();
    var deps = makeDeps(true, client);

    var res = await clickupCreateTask(
      { listId: "list1", name: "New", confirm: true } as any,
      deps
    );

    expect(res).toEqual({ id: "created" });
    expect(client.post.mock.calls[0][0]).toBe("/api/v2/list/list1/task");
  });

  it("linkTasks POSTs to the link endpoint with custom-ID query", async function () {
    var client = makeClient();
    var deps = makeDeps(true, client);

    var res = await clickupLinkTasks(
      { taskId: "DEV-226", linksTo: "DEV-365", customTaskIds: true, teamId: "team9", confirm: true } as any,
      deps
    );

    expect(res.ok).toBe(true);
    expect(client.post).toHaveBeenCalledWith(
      "/api/v2/task/DEV-226/link/DEV-365",
      {},
      { params: { custom_task_ids: true, team_id: "team9" } }
    );
  });
});
