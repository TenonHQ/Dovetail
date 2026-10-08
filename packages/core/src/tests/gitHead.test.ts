// readGitHead backs the watcher's branch-switch guard. It must resolve the
// HEAD commit inside a work tree and resolve null (never throw) elsewhere.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readGitHead } from "../gitHead";

describe("readGitHead", function () {
  it("resolves the HEAD commit id inside a git work tree", async function () {
    // This test file lives inside the repository's own work tree.
    var head = await readGitHead(__dirname);
    expect(head).toMatch(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
  });

  it("resolves null outside a git work tree", async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), "dove-githead-"));
    try {
      expect(await readGitHead(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves null for a directory that does not exist", async function () {
    var head = await readGitHead(path.join(os.tmpdir(), "dove-githead-missing-" + Date.now()));
    expect(head).toBeNull();
  });

  it("resolves null for an empty or non-string dir", async function () {
    expect(await readGitHead("")).toBeNull();
    expect(await readGitHead(undefined as unknown as string)).toBeNull();
  });
});
