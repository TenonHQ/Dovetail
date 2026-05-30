import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { buildDescriptors, TOOL_NAMES, todosDashboardUrl } from "../registry";
import { loadList } from "../storage";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dove-todo-reg-"));
}

function byName(descs: ReturnType<typeof buildDescriptors>, name: string) {
  var found = descs.filter(function (d) { return d.name === name; })[0];
  if (!found) throw new Error("descriptor not found: " + name);
  return found;
}

describe("registry", function () {
  var root: string;
  var descs: ReturnType<typeof buildDescriptors>;

  beforeEach(function () {
    root = tmpRoot();
    descs = buildDescriptors({ storage: { rootDir: root } });
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("registers exactly the 8 expected tools", function () {
    expect(TOOL_NAMES.length).toBe(8);
    expect(descs.map(function (d) { return d.name; }).sort()).toEqual(TOOL_NAMES.slice().sort());
  });

  test("every descriptor exposes a zod shape and a handler", function () {
    descs.forEach(function (d) {
      expect(typeof d.handler).toBe("function");
      expect(d.shape).toBeDefined();
      expect(d.description.length).toBeGreaterThan(0);
    });
  });

  test("todo_add handler persists and returns a dashboard url", async function () {
    var res = await byName(descs, "todo_add").handler({ text: "ship it" });
    expect(res.item.text).toBe("ship it");
    expect(res.url).toBe(todosDashboardUrl());
    expect(loadList({ rootDir: root }).items.length).toBe(1);
  });

  test("todo_add validates single-line text via zod", async function () {
    await expect(byName(descs, "todo_add").handler({ text: "line1\nline2" })).rejects.toThrow();
  });

  test("todo_reorder handler round-trips an ordering", async function () {
    var a = (await byName(descs, "todo_add").handler({ text: "a" })).item;
    var b = (await byName(descs, "todo_add").handler({ text: "b" })).item;
    var list = await byName(descs, "todo_reorder").handler({ ids: [b.id, a.id] });
    expect(list.items.map(function (i: any) { return i.text; })).toEqual(["b", "a"]);
  });

  test("todo_list reflects include_done filter", async function () {
    var a = (await byName(descs, "todo_add").handler({ text: "a" })).item;
    await byName(descs, "todo_add").handler({ text: "b" });
    await byName(descs, "todo_toggle").handler({ id: a.id, done: true });
    var res = await byName(descs, "todo_list").handler({ include_done: false });
    expect(res.count).toBe(1);
    expect(res.items[0].text).toBe("b");
  });

  test("todo_clear_done removes completed items", async function () {
    var a = (await byName(descs, "todo_add").handler({ text: "a" })).item;
    await byName(descs, "todo_add").handler({ text: "b" });
    await byName(descs, "todo_toggle").handler({ id: a.id, done: true });
    var res = await byName(descs, "todo_clear_done").handler({});
    expect(res.removed).toBe(1);
  });

  test("todosDashboardUrl honors DOVE_DASHBOARD_URL override", function () {
    var prev = process.env.DOVE_DASHBOARD_URL;
    process.env.DOVE_DASHBOARD_URL = "http://localhost:9999/";
    expect(todosDashboardUrl()).toBe("http://localhost:9999/todos");
    if (prev === undefined) delete process.env.DOVE_DASHBOARD_URL;
    else process.env.DOVE_DASHBOARD_URL = prev;
  });
});
