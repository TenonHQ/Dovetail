// Tests that `dove`'s init() wires the bare-name walk-up end to end: a
// `--env <name>` with no file in cwd selects the parent directory's file,
// loads it, and prints only the chosen path to stderr (never stdout, never
// anything from the file). Every file here is a fake, created in a temp
// directory at runtime.

// --- Mock setup (must be before imports) ---
//
// init() boots the CLI parser, which under Jest would see jest's argv; stub it
// (same as cred.test.ts). Config loading is stubbed to a pass-through so the
// test is about the --env override, not dove.config.js discovery.
jest.mock("../commander", () => ({ initCommands: jest.fn() }));
jest.mock("../config", () => {
  var actual = jest.requireActual<typeof import("../config")>("../config");
  var override: string | undefined;
  return Object.assign({}, actual, {
    setEnvPathOverride: jest.fn(function (p: string) {
      override = p;
    }),
    loadConfigs: jest.fn(function () {
      return Promise.resolve();
    }),
    getEnvPath: jest.fn(function () {
      if (override === undefined) throw new Error("no override");
      return override;
    }),
  });
});

// --- Imports (after mocks) ---

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { init } from "../bootstrap";
import * as ConfigManager from "../config";

var ENV_PREFIX = ".env.";
var FAKE_CONTENT =
  "SN_INSTANCE=fakebootwalkup\nSN_USER=fakeuser\nSN_PASSWORD=fakepass-not-real\n";

describe("init() — --env bare name found in a parent directory", function () {
  var root: string;
  var savedCwd: string;
  var savedArgv: string[];
  var savedKeys = ["SN_INSTANCE", "SN_USER", "SN_PASSWORD"];
  var savedEnv: Record<string, string | undefined> = {};

  beforeEach(function () {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "dove-boot-walkup-")),
    );
    savedCwd = process.cwd();
    savedArgv = process.argv;
    savedKeys.forEach(function (k) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(function () {
    process.chdir(savedCwd);
    process.argv = savedArgv;
    savedKeys.forEach(function (k) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("selects and loads the parent file and logs only its path to stderr", async function () {
    // A random name, so the walk above the temp root can never hit a stray file.
    var name = "bootwalkup" + crypto.randomBytes(6).toString("hex");
    var nested = path.join(root, "wt", "pkg");
    fs.mkdirSync(nested, { recursive: true });
    var target = path.join(root, ENV_PREFIX + name);
    fs.writeFileSync(target, FAKE_CONTENT);
    process.chdir(nested);
    process.argv = ["node", "dove", "status", "--env", name];

    var errOut: string[] = [];
    var stdOut: string[] = [];
    var errSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(function (chunk: string | Uint8Array) {
        errOut.push(String(chunk));
        return true;
      });
    var outSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(function (chunk: string | Uint8Array) {
        stdOut.push(String(chunk));
        return true;
      });
    try {
      await init();
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
    }

    expect(ConfigManager.setEnvPathOverride).toHaveBeenCalledWith(target);
    expect(process.env.SN_INSTANCE).toBe("fakebootwalkup");
    var err = errOut.join("");
    expect(err).toContain("dove: --env " + name + ": using " + target);
    expect(err).toContain("found in a parent directory");
    expect(err).not.toContain("fakepass-not-real");
    expect(stdOut.join("")).not.toContain(target);
  });

  it("prints nothing when the file is in cwd", async function () {
    var name = "bootwalkup" + crypto.randomBytes(6).toString("hex");
    var target = path.join(root, ENV_PREFIX + name);
    fs.writeFileSync(target, FAKE_CONTENT);
    process.chdir(root);
    process.argv = ["node", "dove", "status", "--env", name];

    var errOut: string[] = [];
    var errSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(function (chunk: string | Uint8Array) {
        errOut.push(String(chunk));
        return true;
      });
    try {
      await init();
    } finally {
      errSpy.mockRestore();
    }

    expect(ConfigManager.setEnvPathOverride).toHaveBeenLastCalledWith(target);
    expect(errOut.join("")).not.toContain("found in a parent directory");
  });
});
