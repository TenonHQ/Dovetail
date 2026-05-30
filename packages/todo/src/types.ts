/**
 * Shared data shapes for the priority TODO list.
 * Persisted to disk as a single JSON file under ~/.dovetail/todos/todos.json.
 *
 * The list is an ORDERED array: index 0 is the highest priority. Drag-to-reorder
 * in the dashboard is simply a rewrite of the array order — there is no separate
 * priority field to keep in sync.
 */

export type TodoListSchemaVersion = 1;

export var CURRENT_SCHEMA_VERSION: TodoListSchemaVersion = 1;

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  created_at: string;
  updated_at: string;
  /** Set when done flips true→ (cleared when unchecked). Used for sort/age. */
  completed_at?: string | null;
}

export interface TodoList {
  schema_version: TodoListSchemaVersion;
  items: TodoItem[];
  updated_at: string;
}
