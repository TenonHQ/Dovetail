// Tests for the parent-directory lookup of a bare `--env <name>` (envArg.ts):
// resolveEnvArgPath walks up from the cwd for `<prefix><name>` when the cwd
// has none, bounded by the home directory, the filesystem root and
// ENV_WALK_UP_MAX_LEVELS. Paths and dotted filenames never walk up.
// Every file here is a fake, created in a temp directory at runtime.

import fs from "fs";
import os from "os";
import path from "path";
import {
  ENV_WALK_UP_MAX_LEVELS,
  findEnvFileUpward,
  resolveEnvArgPath,
} from "../envArg";

// The conventional per-instance env-file prefix (`loft` → `<prefix>loft`).
var ENV_PREFIX = ".env.";
var NAME = "loft";
var FILE = ENV_PREFIX + NAME;

describe("resolveEnvArgPath — bare name walks up to a parent directory", function () {
  var root: string;
  var home: string;
  var cwd: string;

  beforeEach(function () {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "dove-walkup-")),
    );
    // root/home/a/b/c/d — cwd is d, the fake home directory is root/home.
    home = path.join(root, "home");
    cwd = path.join(home, "a", "b", "c", "d");
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(dir: string, name?: string): string {
    var p = path.join(dir, name || FILE);
    fs.writeFileSync(p, "SN_INSTANCE=fake\n");
    return p;
  }

  it("uses the file in cwd when it is there (no walk-up)", function () {
    var inCwd = touch(cwd);
    touch(path.join(home, "a"));
    var calls: string[] = [];
    expect(
      resolveEnvArgPath(NAME, cwd, {
        homeDir: home,
        onParentMatch: function (p) {
          calls.push(p);
        },
      }),
    ).toBe(inCwd);
    expect(calls).toEqual([]);
  });

  it("finds the file one level up and reports it", function () {
    var up1 = touch(path.join(home, "a", "b", "c"));
    var calls: string[] = [];
    expect(
      resolveEnvArgPath(NAME, cwd, {
        homeDir: home,
        onParentMatch: function (p) {
          calls.push(p);
        },
      }),
    ).toBe(up1);
    expect(calls).toEqual([up1]);
  });

  it("finds the file three levels up", function () {
    var up3 = touch(path.join(home, "a"));
    expect(resolveEnvArgPath(NAME, cwd, { homeDir: home })).toBe(up3);
  });

  it("takes the nearest match when several parents have one", function () {
    var near = touch(path.join(home, "a", "b"));
    touch(path.join(home, "a"));
    expect(resolveEnvArgPath(NAME, cwd, { homeDir: home })).toBe(near);
  });

  it("returns the cwd path (historical behavior) when no parent has the file", function () {
    var calls: string[] = [];
    expect(
      resolveEnvArgPath(NAME, cwd, {
        homeDir: home,
        onParentMatch: function (p) {
          calls.push(p);
        },
      }),
    ).toBe(path.join(cwd, FILE));
    expect(calls).toEqual([]);
  });

  it("never uses the home directory itself", function () {
    touch(home);
    expect(resolveEnvArgPath(NAME, cwd, { homeDir: home })).toBe(
      path.join(cwd, FILE),
    );
  });

  it("never uses a directory above the home directory", function () {
    touch(root);
    expect(resolveEnvArgPath(NAME, cwd, { homeDir: home })).toBe(
      path.join(cwd, FILE),
    );
  });

  it("skips a parent entry with that name that is a directory, not a file", function () {
    fs.mkdirSync(path.join(home, "a", "b", FILE));
    var up3 = touch(path.join(home, "a"));
    expect(resolveEnvArgPath(NAME, cwd, { homeDir: home })).toBe(up3);
  });

  it("does not walk up for a dotted filename", function () {
    touch(path.join(home, "a"), "loft.env");
    touch(path.join(home, "a"), FILE);
    expect(resolveEnvArgPath("loft.env", cwd, { homeDir: home })).toBe(
      path.join(cwd, "loft.env"),
    );
    expect(resolveEnvArgPath(FILE, cwd, { homeDir: home })).toBe(
      path.join(cwd, FILE),
    );
  });

  it("does not walk up for a path value", function () {
    touch(path.join(home, "a"));
    expect(
      resolveEnvArgPath(path.join("envs", NAME), cwd, { homeDir: home }),
    ).toBe(path.join(cwd, "envs", NAME));
  });

  it("checks existence with stat only — never opens or reads a file", function () {
    var up3 = touch(path.join(home, "a"));
    var readSpy = jest.spyOn(fs, "readFileSync");
    var openSpy = jest.spyOn(fs, "openSync");
    try {
      expect(resolveEnvArgPath(NAME, cwd, { homeDir: home })).toBe(up3);
      expect(resolveEnvArgPath("missing", cwd, { homeDir: home })).toBe(
        path.join(cwd, ENV_PREFIX + "missing"),
      );
      expect(readSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("skips a parent file owned by another user (e.g. planted in /tmp)", function () {
    touch(path.join(home, "a"));
    var otherUid =
      (typeof process.getuid === "function" ? process.getuid() : 0) + 4242;
    var calls: string[] = [];
    expect(
      resolveEnvArgPath(NAME, cwd, {
        homeDir: home,
        ownerUid: otherUid,
        onParentMatch: function (p) {
          calls.push(p);
        },
      }),
    ).toBe(path.join(cwd, FILE));
    expect(calls).toEqual([]);
  });

  it("accepts a parent file owned by the current user, and any owner when ownerUid < 0", function () {
    var up3 = touch(path.join(home, "a"));
    expect(resolveEnvArgPath(NAME, cwd, { homeDir: home })).toBe(up3);
    expect(resolveEnvArgPath(NAME, cwd, { homeDir: home, ownerUid: -1 })).toBe(
      up3,
    );
  });

  it("keeps the selection when the callback throws", function () {
    var up1 = touch(path.join(home, "a", "b", "c"));
    expect(
      resolveEnvArgPath(NAME, cwd, {
        homeDir: home,
        onParentMatch: function () {
          throw new Error("logger down");
        },
      }),
    ).toBe(up1);
  });
});

describe("findEnvFileUpward", function () {
  var root: string;

  beforeEach(function () {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "dove-walkup-depth-")),
    );
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // root/l0/l1/.../l<depth-1>; returns the deepest directory and every level.
  function chain(depth: number): { deepest: string; levels: string[] } {
    var levels: string[] = [];
    var dir = root;
    for (var i = 0; i < depth; i++) {
      dir = path.join(dir, "l" + i);
      levels.push(dir);
    }
    fs.mkdirSync(dir, { recursive: true });
    return { deepest: dir, levels: levels };
  }

  it("defaults to " + ENV_WALK_UP_MAX_LEVELS + " parent levels", function () {
    expect(ENV_WALK_UP_MAX_LEVELS).toBe(8);
  });

  it("finds a file exactly ENV_WALK_UP_MAX_LEVELS levels up", function () {
    var c = chain(ENV_WALK_UP_MAX_LEVELS + 2);
    // levels[last] is the start; ENV_WALK_UP_MAX_LEVELS up from it:
    var target = c.levels[c.levels.length - 1 - ENV_WALK_UP_MAX_LEVELS];
    fs.writeFileSync(path.join(target, FILE), "x");
    expect(
      findEnvFileUpward({ fileName: FILE, startDir: c.deepest, homeDir: "" }),
    ).toBe(path.join(target, FILE));
  });

  it("stops after ENV_WALK_UP_MAX_LEVELS levels", function () {
    var c = chain(ENV_WALK_UP_MAX_LEVELS + 3);
    var tooFar = c.levels[c.levels.length - 2 - ENV_WALK_UP_MAX_LEVELS];
    fs.writeFileSync(path.join(tooFar, FILE), "x");
    expect(
      findEnvFileUpward({ fileName: FILE, startDir: c.deepest, homeDir: "" }),
    ).toBeNull();
  });

  it("honors a smaller maxLevels", function () {
    var c = chain(5);
    fs.writeFileSync(path.join(c.levels[1], FILE), "x"); // 3 levels up from l4
    expect(
      findEnvFileUpward({
        fileName: FILE,
        startDir: c.deepest,
        homeDir: "",
        maxLevels: 2,
      }),
    ).toBeNull();
    expect(
      findEnvFileUpward({
        fileName: FILE,
        startDir: c.deepest,
        homeDir: "",
        maxLevels: 3,
      }),
    ).toBe(path.join(c.levels[1], FILE));
  });

  it("never looks in startDir itself", function () {
    var c = chain(2);
    fs.writeFileSync(path.join(c.deepest, FILE), "x");
    expect(
      findEnvFileUpward({ fileName: FILE, startDir: c.deepest, homeDir: "" }),
    ).toBeNull();
  });

  it("returns null for bad input instead of throwing", function () {
    expect(findEnvFileUpward({ fileName: "", startDir: root })).toBeNull();
    expect(
      findEnvFileUpward({ fileName: path.join("a", FILE), startDir: root }),
    ).toBeNull();
    expect(findEnvFileUpward({ fileName: "..", startDir: root })).toBeNull();
    expect(findEnvFileUpward({ fileName: FILE, startDir: "" })).toBeNull();
    expect(
      findEnvFileUpward(
        null as unknown as { fileName: string; startDir: string },
      ),
    ).toBeNull();
  });
});
