#!/usr/bin/env node
"use strict";

/**
 * Dovetail release orchestrator — runs on every merge to the default branch.
 *
 *   1. Diffs the merge to find which packages/* directories changed.
 *   2. Publishes each changed, non-private package to npm. The published
 *      version is max(package.json version, npm-latest + 1 patch), so a
 *      concurrent-merge race can never collide with a version that already
 *      exists on the registry.
 *   3. npm's own prepack builds the package before publish; the existing
 *      postpublish hook bumps the source package.json to the next patch.
 *   4. Commits the bumped package.json files + refreshed lockfile back to the
 *      branch as one chore(release) commit tagged [skip ci].
 *   5. Creates a git tag + GitHub Release for each published package.
 *
 * Pass --dry-run to print the plan without publishing, committing, or tagging.
 *
 * Usage:
 *   node Scripts/publish-on-merge.js --base=<sha> --head=<sha> [--dry-run]
 *
 * ES6 only — no optional chaining / nullish coalescing (repo standard).
 */

const fs = require("fs");
const cp = require("child_process");
const ws = require("./lib/workspace");

const ZERO_SHA = "0000000000000000000000000000000000000000";
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

/** Run a command, inheriting stdio. Throws on a non-zero exit. */
function run(command, args, options) {
  cp.execFileSync(command, args, Object.assign({ cwd: ws.REPO_ROOT, stdio: "inherit" }, options || {}));
}

/** Run a command and return trimmed stdout. Throws on a non-zero exit. */
function capture(command, args, options) {
  const out = cp.execFileSync(command, args, Object.assign({ cwd: ws.REPO_ROOT, encoding: "utf8" }, options || {}));
  return out.toString().trim();
}

/** Run a command and return trimmed stdout, or null if it fails. */
function captureSafe(command, args, options) {
  try {
    return capture(command, args, options);
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// arguments and change detection
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const result = { base: "", head: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg.indexOf("--base=") === 0) {
      result.base = arg.slice("--base=".length).trim();
    } else if (arg.indexOf("--head=") === 0) {
      result.head = arg.slice("--head=".length).trim();
    }
  }
  return result;
}

/** Resolve the commit range to diff. Returns { base, head }. */
function resolveRange(args) {
  const head = args.head ? args.head : capture("git", ["rev-parse", "HEAD"]);
  let base = args.base;
  if (base === ZERO_SHA) {
    base = "";
  }
  // Drop a base that is not a real commit (force-push, garbage-collected, etc).
  if (base && captureSafe("git", ["cat-file", "-e", base + "^{commit}"]) === null) {
    base = "";
  }
  // No usable base — compare against the first parent of head.
  if (!base) {
    const parent = captureSafe("git", ["rev-parse", head + "^"]);
    base = parent ? parent : "";
  }
  return { base: base, head: head };
}

