// Tests for the per-command `--env` flag parser (envArg.ts). Covers the flag
// spellings (--env, --env-file, --envFile, -e), `=` and space-separated forms,
// last-wins precedence, absence, and absolute/relative path resolution.

import path from "path";
import { parseEnvArg, resolveEnvArgPath } from "../envArg";

describe("parseEnvArg", function () {
  it("returns undefined when no env flag is present", function () {
    expect(parseEnvArg(["push", "--diff", "main"])).toBeUndefined();
  });

  it("parses --env <path> (space-separated)", function () {
    expect(parseEnvArg(["push", "--env", ".env.prod"])).toBe(".env.prod");
  });

  it("parses --env=<path>", function () {
    expect(parseEnvArg(["status", "--env=../envs/workshop.env"])).toBe(
      "../envs/workshop.env",
    );
  });

  it("parses the -e short alias (space and = forms)", function () {
    expect(parseEnvArg(["status", "-e", ".env.dev"])).toBe(".env.dev");
    expect(parseEnvArg(["status", "-e=.env.dev"])).toBe(".env.dev");
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

  it("ignores a bare --env with no following value", function () {
    expect(parseEnvArg(["push", "--env"])).toBeUndefined();
  });

  it("does not consume the next token when it looks like another flag", function () {
    expect(parseEnvArg(["push", "--env", "--ci"])).toBeUndefined();
  });

  it("treats an empty --env= as absent", function () {
    expect(parseEnvArg(["push", "--env="])).toBeUndefined();
  });
});

describe("resolveEnvArgPath", function () {
  it("returns absolute paths unchanged", function () {
    expect(resolveEnvArgPath("/abs/path/.env", "/cwd")).toBe("/abs/path/.env");
  });

  it("resolves relative paths against the provided cwd", function () {
    expect(resolveEnvArgPath(".env.prod", "/projects/sn")).toBe(
      path.join("/projects/sn", ".env.prod"),
    );
  });
});
