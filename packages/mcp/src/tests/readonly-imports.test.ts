/**
 * Static guarantee on the write surface. Reads each src/tools/*.ts file and
 * asserts no occurrence of forbidden write symbols — EXCEPT the one declared
 * Phase-2 write module (clickup-write.ts), which may use the specific ClickUp
 * write symbols listed in WRITE_MODULE_ALLOW and nothing else forbidden.
 * Every other tool module stays fully read-only. Cheap: regex over file text.
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
  "setCustomField",
  "linkTask",
  "addChoicesToField",
  "pushWithUpdateSet",
  "createRecord",
  ".claude.",
  "client.claude"
];

// The ONE declared Phase-2 write module and the exact write symbols it may use.
// Least privilege: only the four verbs wired as MCP tools — destructive verbs
// (deleteTask, updateTaskStatus, addComment) stay banned even here. Gmail /
// Calendar / ServiceNow write symbols are likewise NOT permitted. Adding a new
// verb means: (1) appending it here, (2) updating the ESLint override in
// .eslintrc.json, and (3) wiring it as an MCP tool — all visible in one diff.
// Any other tool file referencing a forbidden symbol is still a violation.
var WRITE_MODULE_ALLOW: Record<string, string[]> = {
  "clickup-write.ts": [
    "createTask",
    "updateTask",
    "setCustomField",
    "linkTask"
  ]
};

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

  it("no tool file references a forbidden write symbol (except the declared write module)", function () {
    var violations: string[] = [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var base = path.basename(file);
      var allowed = WRITE_MODULE_ALLOW[base] || [];
      var content = fs.readFileSync(file, "utf8");
      // Strip block comments and line comments — descriptive prose can
      // legitimately mention forbidden symbol names without actually using them.
      var stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
      for (var s = 0; s < FORBIDDEN_SYMBOLS.length; s++) {
        if (allowed.indexOf(FORBIDDEN_SYMBOLS[s]) !== -1) {
          continue;
        }
        if (stripped.indexOf(FORBIDDEN_SYMBOLS[s]) !== -1) {
          violations.push(base + " references " + FORBIDDEN_SYMBOLS[s]);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error("Read-only violations: " + violations.join("; "));
    }
    expect(violations).toEqual([]);
  });

  it("every declared write module exists as a tool file", function () {
    var basenames = files.map(function (f) { return path.basename(f); });
    Object.keys(WRITE_MODULE_ALLOW).forEach(function (mod) {
      expect(basenames).toContain(mod);
    });
  });
});
