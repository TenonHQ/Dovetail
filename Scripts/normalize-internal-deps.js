#!/usr/bin/env node
"use strict";

/**
 * Normalize and guard internal @tenonhq/dovetail-* dependency ranges.
 *
 * WHY THIS EXISTS
 * ---------------
 * For a pre-1.0 (0.0.x) version, npm treats `^0.0.x` as a HARD PIN to exactly
 * that patch: `^0.0.10` resolves to `>=0.0.10 <0.0.11` — i.e. 0.0.10 only. So a
 * caret range on an internal dependency silently freezes a consumer onto one
 * patch. The moment a newer patch of that dependency ships, the consumer cannot
 * adopt it without an `overrides` block, and a `peerDependencies` caret pin
 * triggers an `ERESOLVE` install failure (forcing `--legacy-peer-deps`). That is
 * the exact defect this script removes.
 *
 * `~0.0.x` is the floating form: `~0.0.10` resolves to `>=0.0.10 <0.1.0`, which
 * admits every later 0.0.* patch (but not a deliberate 0.1.0 minor bump). So a
 * consumer adopts a dependency's later patches with no override and no ERESOLVE.
 *
 * This file is BOTH the one-time remediation and the standing CI guard:
 *
 *   --check   (default, OFFLINE)  Structurally validate that every internal
 *             range is the floating ~0.0.x form. Exit 1 on any violation. No
 *             network — deterministic and fast, safe to run on every CI build.
 *
 *   --write   (npm-aware)         Rewrite every violating internal range to
 *             `~<floor>` where floor = min(npmPublishedVersion, sourceVersion):
 *             the version provably on the registry today. Source runs one patch
 *             ahead of npm (the postpublish-bump invariant), so anchoring the
 *             floor to the source version would demand a sibling patch that is
 *             not yet published and re-break installs. min() is correct in both
 *             directions. Re-checks itself after writing.
 *
 * Scope: every workspace package under packages/* AND the repo-root manifest
 * (which also carries an internal dep). Private packages are checked too — they
 * are never published, but they still consume internal deps and must follow the
 * same rule so the monorepo build resolves to the local workspace copies.
 *
 * ES6 only — no optional chaining / nullish coalescing (repo standard, mirrors
 * Scripts/lib/workspace.js).
 */

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const ws = require("./lib/workspace");

const INTERNAL_PREFIX = "@tenonhq/dovetail-";
const GROUPS = ["dependencies", "devDependencies", "peerDependencies"];

// The only two acceptable forms for an internal range. Both float across the
// whole 0.0.* series and stop before a deliberate 0.1.0 minor bump.
const ACCEPT_TILDE = /^~0\.0\.\d+$/;
const ACCEPT_COMPOUND = /^>=0\.0\.\d+ <0\.1\.0$/;

/** True when a dependency name is one of our own monorepo packages. */
function isInternalDep(name) {
  return name.indexOf(INTERNAL_PREFIX) === 0;
}

/**
 * Classify a single range string. Default-deny: only the two accepted floating
 * forms pass; everything else (including novel/unknown forms) fails CLOSED with
 * a reason. This is the structural guard — no network, no version lookups.
 *
 * @returns {{ok: true}} or {{ok: false, reason: string}}
 */
function classifyRange(range) {
  const text = String(range).trim();
  if (ACCEPT_TILDE.test(text) || ACCEPT_COMPOUND.test(text)) {
    return { ok: true };
  }
  if (/^\^0\.0\.\d+$/.test(text)) {
    return { ok: false, reason: "caret on 0.0.x is a hard pin (admits one patch only), not a float" };
  }
  if (text === "*" || text === "x" || text === "") {
    return { ok: false, reason: "wildcard admits future majors; pin to ~0.0.x" };
  }
  if (/^\d+\.\d+\.\d+$/.test(text)) {
    return { ok: false, reason: "exact pin blocks patch float" };
  }
  if (/^\^/.test(text)) {
    return { ok: false, reason: "caret range; internal deps must use ~0.0.x" };
  }
  if (/^~/.test(text)) {
    return { ok: false, reason: "tilde floor must be ~0.0.x (internal deps are pre-0.1.0)" };
  }
  if (/^>=/.test(text) && !/[<]/.test(text)) {
    return { ok: false, reason: "open upper bound admits future majors" };
  }
  if (text.indexOf("-") >= 0) {
    return { ok: false, reason: "prerelease pin" };
  }
  if (/^(workspace:|file:|link:|git\+|https?:|latest$|next$|dev$)/.test(text)) {
    return { ok: false, reason: "non-registry or unpinned spec" };
  }
  return { ok: false, reason: "unrecognized / disallowed range form" };
}

/**
 * Collect every manifest to scan: all workspace packages plus the repo root.
 * @returns {Array<{name: string, manifestPath: string, manifest: Object, version: string, label: string}>}
 */
function collectManifests() {
  const list = [];
  const packages = ws.listPackages();
  for (let i = 0; i < packages.length; i++) {
    const p = packages[i];
    list.push({ name: p.name, manifestPath: p.manifestPath, manifest: p.manifest, version: p.version, label: p.dirName });
  }
  const rootPath = path.join(ws.REPO_ROOT, "package.json");
  if (fs.existsSync(rootPath)) {
    const rootManifest = JSON.parse(fs.readFileSync(rootPath, "utf8"));
    list.push({ name: rootManifest.name, manifestPath: rootPath, manifest: rootManifest, version: rootManifest.version, label: "(root) " + rootManifest.name });
  }
  return list;
}

