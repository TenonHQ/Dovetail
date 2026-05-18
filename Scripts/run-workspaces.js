#!/usr/bin/env node
"use strict";

/**
 * Run an npm script across every workspace package, in dependency order.
 *
 *   node Scripts/run-workspaces.js prepack   # build every package
 *   node Scripts/run-workspaces.js test      # test every package
 *
 * Packages without the named script are skipped. A jest-based "test" script
 * gets --passWithNoTests appended, so a package that has no test files yet
 * counts as a pass instead of blocking the whole release. The process exits
 * non-zero if any package's script fails.
 */

const cp = require("child_process");
const ws = require("./lib/workspace");

function main() {
  const scriptName = process.argv[2];
  if (!scriptName) {
    console.error("Usage: node Scripts/run-workspaces.js <npm-script>");
    process.exit(1);
  }

  const ordered = ws.toposort(ws.listPackages());
  const results = [];

  for (let i = 0; i < ordered.length; i++) {
    const pkg = ordered[i];
    const scriptBody = pkg.scripts[scriptName];
    if (!scriptBody) {
      console.log("· skip  " + pkg.name + "  (no \"" + scriptName + "\" script)");
      continue;
    }

    let command = "npm run " + scriptName;
    // A jest "test" script with no test files exits 1; --passWithNoTests turns
    // an empty package into a pass instead of blocking every other publish.
    if (scriptName === "test" && /\bjest\b/.test(scriptBody)) {
      command += " -- --passWithNoTests";
    }

    console.log("\n▶ " + pkg.name + "  —  " + command);
    try {
      cp.execSync(command, { cwd: pkg.dir, stdio: "inherit" });
      results.push({ name: pkg.name, ok: true });
    } catch (err) {
      results.push({ name: pkg.name, ok: false });
    }
  }

  const failed = results.filter(function (r) { return !r.ok; });
  const passed = results.length - failed.length;
  console.log(
    "\n" + scriptName + " summary: " + passed + " passed, " + failed.length + " failed"
  );
  if (failed.length) {
    console.error(
      "Failed packages: " + failed.map(function (r) { return r.name; }).join(", ")
    );
    process.exit(1);
  }
}

main();
