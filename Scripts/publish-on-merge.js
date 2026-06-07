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

/** True when npm can resolve this exact package spec from the public registry. */
function npmSpecResolves(name, range) {
  return captureSafe("npm", ["view", name + "@" + range, "version"], { stdio: ["ignore", "pipe", "ignore"] }) !== null;
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

/**
 * Pin a package's workspace dependency ranges to the versions published so far
 * in this run (the cascade step). Returns true if any range moved. When write
 * is false the computation runs without touching disk (dry-run preview).
 */
function pinPublishedDeps(pkg, publishedVersions, write) {
  const manifest = JSON.parse(fs.readFileSync(pkg.manifestPath, "utf8"));
  const groups = ["dependencies", "devDependencies", "peerDependencies"];
  let changed = false;
  for (let g = 0; g < groups.length; g++) {
    const group = manifest[groups[g]];
    if (!group) {
      continue;
    }
    const names = Object.keys(group);
    for (let n = 0; n < names.length; n++) {
      const name = names[n];
      if (Object.prototype.hasOwnProperty.call(publishedVersions, name)) {
        const next = ws.applyRangePrefix(group[name], publishedVersions[name]);
        if (next !== group[name]) {
          group[name] = next;
          changed = true;
        }
      }
    }
  }
  if (changed && write) {
    fs.writeFileSync(pkg.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    pkg.manifest = manifest;
  }
  return changed;
}

/**
 * Runtime internal dependencies must be installable before publishing a
 * consumer package. A dependency is OK if this run already published it, or if
 * the current manifest range resolves from npm. Otherwise the package would
 * publish successfully but fail for clean npm consumers with E404/ETARGET.
 */
function unresolvedRuntimeInternalDeps(pkg, publishedVersions) {
  const deps = pkg.manifest.dependencies || {};
  const names = Object.keys(deps);
  const unresolved = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name.indexOf("@tenonhq/dovetail-") !== 0) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(publishedVersions, name)) {
      continue;
    }
    if (!npmSpecResolves(name, deps[name])) {
      unresolved.push(name + "@" + deps[name]);
    }
  }
  return unresolved;
}

// ---------------------------------------------------------------------------
// release manifest (downstream knowledge sync)
// ---------------------------------------------------------------------------
//
// Emits a deterministic record of what shipped so downstream consumer repos
// (CTO, ServiceNow, ...) can detect undocumented Dovetail releases via
// `dove knowledge-diff`. Two outputs:
//   - release-events/<event_id>.json      append-only repo history (source of truth)
//   - packages/core/release-manifest.json aggregate window bundled into the
//     dove-core tarball, so a fresh `npm install` carries recent release events.
// NOTE: the aggregate is written AFTER publish, so it ships in the NEXT core
// publish (a one-publish lag for core itself); the repo feed is always current.
// Best-effort: a failure here never fails a publish whose packages shipped.

const MANIFEST_WINDOW = 50;

function semverBump(prev, version) {
  if (!prev) return "initial";
  const a = String(prev).split(".").map(Number);
  const b = String(version).split(".").map(Number);
  if ((b[0] || 0) !== (a[0] || 0)) return "major";
  if ((b[1] || 0) !== (a[1] || 0)) return "minor";
  return "patch";
}

