#!/usr/bin/env node
/**
 * dove-todo CLI. Subcommands:
 *   mcp [--smoke]      run MCP stdio server (used by .mcp.json)
 *   list [--all]       list items in priority order (--all includes done)
 *   add <text...>      add a one-line item to the bottom
 *   add --top <text>   add to the top (highest priority)
 *   done <id>          mark an item done
 *   undone <id>        mark an item not done
 *   remove <id>        delete an item
 *   clear-done         remove every completed item
 *   where              print the storage root path
 */

import {
  addTodo,
  clearDone,
  listTodos,
  removeTodo,
  storageRoot,
  toggleTodo
} from "./storage";
import { runSmoke, runStdio } from "./server";

function hasFlag(name: string): boolean {
  return process.argv.indexOf(name) !== -1;
}

// Join the non-flag argv tail after the command into a single text string.
function textTail(): string {
  var rest = process.argv.slice(3).filter(function (a) { return a.indexOf("--") !== 0; });
  return rest.join(" ").trim();
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: dove-todo <command> [options]",
      "",
      "Commands:",
      "  mcp [--smoke]      Run MCP stdio server",
      "  list [--all]       List items in priority order (--all includes done)",
      "  add [--top] <text> Add a one-line item (default to the bottom)",
      "  done <id>          Mark an item done",
      "  undone <id>        Mark an item not done",
      "  remove <id>        Delete an item",
      "  clear-done         Remove every completed item",
      "  where              Print the storage root path",
      ""
    ].join("\n")
  );
}

async function cmdMcp(): Promise<void> {
  if (hasFlag("--smoke")) {
    await runSmoke();
    return;
  }
  await runStdio();
}

async function cmdList(): Promise<void> {
  var all = hasFlag("--all");
  var items = listTodos({ include_done: all ? undefined : false });
  if (items.length === 0) {
    process.stdout.write("(no todos)\n");
    return;
  }
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var box = it.done ? "[x]" : "[ ]";
    var rank = String(i + 1).padStart(2, " ");
    process.stdout.write(rank + ". " + box + " " + it.text + "  (" + it.id + ")\n");
  }
}

async function cmdAdd(): Promise<void> {
  var text = textTail();
  if (!text) {
    process.stderr.write("usage: dove-todo add [--top] <text>\n");
    process.exit(2);
    return;
  }
  var position = hasFlag("--top") ? "top" : "bottom";
  var result = addTodo({ text: text, position: position as "top" | "bottom" });
  process.stdout.write("added: " + result.item.id + "  " + result.item.text + "\n");
}

async function cmdToggle(id: string | undefined, done: boolean): Promise<void> {
  if (!id) {
    process.stderr.write("usage: dove-todo " + (done ? "done" : "undone") + " <id>\n");
    process.exit(2);
    return;
  }
  var result = toggleTodo({ id: id, done: done });
  process.stdout.write((done ? "done: " : "undone: ") + result.item.id + "\n");
}

async function cmdRemove(id: string | undefined): Promise<void> {
  if (!id) {
    process.stderr.write("usage: dove-todo remove <id>\n");
    process.exit(2);
    return;
  }
  var result = removeTodo({ id: id });
  process.stdout.write((result.removed ? "removed: " : "not found: ") + id + "\n");
}

async function cmdClearDone(): Promise<void> {
  var result = clearDone();
  process.stdout.write("cleared " + result.removed + " completed item(s)\n");
}

async function cmdWhere(): Promise<void> {
  process.stdout.write(storageRoot() + "\n");
}

async function main(): Promise<void> {
  var cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }
  if (cmd === "mcp") return cmdMcp();
  if (cmd === "list") return cmdList();
  if (cmd === "add") return cmdAdd();
  if (cmd === "done") return cmdToggle(process.argv[3], true);
  if (cmd === "undone") return cmdToggle(process.argv[3], false);
  if (cmd === "remove") return cmdRemove(process.argv[3]);
  if (cmd === "clear-done") return cmdClearDone();
  if (cmd === "where") return cmdWhere();

  process.stderr.write("unknown command: " + cmd + "\n");
  printUsage();
  process.exit(2);
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write(
      "dove-todo fatal: " + (err && err.message ? err.message : String(err)) + "\n"
    );
    process.exit(1);
  });
}
