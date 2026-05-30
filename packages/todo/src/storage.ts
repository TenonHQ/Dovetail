/**
 * Atomic JSON file store for the priority TODO list.
 *
 * Layout under storageRoot() (~/.dovetail/todos/ by default):
 *   todos.json   -- a single { schema_version, items[], updated_at } record
 *
 * The items array is the source of truth for priority: index 0 is the top
 * priority. Every mutation rewrites the whole file with an atomic tmp + rename,
 * so the dashboard's chokidar watcher never observes a torn file and a drag
 * reorder lands as one consistent write.
 *
 * Concurrency note: load-mutate-write is last-write-wins. Expected concurrency
 * is one Claude session plus the local dashboard, so this is documented rather
 * than locked.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

import { CURRENT_SCHEMA_VERSION, TodoItem, TodoList } from "./types";

export interface StorageOptions {
  rootDir?: string;
}

export function storageRoot(options: StorageOptions = {}): string {
  if (options.rootDir) return options.rootDir;
  var override = process.env.DOVE_TODO_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".dovetail", "todos");
}

export function todosPath(options: StorageOptions = {}): string {
  return path.join(storageRoot(options), "todos.json");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  var tmp = filePath + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

// Module-private id generator. Tests force collisions via __setIdGenerator.
var __idGenerator: () => string = function () {
  return "td_" + crypto.randomBytes(5).toString("hex");
};

export function __setIdGenerator(fn: () => string): () => string {
  var prev = __idGenerator;
  __idGenerator = fn;
  return prev;
}

function generateId(taken: TodoItem[]): string {
  for (var attempt = 0; attempt < 5; attempt++) {
    var candidate = __idGenerator();
    var clash = false;
    for (var i = 0; i < taken.length; i++) {
      if (taken[i].id === candidate) { clash = true; break; }
    }
    if (!clash) return candidate;
  }
  throw new Error("failed to generate unique todo id after 5 attempts");
}

function emptyList(): TodoList {
  return { schema_version: CURRENT_SCHEMA_VERSION, items: [], updated_at: nowIso() };
}

/**
 * Read the list from disk, returning an empty list when the file is absent.
 * A corrupt/unparseable file throws — callers decide whether to surface it.
 */
export function loadList(options: StorageOptions = {}): TodoList {
  var file = todosPath(options);
  if (!fs.existsSync(file)) return emptyList();
  var raw = fs.readFileSync(file, "utf8");
  var parsed = JSON.parse(raw) as Partial<TodoList>;
  var items = Array.isArray(parsed.items) ? (parsed.items as TodoItem[]) : [];
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    items: items,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : nowIso()
  };
}

function writeList(list: TodoList, options: StorageOptions = {}): TodoList {
  var next: TodoList = {
    schema_version: CURRENT_SCHEMA_VERSION,
    items: list.items,
    updated_at: nowIso()
  };
  atomicWriteJson(todosPath(options), next);
  return next;
}

function findIndex(items: TodoItem[], id: string): number {
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === id) return i;
  }
  return -1;
}

export interface AddTodoInput {
  text: string;
  /** "top" inserts at index 0 (highest priority); "bottom" (default) appends. */
  position?: "top" | "bottom";
}

export interface MutationResult {
  item: TodoItem;
  list: TodoList;
}

export function addTodo(input: AddTodoInput, options: StorageOptions = {}): MutationResult {
  var text = (input.text || "").trim();
  if (!text) throw new Error("todo text is required");
  var list = loadList(options);
  var now = nowIso();
  var item: TodoItem = {
    id: generateId(list.items),
    text: text,
    done: false,
    created_at: now,
    updated_at: now,
    completed_at: null
  };
  var items = input.position === "top" ? [item].concat(list.items) : list.items.concat([item]);
  var written = writeList({ schema_version: CURRENT_SCHEMA_VERSION, items: items, updated_at: now }, options);
  return { item: item, list: written };
}

export interface ToggleTodoInput {
  id: string;
  /** Explicit target state; when omitted, flips the current value. */
  done?: boolean;
}

export function toggleTodo(input: ToggleTodoInput, options: StorageOptions = {}): MutationResult {
  var list = loadList(options);
  var idx = findIndex(list.items, input.id);
  if (idx === -1) throw new Error("todo not found: " + input.id);
  var prev = list.items[idx];
  var nextDone = input.done === undefined ? !prev.done : input.done;
  var now = nowIso();
  var updated: TodoItem = {
    id: prev.id,
    text: prev.text,
    done: nextDone,
    created_at: prev.created_at,
    updated_at: now,
    completed_at: nextDone ? (prev.completed_at || now) : null
  };
  var items = list.items.slice();
  items[idx] = updated;
  var written = writeList({ schema_version: CURRENT_SCHEMA_VERSION, items: items, updated_at: now }, options);
  return { item: updated, list: written };
}