function commitsForPackage(dirName, prevTag, fallbackBase, head) {
  let from = "";
  if (prevTag && captureSafe("git", ["rev-parse", "--verify", prevTag + "^{commit}"]) !== null) {
    from = prevTag;
  } else if (fallbackBase) {
    from = fallbackBase;
  }
  const spec = from ? from + ".." + head : head;
  const out = captureSafe("git", ["log", spec, "-n", "50", "--format=%H%x09%s", "--", "packages/" + dirName]);
  if (!out) {
    return [];
  }
  return out.split("\n").filter(Boolean).map(function (line) {
    const tab = line.indexOf("\t");
    const sha = tab >= 0 ? line.slice(0, tab) : line;
    const subject = tab >= 0 ? line.slice(tab + 1) : "";
    const prMatch = subject.match(/\(#(\d+)\)/) || subject.match(/#(\d+)/);
    const commit = { sha: sha.slice(0, 9), subject: subject };
    if (prMatch) {
      commit.pr = parseInt(prMatch[1], 10);
    }
    return commit;
  });
}

function buildReleaseEvents(published, range, headSha) {
  const now = new Date().toISOString();
  return published.map(function (p) {
    const tag = unscoped(p.name) + "@" + p.version;
    const prev = p.prevVersion ? p.prevVersion : null;
    const prevTag = prev ? unscoped(p.name) + "@" + prev : "";
    return {
      $schema: "dovetail-release-event/v1",
      event_id: tag,
      package: p.name,
      version: p.version,
      prev_version: prev,
      published_at: now,
      git: { sha: headSha, tag: tag },
      semver_bump: semverBump(prev, p.version),
      commits: commitsForPackage(p.dirName, prevTag, range.base, headSha),
      exports_delta: null,
      narrative: null,
    };
  });
}

/** Write the per-event feed + refresh the bundled aggregate. Returns repo-relative paths written. */
function emitReleaseManifest(published, range, headSha) {
  const written = [];
  try {
    const events = buildReleaseEvents(published, range, headSha);
    const feedDir = ws.REPO_ROOT + "/release-events";
    if (!fs.existsSync(feedDir)) {
      fs.mkdirSync(feedDir, { recursive: true });
    }
    for (let i = 0; i < events.length; i++) {
      const rel = "release-events/" + events[i].event_id + ".json";
      fs.writeFileSync(ws.REPO_ROOT + "/" + rel, JSON.stringify(events[i], null, 2) + "\n");
      written.push(rel);
    }
    const aggRel = "packages/core/release-manifest.json";
    const aggPath = ws.REPO_ROOT + "/" + aggRel;
    let existingEvents = [];
    if (fs.existsSync(aggPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(aggPath, "utf8"));
        existingEvents = parsed && parsed.events ? parsed.events : [];
      } catch (e) {
        existingEvents = [];
      }
    }
    const seen = {};
    const merged = [];
    const all = events.concat(existingEvents);
    for (let i = 0; i < all.length; i++) {
      const ev = all[i];
      if (ev && ev.event_id && seen[ev.event_id] !== true) {
        seen[ev.event_id] = true;
        merged.push(ev);
      }
    }
    const aggregate = {
      $schema: "dovetail-manifest/v1",
      generated_at: new Date().toISOString(),
      events: merged.slice(0, MANIFEST_WINDOW),
    };
    fs.writeFileSync(aggPath, JSON.stringify(aggregate, null, 2) + "\n");
    written.push(aggRel);
    console.log("  emitted " + events.length + " release-event(s); refreshed " + aggRel);
  } catch (err) {
    console.warn("  release-manifest emit failed (non-fatal): " + (err && err.message ? err.message : err));
    return [];
  }
  return written;
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
function commitVersionBumps(published, extraFiles) {
  console.log("\nRefreshing lockfile and committing version bumps...");
  run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);

  const files = ["package-lock.json"];
  for (let i = 0; i < published.length; i++) {
    files.push("packages/" + published[i].dirName + "/package.json");
  }
  if (extraFiles) {
    for (let i = 0; i < extraFiles.length; i++) {
      files.push(extraFiles[i]);
    }
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
  const allPackages = ws.listPackages();
  // Cascade: a changed package drags every (transitive) dependent into the
  // publish set, so consumers re-pin to the version just shipped instead of
  // staying frozen on an exact ^0.0.x pin.
  const cascadeDirs = ws.dependentsClosure(changedDirs, allPackages);
  const toPublish = ws.toposort(allPackages).filter(function (pkg) {
    return cascadeDirs[pkg.dirName] === true && pkg.isPrivate === false;
  });

  if (toPublish.length === 0) {
    console.log("\nNo publishable package changes detected. Nothing to do.");
    return 0;
  }

  console.log("\nPackages to publish (dependency order):");
  for (let i = 0; i < toPublish.length; i++) {
    const tag = changedDirs[toPublish[i].dirName] === true ? "changed" : "cascade";
    console.log("  - " + toPublish[i].name + "  [" + tag + "]");
  }

  const published = [];
  const failed = [];
  const publishedVersions = {}; // name -> version shipped this run, for cascade pinning

  console.log("");
  for (let i = 0; i < toPublish.length; i++) {
    const pkg = toPublish[i];
    const isDirect = changedDirs[pkg.dirName] === true;

    // Re-pin this package's workspace deps to anything already published this
    // run. In dry-run we compute the would-change flag without writing.
    const depsRepinned = pinPublishedDeps(pkg, publishedVersions, !args.dryRun);

    // A cascade-only package whose pinned ranges did not actually move needs
    // no republish (e.g. it floats, or a dependency publish failed upstream).
    if (!isDirect && !depsRepinned) {
      console.log("• " + pkg.name + "  — no dependency range moved, skipping");
      continue;
    }

    const prevVersion = npmPublishedVersion(pkg.name);
    const version = resolvePublishVersion(pkg);
    const reason = isDirect ? "changed" : "cascade";
    console.log("▶ " + pkg.name + "  source=" + pkg.version + "  ->  publish " + version + "  [" + reason + "]");

    if (args.dryRun) {
      published.push({ name: pkg.name, dirName: pkg.dirName, version: version, prevVersion: prevVersion });
      publishedVersions[pkg.name] = version;
      continue;
    }

    if (version !== pkg.version) {
      console.log("  reconciled " + pkg.version + " -> " + version + " (npm registry was ahead)");
      writeVersion(pkg, version);
    }
    try {
      const unresolved = unresolvedRuntimeInternalDeps(pkg, publishedVersions);
      if (unresolved.length > 0) {
        throw new Error("runtime internal dependency is not available from npm: " + unresolved.join(", "));
      }
      run("npm", ["publish", "--access", "public"], { cwd: pkg.dir });
      published.push({ name: pkg.name, dirName: pkg.dirName, version: version, prevVersion: prevVersion });
      publishedVersions[pkg.name] = version;
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
    const previewEvents = buildReleaseEvents(published, range, range.head);
    console.log(
      "[dry-run] would emit " + previewEvents.length + " release-event(s) -> release-events/ + refresh packages/core/release-manifest.json:",
    );
    for (let i = 0; i < previewEvents.length; i++) {
      const ev = previewEvents[i];
      console.log("  - " + ev.event_id + " (" + ev.semver_bump + ", " + ev.commits.length + " commit(s))");
    }
  } else if (published.length > 0) {
    const manifestFiles = emitReleaseManifest(published, range, range.head);
    commitVersionBumps(published, manifestFiles);
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