/** Map of packages/ directory names that changed between base and head. */
function changedPackageDirs(range) {
  if (!range.base) {
    // With no comparison point, publishing nothing is the safe choice.
    return {};
  }
  const out = capture("git", ["diff", "--name-only", range.base, range.head]);
  const dirs = {};
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^packages\/([^/]+)\//);
    if (match) {
      dirs[match[1]] = true;
    }
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// publishing
// ---------------------------------------------------------------------------

/** Latest version of a package on the npm registry, or null if unpublished. */
function npmPublishedVersion(name) {
  return captureSafe("npm", ["view", name, "version"], { stdio: ["ignore", "pipe", "ignore"] });
}

/** The version to publish: never at or below npm's latest. */
function resolvePublishVersion(pkg) {
  const published = npmPublishedVersion(pkg.name);
  if (!published) {
    return pkg.version;
  }
  return ws.maxVersion(pkg.version, ws.bumpPatch(published));
}

/** Write a version into a package.json, preserving 2-space JSON formatting. */
function writeVersion(pkg, version) {
  const manifest = JSON.parse(fs.readFileSync(pkg.manifestPath, "utf8"));
  manifest.version = version;
  fs.writeFileSync(pkg.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/** Unscoped npm name, e.g. "@tenonhq/dovetail-core" -> "dovetail-core". */
function unscoped(name) {
  return name.replace(/^@[^/]+\//, "");
}

// ---------------------------------------------------------------------------
// release commit + GitHub releases
// ---------------------------------------------------------------------------

function releaseCommitMessage(published) {
  const body = published
    .map(function (p) { return "- " + p.name + "@" + p.version; })
    .join("\n");
  const subject = published.length === 1
    ? "chore(release): " + published[0].name + "@" + published[0].version + " [skip ci]"
    : "chore(release): publish " + published.length + " packages [skip ci]";
  return subject + "\n\n" + body;
}

/** Commit the version bumps + refreshed lockfile and push them to the branch. */
function commitVersionBumps(published) {
  console.log("\nRefreshing lockfile and committing version bumps...");
  run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);

  const files = ["package-lock.json"];
  for (let i = 0; i < published.length; i++) {
    files.push("packages/" + published[i].dirName + "/package.json");
  }

  const branch = process.env.GITHUB_REF_NAME
    || captureSafe("git", ["rev-parse", "--abbrev-ref", "HEAD"])
    || "main";
  const message = releaseCommitMessage(published);

  run("git", ["config", "user.name", BOT_NAME]);
  run("git", ["config", "user.email", BOT_EMAIL]);

  let pushed = false;
  for (let attempt = 1; attempt <= 3 && !pushed; attempt++) {
    run("git", ["fetch", "origin", branch]);
    // Re-anchor onto the latest branch tip; the working-tree edits are kept,
    // so the commit always lands cleanly without a rebase conflict.
    run("git", ["reset", "--soft", "origin/" + branch]);
    run("git", ["add"].concat(files));
    if (!captureSafe("git", ["diff", "--cached", "--name-only"])) {
      console.log("  nothing to commit");
      pushed = true;
      break;
    }
    run("git", ["commit", "-m", message]);
    try {
      run("git", ["push", "origin", "HEAD:" + branch]);
      pushed = true;
      console.log("  pushed release commit to " + branch);
    } catch (err) {
      console.warn("  push attempt " + attempt + " failed; re-syncing and retrying");
    }
  }
  if (!pushed) {
    throw new Error("Could not push the release commit after 3 attempts.");
  }
}

/** Create a git tag + GitHub Release for each published package. */
function createReleases(published, headSha) {
  console.log("\nCreating GitHub releases...");
  const notesBase = captureSafe("git", ["log", "-1", "--format=%B", headSha]);
  for (let i = 0; i < published.length; i++) {
    const pkg = published[i];
    const tag = unscoped(pkg.name) + "@" + pkg.version;
    if (captureSafe("gh", ["release", "view", tag]) !== null) {
      console.log("  release " + tag + " already exists — skipping");
      continue;
    }
    const notes = "Published `" + pkg.name + "@" + pkg.version + "` to npm.\n\n"
      + (notesBase ? notesBase : "");
    try {
      run("gh", ["release", "create", tag, "--target", headSha, "--title", tag, "--notes", notes]);
      console.log("  created release " + tag);
    } catch (err) {
      // A release-record hiccup must not fail a build whose packages shipped.
      console.warn("  could not create release " + tag + ": " + err.message);
    }
  }
}

function writeStepSummary(published, failed, dryRun) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  let md = "## Dovetail publish" + (dryRun ? " (dry run)" : "") + "\n\n";
  if (published.length === 0) {
    md += "No packages published.\n";
  } else {
    md += "| Package | Version |\n| --- | --- |\n";
    for (let i = 0; i < published.length; i++) {
      md += "| " + published[i].name + " | " + published[i].version + " |\n";
    }
  }
  if (failed.length > 0) {
    md += "\n**Failed:** " + failed.join(", ") + "\n";
  }
  fs.appendFileSync(file, md);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = resolveRange(args);
  console.log("Commit range: " + (range.base ? range.base : "(none)") + " .. " + range.head);
  if (args.dryRun) {
    console.log("DRY RUN — no publish, commit, or release will happen.");
  }

  const changedDirs = changedPackageDirs(range);
  const toPublish = ws.toposort(ws.listPackages()).filter(function (pkg) {
    return changedDirs[pkg.dirName] === true && pkg.isPrivate === false;
  });

  if (toPublish.length === 0) {
    console.log("\nNo publishable package changes detected. Nothing to do.");
    return 0;
  }

  console.log("\nChanged packages to publish (dependency order):");
  for (let i = 0; i < toPublish.length; i++) {
    console.log("  - " + toPublish[i].name);
  }

  const published = [];
  const failed = [];

  console.log("");
  for (let i = 0; i < toPublish.length; i++) {
    const pkg = toPublish[i];
    const version = resolvePublishVersion(pkg);
    console.log("▶ " + pkg.name + "  source=" + pkg.version + "  ->  publish " + version);

    if (args.dryRun) {
      published.push({ name: pkg.name, dirName: pkg.dirName, version: version });
      continue;
    }

    if (version !== pkg.version) {
      console.log("  reconciled " + pkg.version + " -> " + version + " (npm registry was ahead)");
      writeVersion(pkg, version);
    }
    try {
      run("npm", ["publish", "--access", "public"], { cwd: pkg.dir });
      published.push({ name: pkg.name, dirName: pkg.dirName, version: version });
      console.log("  published " + pkg.name + "@" + version + "\n");
    } catch (err) {
      console.error("  FAILED to publish " + pkg.name + ": " + err.message + "\n");
      failed.push(pkg.name);
    }
  }

  if (published.length > 0 && args.dryRun) {
    console.log("\n[dry-run] would commit version bumps and create releases for:");
    for (let i = 0; i < published.length; i++) {
      console.log("  - " + published[i].name + "@" + published[i].version);
    }
  } else if (published.length > 0) {
    commitVersionBumps(published);
    createReleases(published, range.head);
  }

  writeStepSummary(published, failed, args.dryRun);

  if (failed.length > 0) {
    console.error("\nPublish finished with " + failed.length + " failure(s): " + failed.join(", "));
    return 1;
  }
  console.log("\nPublish complete — " + published.length + " package(s).");
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error("\nFATAL: " + (err && err.message ? err.message : err));
  process.exit(1);
}
