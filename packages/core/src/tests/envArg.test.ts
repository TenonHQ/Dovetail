// Tests for the per-command `--env` flag parser (envArg.ts). Covers the flag
// spellings (--env, --env-file, --envFile, -e), `=` and space-separated forms,
// last-wins precedence, absence, and resolution of bare instance names,
// explicit env filenames, and relative/absolute paths.

import fs from "fs";
import os from "os";
import path from "path";
import { parseEnvArg, resolveEnvArgPath } from "../envArg";

// The conventional per-instance env-file prefix (`prod` → `<prefix>prod`).
var ENV_PREFIX = ".env.";

describe("parseEnvArg", function () {
  it("returns undefined when no env flag is present", function () {
    expect(parseEnvArg(["push", "--diff", "main"])).toBeUndefined();
  });

  it("parses --env <path> (space-separated)", function () {
    expect(parseEnvArg(["push", "--env", ENV_PREFIX + "prod"])).toBe(ENV_PREFIX + "prod");
  });

  it("parses --env <name> with a bare instance name", function () {
    expect(parseEnvArg(["refresh", "--env", "demo8"])).toBe("demo8");
  });

  it("parses --env=<path>", function () {
    expect(parseEnvArg(["status", "--env=../envs/workshop.env"])).toBe(
      "../envs/workshop.env",
    );
  });

  it("parses --env=<name> with a bare instance name", function () {
    expect(parseEnvArg(["push", "--env=demo8"])).toBe("demo8");
  });

  it("parses the -e short alias (space and = forms)", function () {
    expect(parseEnvArg(["status", "-e", ENV_PREFIX + "dev"])).toBe(ENV_PREFIX + "dev");
    expect(parseEnvArg(["status", "-e=" + ENV_PREFIX + "dev"])).toBe(ENV_PREFIX + "dev");
  });

  it("parses --env-file and --envFile spellings", function () {
    expect(parseEnvArg(["push", "--env-file", "a.env"])).toBe("a.env");
    expect(parseEnvArg(["push", "--envFile", "b.env"])).toBe("b.env");
  });

  it("takes the last occurrence when the flag is repeated", function () {
    expect(parseEnvArg(["push", "--env", "first.env", "--env", "second.env"])).toBe(
      "second.env",
    );
  });

  it("takes the last occurrence across mixed forms and spellings", function () {
    expect(parseEnvArg(["push", "--env=shop", "-e", "studio", "--env-file", "loft"])).toBe(
      "loft",
    );
    expect(parseEnvArg(["push", "-e", "studio", "--env=shop"])).toBe("shop");
  });

  it("ignores a bare --env with no following value", function () {
    expect(parseEnvArg(["push", "--env"])).toBeUndefined();
  });

  it("does not consume the next token when it looks like another flag", function () {
    expect(parseEnvArg(["push", "--env", "--ci"])).toBeUndefined();
  });

  it("treats an empty or whitespace-only --env= as absent", function () {
    expect(parseEnvArg(["push", "--env="])).toBeUndefined();
    expect(parseEnvArg(["push", "--env=   "])).toBeUndefined();
  });

  it("returns undefined for a non-array argv", function () {
    expect(parseEnvArg(undefined as unknown as string[])).toBeUndefined();
  });
});

describe("resolveEnvArgPath", function () {
  var tmpDir: string;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dove-envarg-"));
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns absolute paths unchanged", function () {
    var abs = path.join(tmpDir, "abs", ENV_PREFIX + "prod");
    expect(resolveEnvArgPath(abs, "/cwd")).toBe(abs);
  });

  it("resolves an absolute path that has no dot as a path, not a bare name", function () {
    var abs = path.join(tmpDir, "creds");
    expect(resolveEnvArgPath(abs, "/cwd")).toBe(abs);
  });

  it("resolves relative paths against the provided cwd", function () {
    expect(resolveEnvArgPath("../envs/workshop.env", path.join(tmpDir, "repo"))).toBe(
      path.join(tmpDir, "envs", "workshop.env"),
    );
  });

  it("treats a relative path without a dot in the basename as a path", function () {
    expect(resolveEnvArgPath(path.join("envs", "prod"), tmpDir)).toBe(
      path.join(tmpDir, "envs", "prod"),
    );
  });

  it("uses an explicit env filename as-is (the file need not exist)", function () {
    expect(resolveEnvArgPath(ENV_PREFIX + "prod", tmpDir)).toBe(
      path.join(tmpDir, ENV_PREFIX + "prod"),
    );
  });

  it("uses a dotted filename as-is even when it does not exist yet (dove login creates it)", function () {
    expect(resolveEnvArgPath("workshop.env", tmpDir)).toBe(path.join(tmpDir, "workshop.env"));
  });

  it("expands a bare instance name to the per-instance env file in cwd", function () {
    expect(resolveEnvArgPath("demo8", tmpDir)).toBe(path.join(tmpDir, ENV_PREFIX + "demo8"));
  });

  it("expands a bare name whether or not the target file exists", function () {
    var target = path.join(tmpDir, ENV_PREFIX + "loft");
    fs.writeFileSync(target, "");
    expect(resolveEnvArgPath("loft", tmpDir)).toBe(target);
  });

  it("prefers an existing literal file in cwd over bare-name expansion", function () {
    var literal = path.join(tmpDir, "shop");
    fs.writeFileSync(literal, "");
    expect(resolveEnvArgPath("shop", tmpDir)).toBe(literal);
  });

  it("does not treat a same-named directory as an existing literal file", function () {
    fs.mkdirSync(path.join(tmpDir, "studio"));
    expect(resolveEnvArgPath("studio", tmpDir)).toBe(path.join(tmpDir, ENV_PREFIX + "studio"));
  });

  it("trims surrounding whitespace before resolving", function () {
    expect(resolveEnvArgPath("  demo8  ", tmpDir)).toBe(path.join(tmpDir, ENV_PREFIX + "demo8"));
  });

  it("resolves a bare name parsed from the --env= form end to end", function () {
    var raw = parseEnvArg(["refresh", "--env=demo8"]);
    expect(raw).toBe("demo8");
    expect(resolveEnvArgPath(raw as string, tmpDir)).toBe(path.join(tmpDir, ENV_PREFIX + "demo8"));
  });

  it("resolves the last-wins selection end to end", function () {
    var raw = parseEnvArg(["push", "--env", ENV_PREFIX + "prod", "-e", "demo8"]);
    expect(resolveEnvArgPath(raw as string, tmpDir)).toBe(path.join(tmpDir, ENV_PREFIX + "demo8"));
  });

  it("defaults to process.cwd() when no cwd is given", function () {
    expect(resolveEnvArgPath("demo8")).toBe(path.resolve(process.cwd(), ENV_PREFIX + "demo8"));
  });

  it("throws on an empty or non-string selector", function () {
    expect(function () {
      resolveEnvArgPath("", tmpDir);
    }).toThrow(/non-empty/);
    expect(function () {
      resolveEnvArgPath("   ", tmpDir);
    }).toThrow(/non-empty/);
    expect(function () {
      resolveEnvArgPath(undefined as unknown as string, tmpDir);
    }).toThrow(/non-empty/);
  });
});
