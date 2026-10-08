import { execFile } from "child_process";

// A full object id: SHA-1 (40 hex) or SHA-256 (64 hex) repositories.
var OBJECT_ID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * @description Resolves the commit HEAD points at for the git work tree that
 * contains `dir` (`git rev-parse HEAD`, so linked worktrees and submodules
 * resolve correctly). Never throws: resolves `null` when `dir` is not inside a
 * git work tree, the repo has no commits yet, git is not installed, or the
 * output is not an object id.
 * @param {string} dir - Any directory inside the work tree.
 * @returns {Promise<string | null>} The HEAD commit id, or null when unknown.
 */
export function readGitHead(dir: string): Promise<string | null> {
  return new Promise(function (resolve) {
    if (typeof dir !== "string" || dir.trim() === "") {
      resolve(null);
      return;
    }
    try {
      execFile(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: dir, timeout: 5000, windowsHide: true },
        function (error, stdout) {
          if (error) {
            resolve(null);
            return;
          }
          var head = String(stdout || "").trim();
          resolve(OBJECT_ID_PATTERN.test(head) ? head : null);
        },
      );
    } catch (e) {
      resolve(null);
    }
  });
}
