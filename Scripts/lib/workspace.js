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

/**
 * Expand a set of seed package directories to include every workspace package
 * that transitively depends on a seed — the reverse-dependency closure.
 *
 * This is what lets the publisher *cascade*: when package P changes, every
 * package that depends on P (and their dependents, recursively) must also
 * republish so their pinned ranges advance to P's new version. Without this,
 * an internal patch fix is stranded — consumers pin `^0.0.x`, which is an
 * exact pin on a 0.0.x version, so they never resolve the newer release.
 *
 * @param {Object} seedDirs  map of dirName -> true (the directly-changed packages)
 * @param {Array<Object>} packages  all workspace packages (from listPackages)
 * @returns {Object} map of dirName -> true covering seeds + all dependents
 */
function dependentsClosure(seedDirs, packages) {
  const byName = {};
  const byDir = {};
  for (let i = 0; i < packages.length; i++) {
    byName[packages[i].name] = packages[i];
    byDir[packages[i].dirName] = packages[i];
  }
  // Reverse edges: depName -> [packages that depend on it].
  const dependents = {};
  for (let i = 0; i < packages.length; i++) {
    const deps = workspaceDependencies(packages[i], byName);
    for (let d = 0; d < deps.length; d++) {
      if (!dependents[deps[d]]) {
        dependents[deps[d]] = [];
      }
      dependents[deps[d]].push(packages[i]);
    }
  }
  const inSet = {};
  const queue = [];
  const seedNames = Object.keys(seedDirs);
  for (let i = 0; i < seedNames.length; i++) {
    const pkg = byDir[seedNames[i]];
    if (pkg && inSet[pkg.dirName] !== true) {
      inSet[pkg.dirName] = true;
      queue.push(pkg);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    const deps = dependents[current.name] || [];
    for (let d = 0; d < deps.length; d++) {
      if (inSet[deps[d].dirName] !== true) {
        inSet[deps[d].dirName] = true;
        queue.push(deps[d]);
      }
    }
  }
  return inSet;
}

/**
 * Preserve the operator prefix of a semver range and swap in a new version.
 *   "^0.0.9"  -> "^0.0.10"   "0.0.9" -> "0.0.10"   ">=1.2.0" -> ">=0.0.10"
 *
 * Only a *complete* single-operator pin is rewritten. Compound ranges
 * (">=0.0.9 <0.1.0"), hyphen ranges ("0.0.9 - 0.1.0"), prerelease pins, and
 * non-pin specs ("*", "workspace:*", "latest", git/url) are returned unchanged
 * so they are never corrupted — and a range that already admits the new
 * version needs no rewrite anyway. The trailing `$` anchor is what makes a
 * compound range fall through instead of having its first term clobbered.
 */
function applyRangePrefix(oldRange, newVersion) {
  const text = String(oldRange);
  const match = text.match(/^(\^|~|>=|<=|>|<|=)?\s*\d+\.\d+\.\d+$/);
  if (!match) {
    return text;
  }
  const prefix = match[1] ? match[1] : "";
  return prefix + newVersion;
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
  maxVersion: maxVersion,
  dependentsClosure: dependentsClosure,
  applyRangePrefix: applyRangePrefix
};
