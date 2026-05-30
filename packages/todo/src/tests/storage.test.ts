import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  addTodo,
  clearDone,
  listTodos,
  loadList,
  moveTodo,
  removeTodo,
  reorderTodos,
  storageRoot,
  toggleTodo,
  todosPath,
  updateTodo,
  __setIdGenerator
} from "../storage";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dove-todo-"));
}

describe("storage", function () {
  var root: string;
  var opts: { rootDir: string };
  var restoreId: () => string;
  var counter: number;

  beforeEach(function () {
    root = tmpRoot();
    opts = { rootDir: root };
    counter = 0;
    // Deterministic, collision-free ids so assertions are stable.
    restoreId = __setIdGenerator(function () {
      counter++;
      return "td_" + String(counter).padStart(4, "0");
    });
  });

  afterEach(function () {
    __setIdGenerator(restoreId);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("storageRoot honors rootDir override", function () {
    expect(storageRoot(opts)).toBe(root);
    expect(todosPath(opts)).toBe(path.join(root, "todos.json"));
  });

  test("loadList returns an empty list when no file exists", function () {
    var list = loadList(opts);
    expect(list.items).toEqual([]);
    expect(list.schema_version).toBe(1);
  });

  test("addTodo appends to the bottom by default and writes atomically", function () {
    addTodo({ text: "first" }, opts);
    var r2 = addTodo({ text: "second" }, opts);
    expect(r2.list.items.map(function (i) { return i.text; })).toEqual(["first", "second"]);
    // File really exists and parses.
    expect(fs.existsSync(todosPath(opts))).toBe(true);
    expect(loadList(opts).items.length).toBe(2);
  });

  test("addTodo position:top makes the new item highest priority", function () {
    addTodo({ text: "first" }, opts);
    addTodo({ text: "urgent", position: "top" }, opts);
    expect(loadList(opts).items.map(function (i) { return i.text; })).toEqual(["urgent", "first"]);
  });

  test("addTodo rejects blank text", function () {
    expect(function () { addTodo({ text: "   " }, opts); }).toThrow(/text is required/);
  });

  test("toggleTodo flips done and stamps completed_at", function () {
    var a = addTodo({ text: "task" }, opts);
    var t = toggleTodo({ id: a.item.id }, opts);
    expect(t.item.done).toBe(true);
    expect(typeof t.item.completed_at).toBe("string");
    var u = toggleTodo({ id: a.item.id }, opts);
    expect(u.item.done).toBe(false);
    expect(u.item.completed_at).toBeNull();
  });

  test("toggleTodo with explicit done is idempotent", function () {
    var a = addTodo({ text: "task" }, opts);
    toggleTodo({ id: a.item.id, done: true }, opts);
    var again = toggleTodo({ id: a.item.id, done: true }, opts);
    expect(again.item.done).toBe(true);
  });

  test("toggleTodo throws on unknown id", function () {
    expect(function () { toggleTodo({ id: "nope" }, opts); }).toThrow(/not found/);
  });

  test("updateTodo edits text and preserves created_at + done", function () {
    var a = addTodo({ text: "old" }, opts);
    toggleTodo({ id: a.item.id, done: true }, opts);
    var u = updateTodo({ id: a.item.id, text: "new" }, opts);
    expect(u.item.text).toBe("new");
    expect(u.item.done).toBe(true);
    expect(u.item.created_at).toBe(a.item.created_at);
  });

  test("reorderTodos persists a full permutation", function () {
    var a = addTodo({ text: "a" }, opts).item;
    var b = addTodo({ text: "b" }, opts).item;
    var c = addTodo({ text: "c" }, opts).item;
    var list = reorderTodos({ ids: [c.id, a.id, b.id] }, opts);
    expect(list.items.map(function (i) { return i.text; })).toEqual(["c", "a", "b"]);
  });

  test("reorderTodos rejects wrong-length id arrays", function () {
    var a = addTodo({ text: "a" }, opts).item;
    addTodo({ text: "b" }, opts);
    expect(function () { reorderTodos({ ids: [a.id] }, opts); }).toThrow(/does not match item count/);
  });

  test("reorderTodos rejects unknown ids", function () {
    var a = addTodo({ text: "a" }, opts).item;
    var b = addTodo({ text: "b" }, opts).item;
    expect(function () { reorderTodos({ ids: [a.id, "ghost"] }, opts); }).toThrow(/unknown id/);
    // original order untouched
    expect(loadList(opts).items.map(function (i) { return i.id; })).toEqual([a.id, b.id]);
  });

  test("reorderTodos rejects duplicate ids", function () {
    var a = addTodo({ text: "a" }, opts).item;
    addTodo({ text: "b" }, opts);
    expect(function () { reorderTodos({ ids: [a.id, a.id] }, opts); }).toThrow(/duplicate id/);
  });

  test("moveTodo relocates one item and clamps the index", function () {
    var a = addTodo({ text: "a" }, opts).item;
    var b = addTodo({ text: "b" }, opts).item;
    var c = addTodo({ text: "c" }, opts).item;
    // move c to the top
    var list = moveTodo({ id: c.id, to_index: 0 }, opts);
    expect(list.items.map(function (i) { return i.text; })).toEqual(["c", "a", "b"]);
    // clamp past the end
    var list2 = moveTodo({ id: a.id, to_index: 99 }, opts);
    expect(list2.items[list2.items.length - 1].id).toBe(a.id);
    expect(b.id).toBeDefined();
  });

  test("removeTodo deletes by id and reports absence", function () {
    var a = addTodo({ text: "a" }, opts).item;
    expect(removeTodo({ id: a.id }, opts).removed).toBe(true);
    expect(removeTodo({ id: a.id }, opts).removed).toBe(false);
    expect(loadList(opts).items.length).toBe(0);
  });

  test("clearDone removes only completed items", function () {
    var a = addTodo({ text: "a" }, opts).item;
    var b = addTodo({ text: "b" }, opts).item;
    addTodo({ text: "c" }, opts);
    toggleTodo({ id: a.id, done: true }, opts);
    toggleTodo({ id: b.id, done: true }, opts);
    var res = clearDone(opts);
    expect(res.removed).toBe(2);
    expect(res.list.items.map(function (i) { return i.text; })).toEqual(["c"]);
  });

  test("listTodos include_done:false hides completed items", function () {
    var a = addTodo({ text: "a" }, opts).item;
    addTodo({ text: "b" }, opts);
    toggleTodo({ id: a.id, done: true }, opts);
    expect(listTodos({ include_done: false, rootDir: root }).map(function (i) { return i.text; })).toEqual(["b"]);
    expect(listTodos({ rootDir: root }).length).toBe(2);
  });

  test("a corrupt items field degrades to an empty list", function () {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(todosPath(opts), JSON.stringify({ items: "not-an-array" }));
    expect(loadList(opts).items).toEqual([]);
  });
});
