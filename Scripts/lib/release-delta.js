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

module.exports = {
  manifestDelta: manifestDelta,
  applyManifestDelta: applyManifestDelta,
  isEmptyDelta: isEmptyDelta,
  pinnedVersion: pinnedVersion,
};
