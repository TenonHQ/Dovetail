"use strict";

/**
 * Shared workspace helpers for the Dovetail release pipeline.
 *
 * Discovers the packages under packages/*, builds the inter-package
 * dependency graph, topologically sorts it, and provides the small amount
 * of semver math the publish pipeline needs.
 *
 * ES6 only — no optional chaining / nullish coalescing (repo standard).
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

/**
 * Read every packages/* directory that contains a package.json.
 * @returns {Array<Object>} package descriptors
 */
function listPackages() {
  const packages = [];
  const entries = fs.readdirSync(PACKAGES_DIR);
  for (let i = 0; i < entries.length; i++) {
    const dirName = entries[i];
    const dir = path.join(PACKAGES_DIR, dirName);
    const manifestPath = path.join(dir, "package.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    packages.push({
      dirName: dirName,
      dir: dir,
      manifestPath: manifestPath,
      name: manifest.name,
      version: manifest.version,
      isPrivate: manifest.private === true,
      scripts: manifest.scripts || {},
      manifest: manifest
    });
  }
  return packages;
}

/**
 * The workspace packages a given package depends on (runtime + dev + peer),
 * limited to packages that also live in this monorepo.
 */
function workspaceDependencies(pkg, byName) {
  const found = {};
  const groups = [
    pkg.manifest.dependencies,
    pkg.manifest.devDependencies,
    pkg.manifest.peerDependencies
  ];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (!group) {
      continue;
    }
    const names = Object.keys(group);
    for (let n = 0; n < names.length; n++) {
      if (byName[names[n]]) {
        found[names[n]] = true;
      }
    }
  }
  return Object.keys(found);
}

/**
 * Topologically sort packages so a package always appears after every
 * workspace package it depends on. Throws on a dependency cycle.
 */
function toposort(packages) {
  const byName = {};
  for (let i = 0; i < packages.length; i++) {
    byName[packages[i].name] = packages[i];
  }
  // Sort by name first so the result is deterministic run to run.
  const ordered = packages.slice().sort(function (a, b) {
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  const sorted = [];
  const state = {}; // package name -> "visiting" | "done"
  function visit(pkg, trail) {
    if (state[pkg.name] === "done") {
      return;
    }
    if (state[pkg.name] === "visiting") {
      throw new Error(
        "Dependency cycle detected: " + trail.concat(pkg.name).join(" -> ")
      );
    }
    state[pkg.name] = "visiting";
    const deps = workspaceDependencies(pkg, byName);
    for (let d = 0; d < deps.length; d++) {
      visit(byName[deps[d]], trail.concat(pkg.name));
    }
    state[pkg.name] = "done";
    sorted.push(pkg);
  }
  for (let j = 0; j < ordered.length; j++) {
    visit(ordered[j], []);
  }
  return sorted;
}

/** Parse "major.minor.patch" into numbers (any prerelease/build suffix is ignored). */
function parseVersion(version) {
  const core = String(version).split("-")[0].split("+")[0];
  const parts = core.split(".");
  if (parts.length !== 3) {
    throw new Error("Unsupported version format: " + version);
  }
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const patch = parseInt(parts[2], 10);
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    throw new Error("Unsupported version format: " + version);
  }
  return { major: major, minor: minor, patch: patch };
}

/** Compare two versions. Returns negative, 0, or positive. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) {
    return pa.major - pb.major;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor - pb.minor;
  }
  return pa.patch - pb.patch;
}

/** Return the next patch version of the given version. */
function bumpPatch(version) {
  const p = parseVersion(version);
  return p.major + "." + p.minor + "." + (p.patch + 1);
}

/** Return whichever of the two versions is higher (a wins ties). */
function maxVersion(a, b) {
  return compareVersions(a, b) >= 0 ? a : b;
}

module.exports = {
  REPO_ROOT: REPO_ROOT,
  PACKAGES_DIR: PACKAGES_DIR,
  listPackages: listPackages,
  workspaceDependencies: workspaceDependencies,
  toposort: toposort,
  parseVersion: parseVersion,
  compareVersions: compareVersions,
  bumpPatch: bumpPatch,
  maxVersion: maxVersion
};