export interface UpdateTodoInput {
  id: string;
  text: string;
}

export function updateTodo(input: UpdateTodoInput, options: StorageOptions = {}): MutationResult {
  var text = (input.text || "").trim();
  if (!text) throw new Error("todo text is required");
  var list = loadList(options);
  var idx = findIndex(list.items, input.id);
  if (idx === -1) throw new Error("todo not found: " + input.id);
  var prev = list.items[idx];
  var updated: TodoItem = {
    id: prev.id,
    text: text,
    done: prev.done,
    created_at: prev.created_at,
    updated_at: nowIso(),
    completed_at: prev.completed_at === undefined ? null : prev.completed_at
  };
  var items = list.items.slice();
  items[idx] = updated;
  var written = writeList({ schema_version: CURRENT_SCHEMA_VERSION, items: items, updated_at: updated.updated_at }, options);
  return { item: updated, list: written };
}

export interface ReorderInput {
  /** The complete set of ids in their new priority order (index 0 = top). */
  ids: string[];
}

/**
 * Persist a full drag-and-drop ordering. `ids` MUST be a permutation of the
 * current item ids — any missing or unknown id is a hard error so a stale
 * client can't silently drop items. Returns the reordered list.
 */
export function reorderTodos(input: ReorderInput, options: StorageOptions = {}): TodoList {
  var list = loadList(options);
  var ids = input.ids || [];
  if (ids.length !== list.items.length) {
    throw new Error(
      "reorder ids length (" + ids.length + ") does not match item count (" + list.items.length + ")"
    );
  }
  var byId: { [id: string]: TodoItem } = {};
  for (var i = 0; i < list.items.length; i++) byId[list.items[i].id] = list.items[i];
  var seen: { [id: string]: boolean } = {};
  var reordered: TodoItem[] = [];
  for (var j = 0; j < ids.length; j++) {
    var id = ids[j];
    if (!byId[id]) throw new Error("reorder references unknown id: " + id);
    if (seen[id]) throw new Error("reorder references duplicate id: " + id);
    seen[id] = true;
    reordered.push(byId[id]);
  }
  return writeList({ schema_version: CURRENT_SCHEMA_VERSION, items: reordered, updated_at: nowIso() }, options);
}

export interface MoveTodoInput {
  id: string;
  /** Target index in the ordered list (clamped to [0, length-1]). */
  to_index: number;
}

export function moveTodo(input: MoveTodoInput, options: StorageOptions = {}): TodoList {
  var list = loadList(options);
  var from = findIndex(list.items, input.id);
  if (from === -1) throw new Error("todo not found: " + input.id);
  var items = list.items.slice();
  var moved = items.splice(from, 1)[0];
  var to = input.to_index;
  if (to < 0) to = 0;
  if (to > items.length) to = items.length;
  items.splice(to, 0, moved);
  return writeList({ schema_version: CURRENT_SCHEMA_VERSION, items: items, updated_at: nowIso() }, options);
}

export interface RemoveTodoInput {
  id: string;
}

export function removeTodo(input: RemoveTodoInput, options: StorageOptions = {}): { removed: boolean; list: TodoList } {
  var list = loadList(options);
  var idx = findIndex(list.items, input.id);
  if (idx === -1) return { removed: false, list: list };
  var items = list.items.slice();
  items.splice(idx, 1);
  var written = writeList({ schema_version: CURRENT_SCHEMA_VERSION, items: items, updated_at: nowIso() }, options);
  return { removed: true, list: written };
}

export function clearDone(options: StorageOptions = {}): { removed: number; list: TodoList } {
  var list = loadList(options);
  var kept: TodoItem[] = [];
  var removed = 0;
  for (var i = 0; i < list.items.length; i++) {
    if (list.items[i].done) { removed++; continue; }
    kept.push(list.items[i]);
  }
  if (removed === 0) return { removed: 0, list: list };
  var written = writeList({ schema_version: CURRENT_SCHEMA_VERSION, items: kept, updated_at: nowIso() }, options);
  return { removed: removed, list: written };
}

export interface ListTodosOptions extends StorageOptions {
  include_done?: boolean;
}

export function listTodos(options: ListTodosOptions = {}): TodoItem[] {
  var list = loadList(options);
  if (options.include_done === false) {
    return list.items.filter(function (it) { return !it.done; });
  }
  return list.items;
}
