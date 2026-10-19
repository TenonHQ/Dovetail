// Parity: `dove` (packages/core/src/envArg.ts resolveEnvArgPath) and `dove-sn`
// (packages/servicenow/src/loadEnv.ts resolveEnvSelection) must resolve a
// bare `--env <name>` identically, including the parent-directory walk-up.
// dovetail-servicenow does not depend on dovetail-core, so core is imported
// by its source path.
//
// Two legacy differences predate the walk-up and are deliberately NOT part
// of this parity table (both CLIs keep today's behavior for them):
//   - a dotted value with no file in cwd: dove → `<cwd>/<value>`,
//     dove-sn → `<cwd>/<prefix><value>`;
//   - a DIRECTORY named like the bare value in cwd: dove-sn takes it, dove
//     does not.
// Every file here is a fake, created in a temp directory at runtime.

import fs from "fs";
import os from "os";
import path from "path";
import * as core from "../../core/src/envArg";
import * as sn from "../src/loadEnv";

var ENV_PREFIX = ".env.";
var NAME = "loft";
var FILE = ENV_PREFIX + NAME;

interface Scenario {
  title: string;
  // Directories (relative to the fake home; "" = home, ".." = above home)
  // that get a `<prefix><name>` file before resolving.
  filesAt: string[];
  value: string;
  // Owner a parent match must have; omitted = the current user.
  ownerUid?: number;
}

// A uid that does not own the fixture files.
var OTHER_UID =
  (typeof process.getuid === "function" ? process.getuid() : 0) + 4242;

var SCENARIOS: Scenario[] = [
  { title: "found in cwd", filesAt: ["a/b/c/d", "a"], value: NAME },
  { title: "found 1 level up", filesAt: ["a/b/c"], value: NAME },
  { title: "found 3 levels up", filesAt: ["a"], value: NAME },
  { title: "nearest of several parents", filesAt: ["a/b", "a"], value: NAME },
  { title: "not found → cwd path", filesAt: [], value: NAME },
  { title: "home directory ignored", filesAt: [""], value: NAME },
  { title: "above home ignored", filesAt: [".."], value: NAME },
  { title: "prefixed basename never walks up", filesAt: ["a"], value: FILE },
  {
    title: "relative path never walks up",
    filesAt: ["a"],
    value: path.join("envs", NAME),
  },
  {
    title: "prefixed basename present in cwd",
    filesAt: ["a/b/c/d"],
    value: FILE,
  },
  {
    title: "parent file owned by another user skipped",
    filesAt: ["a"],
    value: NAME,
    ownerUid: OTHER_UID,
  },
  {
    title: "ownership check disabled (ownerUid < 0)",
    filesAt: ["a"],
    value: NAME,
    ownerUid: -1,
  },
];

describe("dove / dove-sn --env walk-up parity", function () {
  var root: string;
  var home: string;
  var cwd: string;

  beforeEach(function () {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "dove-walkup-parity-")),
    );
    home = path.join(root, "home");
    cwd = path.join(home, "a", "b", "c", "d");
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("shares the same max-depth constant", function () {
    expect(sn.ENV_WALK_UP_MAX_LEVELS).toBe(core.ENV_WALK_UP_MAX_LEVELS);
  });

  SCENARIOS.forEach(function (s) {
    it("resolves identically: " + s.title, function () {
      s.filesAt.forEach(function (rel) {
        var dir = rel === ".." ? root : path.join(home, rel);
        fs.writeFileSync(path.join(dir, FILE), "SN_INSTANCE=fake\n");
      });
      var coreCalls: string[] = [];
      var snCalls: string[] = [];
      var coreResult = core.resolveEnvArgPath(s.value, cwd, {
        homeDir: home,
        ownerUid: s.ownerUid,
        onParentMatch: function (p) {
          coreCalls.push(p);
        },
      });
      var snResult = sn.resolveEnvSelection(s.value, cwd, {
        homeDir: home,
        ownerUid: s.ownerUid,
        onParentMatch: function (p) {
          snCalls.push(p);
        },
      });
      expect(snResult).toBe(coreResult);
      expect(snCalls).toEqual(coreCalls);
    });
  });

  it("findEnvFileUpward agrees at every depth bound", function () {
    var levels: string[] = [];
    var dir = root;
    for (var i = 0; i < 12; i++) {
      dir = path.join(dir, "l" + i);
      levels.push(dir);
    }
    fs.mkdirSync(dir, { recursive: true });
    // One file 5 levels above the deepest directory.
    fs.writeFileSync(path.join(levels[levels.length - 1 - 5], FILE), "x");
    for (var max = 0; max <= 10; max++) {
      var args = { fileName: FILE, startDir: dir, homeDir: "", maxLevels: max };
      var coreFound = core.findEnvFileUpward(args);
      expect(sn.findEnvFileUpward(args)).toBe(coreFound);
      expect(coreFound === null).toBe(max < 5);
    }
  });

  it("both reject an empty selection the same way", function () {
    expect(function () {
      core.resolveEnvArgPath("  ", cwd);
    }).toThrow(/non-empty/);
    expect(function () {
      sn.resolveEnvSelection("  ", cwd);
    }).toThrow(/non-empty/);
  });
});