/** Map of internal package name -> local source version, from the workspace. */
function sourceVersionsByName() {
  const byName = {};
  const packages = ws.listPackages();
  for (let i = 0; i < packages.length; i++) {
    byName[packages[i].name] = packages[i].version;
  }
  return byName;
}

/** Every internal edge across all manifests. Read-only — no network. */
function collectEdges() {
  const edges = [];
  const manifests = collectManifests();
  for (let m = 0; m < manifests.length; m++) {
    const entry = manifests[m];
    for (let g = 0; g < GROUPS.length; g++) {
      const group = entry.manifest[GROUPS[g]];
      if (!group) {
        continue;
      }
      const names = Object.keys(group);
      for (let n = 0; n < names.length; n++) {
        const depName = names[n];
        if (!isInternalDep(depName)) {
          continue;
        }
        edges.push({
          pkg: entry.name,
          label: entry.label,
          manifestPath: entry.manifestPath,
          group: GROUPS[g],
          depName: depName,
          range: group[depName]
        });
      }
    }
  }
  return edges;
}

/** The latest version of a package on the npm registry, or null. (Network.) */
function npmPublishedVersion(name) {
  try {
    const out = cp.execFileSync("npm", ["view", name, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const v = out.toString().trim();
    return v ? v : null;
  } catch (err) {
    return null;
  }
}

/**
 * The floating range to write for a dependency.
 * floor = min(npmLatest, sourceVersion) — the version provably on npm today.
 * npmLatest is injectable so the unit tests stay offline.
 */
function computeFloor(depName, sourceVersion, npmLatest) {
  let floor;
  if (!npmLatest && !sourceVersion) {
    throw new Error("No version available to anchor a floor for " + depName);
  } else if (!npmLatest) {
    floor = sourceVersion;
  } else if (!sourceVersion) {
    floor = npmLatest;
  } else {
    floor = ws.compareVersions(npmLatest, sourceVersion) <= 0 ? npmLatest : sourceVersion;
  }
  return "~" + floor;
}

/** --check (offline). Returns the list of violations and prints a report. */
function runCheck() {
  const edges = collectEdges();
  const violations = [];
  for (let i = 0; i < edges.length; i++) {
    const verdict = classifyRange(edges[i].range);
    if (!verdict.ok) {
      violations.push({ edge: edges[i], reason: verdict.reason });
    }
  }
  if (violations.length === 0) {
    console.log("OK: " + edges.length + " internal @tenonhq/dovetail-* edge(s), all floating ~0.0.x.");
    return violations;
  }
  console.error("FAIL: " + violations.length + " internal dependency range(s) are not the floating ~0.0.x form:\n");
  for (let i = 0; i < violations.length; i++) {
    const v = violations[i];
    console.error("  " + v.edge.label + "  [" + v.edge.group + "]  " + v.edge.depName + " : \"" + v.edge.range + "\"  -> " + v.reason);
  }
  console.error("\nWhy this matters: ^0.0.x is a hard pin on a pre-1.0 package, so consumers cannot");
  console.error("adopt newer patches without an overrides block / --legacy-peer-deps (ERESOLVE).");
  console.error("Fix: run  node Scripts/normalize-internal-deps.js --write");
  return violations;
}

/** --write (npm-aware). Rewrites violating ranges, then re-checks. */
function runWrite() {
  const edges = collectEdges();
  const sourceVersions = sourceVersionsByName();
  const floorCache = {}; // depName -> "~floor"
  const changesByPath = {}; // manifestPath -> true (touched)
  let changed = 0;

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (classifyRange(edge.range).ok) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(floorCache, edge.depName)) {
      const npmLatest = npmPublishedVersion(edge.depName);
      const src = sourceVersions[edge.depName];
      if (!npmLatest) {
        console.warn("  warn: " + edge.depName + " is not on npm; anchoring floor to the local source version " + src);
      }
      floorCache[edge.depName] = computeFloor(edge.depName, src, npmLatest);
    }
    const next = floorCache[edge.depName];

    // Read-modify-write the manifest fresh so multiple edges in one file each
    // land, and key order + 2-space indent + trailing newline are preserved.
    const manifest = JSON.parse(fs.readFileSync(edge.manifestPath, "utf8"));
    manifest[edge.group][edge.depName] = next;
    fs.writeFileSync(edge.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    changesByPath[edge.manifestPath] = true;
    changed++;
    console.log("  " + edge.label + "  [" + edge.group + "]  " + edge.depName + " : \"" + edge.range + "\" -> \"" + next + "\"");
  }

  const touched = Object.keys(changesByPath).length;
  if (changed === 0) {
    console.log("Nothing to rewrite — all internal ranges are already floating ~0.0.x.");
  } else {
    console.log("\nRewrote " + changed + " range(s) across " + touched + " manifest(s).");
  }

  // Self-verify: a write must leave the tree clean.
  console.log("");
  const remaining = runCheck();
  if (remaining.length > 0) {
    throw new Error("Post-write check still found " + remaining.length + " violation(s).");
  }
  return changed;
}

/** CLI entry. */
function run(argv) {
  const args = argv || [];
  const write = args.indexOf("--write") >= 0;
  if (write) {
    const n = runWrite();
    return 0;
  }
  const violations = runCheck();
  return violations.length > 0 ? 1 : 0;
}

module.exports = {
  isInternalDep: isInternalDep,
  classifyRange: classifyRange,
  computeFloor: computeFloor,
  collectEdges: collectEdges,
  collectManifests: collectManifests,
  npmPublishedVersion: npmPublishedVersion,
  GROUPS: GROUPS,
  run: run
};

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
