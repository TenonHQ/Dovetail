"use strict";

/**
 * Field-level package.json deltas for the release commit.
 *
 * The publisher edits only two kinds of manifest fields during a run: the
 * `version` (reconcile + postpublish bump) and internal dependency ranges (the
 * cascade re-pin). The release commit must carry exactly those edits onto the
 * LATEST branch tip — never the whole file from the run's checkout, which is
 * stale whenever another PR merged while the run was publishing. Staging the
 * stale file is how #268's sanitize-html bump was silently reverted by the
 * #238 release commit (b46e30a).
 *
 * Pure functions only — no git, no filesystem — so they are unit-testable.
 * ES6 only — no optional chaining / nullish coalescing (repo standard).
 */

const ws = require("./workspace");

const DEP_GROUPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fields that changed between the manifest at the run's checkout (`before`)
 * and the manifest after publishing (`after`). Keys removed by the run are not
 * tracked — the publisher never removes keys.
 * Returns { version: string|null, deps: { group: { name: range } } }.
 */
function manifestDelta(before, after) {
  const prev = isObject(before) ? before : {};
  const next = isObject(after) ? after : {};
  const delta = { version: null, deps: {} };
  if (typeof next.version === "string" && next.version !== prev.version) {
    delta.version = next.version;
  }
  for (let g = 0; g < DEP_GROUPS.length; g++) {
    const group = DEP_GROUPS[g];
    const nextGroup = isObject(next[group]) ? next[group] : {};
    const prevGroup = isObject(prev[group]) ? prev[group] : {};
    const names = Object.keys(nextGroup);
    for (let n = 0; n < names.length; n++) {
      const name = names[n];
      if (nextGroup[name] !== prevGroup[name]) {
        if (!delta.deps[group]) {
          delta.deps[group] = {};
        }
        delta.deps[group][name] = nextGroup[name];
      }
    }
  }
  return delta;
}

function isEmptyDelta(delta) {
  return !delta || (delta.version === null && Object.keys(delta.deps || {}).length === 0);
}

/** The x.y.z a single-operator range pins ("~0.0.14" -> "0.0.14"), else null. */
function pinnedVersion(range) {
  const match = String(range).match(/^(?:\^|~|>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)$/);
  return match ? match[1] : null;
}

/** True when version `a` is strictly higher than `b`; false if either is unparsable. */
function isHigher(a, b) {
  try {
    return ws.compareVersions(a, b) > 0;
  } catch (err) {
    return false;
  }
}

/**
 * Apply a delta onto the tip's manifest, returning a new object. Everything
 * the delta does not name is kept from the tip, so concurrent merges survive.
 * Where the tip already moved a field the delta also touches, the higher
 * version wins — a release commit never downgrades a version or a pin.
 */
function applyManifestDelta(tip, delta) {
  const result = JSON.parse(JSON.stringify(isObject(tip) ? tip : {}));
  if (isEmptyDelta(delta)) {
    return result;
  }
  if (delta.version !== null) {
    if (typeof result.version !== "string" || !isHigher(result.version, delta.version)) {
      result.version = delta.version;
    }
  }
  const groups = Object.keys(delta.deps || {});
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (!isObject(result[group])) {
      result[group] = {};
    }
    const names = Object.keys(delta.deps[group]);
    for (let n = 0; n < names.length; n++) {
      const name = names[n];
      const ours = delta.deps[group][name];
      const theirs = result[group][name];
      const oursPin = pinnedVersion(ours);
      const theirsPin = theirs === undefined ? null : pinnedVersion(theirs);
      if (oursPin && theirsPin && isHigher(theirsPin, oursPin)) {
        continue;
      }
      result[group][name] = ours;
    }
  }
  return result;
}

/** Paths a release commit may touch: the lockfile, package manifests, and release metadata. */
const RELEASE_PATH_PATTERNS = [
  /^package-lock\.json$/,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/core\/release-manifest\.json$/,
  /^release-events\/[^/]+\.json$/,
];

function isReleasePath(path) {
  for (let i = 0; i < RELEASE_PATH_PATTERNS.length; i++) {
    if (RELEASE_PATH_PATTERNS[i].test(path)) {
      return true;
    }
  }
  return false;
}

/** Stable JSON for comparing two values regardless of key order. */
function canonical(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + canonical(value[k]); }).join(",") + "}";
  }
  return JSON.stringify(value);
}

/**
 * Fields a release commit changed in one package.json beyond what the
 * publisher is allowed to move (`version` and `@tenonhq/*` dependency ranges).
 * Returns an array of human-readable violations; empty means the edit is clean.
 */
function manifestScopeViolations(rel, before, after) {
  const prev = isObject(before) ? before : {};
  const next = isObject(after) ? after : {};
  const violations = [];
  const keys = {};
  Object.keys(prev).concat(Object.keys(next)).forEach(function (k) { keys[k] = true; });
  Object.keys(keys).forEach(function (key) {
    if (key === "version") {
      return;
    }
    if (DEP_GROUPS.indexOf(key) !== -1) {
      const prevGroup = isObject(prev[key]) ? prev[key] : {};
      const nextGroup = isObject(next[key]) ? next[key] : {};
      const names = {};
      Object.keys(prevGroup).concat(Object.keys(nextGroup)).forEach(function (n) { names[n] = true; });
      Object.keys(names).forEach(function (name) {
        if (prevGroup[name] !== nextGroup[name] && name.indexOf("@tenonhq/") !== 0) {
          violations.push(rel + ": " + key + "." + name + " changed (" + prevGroup[name] + " -> " + nextGroup[name] + ")");
        }
      });
      return;
    }
    if (canonical(prev[key]) !== canonical(next[key])) {
      violations.push(rel + ": field \"" + key + "\" changed");
    }
  });
  return violations;
}

/**
 * Fail-closed check run on the release commit before it is pushed. `files` is
 * the list of paths the commit changes relative to the branch tip; `readPair`
 * returns { before, after } parsed JSON for a package.json path. Returns every
 * violation found — a non-empty result means the commit must not be pushed.
 */
function releaseCommitViolations(files, readPair) {
  const list = Array.isArray(files) ? files : [];
  const violations = [];
  for (let i = 0; i < list.length; i++) {
    const rel = list[i];
    if (!isReleasePath(rel)) {
      violations.push(rel + ": not a release file");
      continue;
    }
    if (/^packages\/[^/]+\/package\.json$/.test(rel)) {
      const pair = readPair(rel);
      const found = manifestScopeViolations(rel, pair && pair.before, pair && pair.after);
      for (let v = 0; v < found.length; v++) {
        violations.push(found[v]);
      }
    }
  }
  return violations;
}

module.exports = {
  manifestDelta: manifestDelta,
  applyManifestDelta: applyManifestDelta,
  isEmptyDelta: isEmptyDelta,
  pinnedVersion: pinnedVersion,
  isReleasePath: isReleasePath,
  manifestScopeViolations: manifestScopeViolations,
  releaseCommitViolations: releaseCommitViolations,
};
