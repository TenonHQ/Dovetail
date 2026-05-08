/**
 * Static guarantee that no tool module imports or references a write API.
 * Reads each src/tools/*.ts file and asserts no occurrence of forbidden
 * symbols. Cheap: regex over file text, no AST, no compile.
 */

import * as fs from "fs";
import * as path from "path";

var TOOLS_DIR = path.resolve(__dirname, "..", "tools");

var FORBIDDEN_SYMBOLS = [
  "archiveEmail",
  "labelEmail",
  "markAsRead",
  "markAsUnread",
  "moveToTrash",
  "starEmail",
  "unstarEmail",
  "createEvent",
  "updateEvent",
  "deleteEvent",
  "createTask",
  "updateTask",
  "updateTaskStatus",
  "deleteTask",
  "addComment",
  "addChoicesToField",
  "pushWithUpdateSet",
  "createRecord",
  ".claude.",
  "client.claude"
];

function listToolFiles(): string[] {
  var entries = fs.readdirSync(TOOLS_DIR);
  var result: string[] = [];
  for (var i = 0; i < entries.length; i++) {
    if (/\.ts$/.test(entries[i])) {
      result.push(path.join(TOOLS_DIR, entries[i]));
    }
  }
  return result;
}

describe("read-only import guarantee", function () {
  var files = listToolFiles();

  it("scans at least four tool files", function () {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it("no tool file references a forbidden write symbol", function () {
    var violations: string[] = [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var content = fs.readFileSync(file, "utf8");
      // Strip block comments and line comments — descriptive prose can
      // legitimately mention forbidden symbol names without actually using them.
      var stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
      for (var s = 0; s < FORBIDDEN_SYMBOLS.length; s++) {
        if (stripped.indexOf(FORBIDDEN_SYMBOLS[s]) !== -1) {
          violations.push(path.basename(file) + " references " + FORBIDDEN_SYMBOLS[s]);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error("Read-only violations: " + violations.join("; "));
    }
    expect(violations).toEqual([]);
  });
});
