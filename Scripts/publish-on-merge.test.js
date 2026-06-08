"use strict";

/**
 * Unit tests for the pre-publish internal-dependency guard.
 * Pure logic only — the npm registry probe is injected, so no git, no npm,
 * no filesystem, no network.
 *
 * Run: node --test Scripts/publish-on-merge.test.js   (Node 18+; repo uses Node 22)
 */

const test = require("node:test");
const assert = require("node:assert");
const { unresolvedInternalDeps } = require("./publish-on-merge");

// A resolver stub: every spec resolves except the names listed as missing.
function resolverMissing(missingNames) {
  const missing = {};
  for (let i = 0; i < missingNames.length; i++) {
    missing[missingNames[i]] = true;
  }
  return function (name) {
    return !Object.prototype.hasOwnProperty.call(missing, name);
  };
}

const resolveAll = function () {
  return true;
};
const resolveNone = function () {
  return false;
};

test("flags an internal dependency that does not resolve from npm", function () {
  const pkg = { manifest: { dependencies: { "@tenonhq/dovetail-mcp-kit": "~0.0.1" } } };
  const unresolved = unresolvedInternalDeps(pkg, {}, resolverMissing(["@tenonhq/dovetail-mcp-kit"]));
  assert.deepStrictEqual(unresolved, ["@tenonhq/dovetail-mcp-kit@~0.0.1"]);
});

test("passes when every internal dependency resolves from npm", function () {
  const pkg = { manifest: { dependencies: { "@tenonhq/dovetail-core": "~0.0.10" } } };
  assert.deepStrictEqual(unresolvedInternalDeps(pkg, {}, resolveAll), []);
});

test("skips a dependency already published earlier in this run", function () {
  const pkg = { manifest: { dependencies: { "@tenonhq/dovetail-mcp-kit": "~0.0.1" } } };
  const publishedThisRun = { "@tenonhq/dovetail-mcp-kit": "0.0.1" };
  // resolveNone would flag it, but the published-this-run skip wins.
  assert.deepStrictEqual(unresolvedInternalDeps(pkg, publishedThisRun, resolveNone), []);
});

test("ignores third-party (non-@tenonhq/dovetail) dependencies", function () {
  const pkg = { manifest: { dependencies: { lodash: "^4.17.21", "@other/pkg": "1.0.0" } } };
  // resolveNone would flag anything checked; none are internal, so nothing is checked.
  assert.deepStrictEqual(unresolvedInternalDeps(pkg, {}, resolveNone), []);
});

test("checks peerDependencies as well as dependencies", function () {
  const pkg = {
    manifest: {
      dependencies: { "@tenonhq/dovetail-core": "~0.0.10" },
      peerDependencies: { "@tenonhq/dovetail-types": "~0.0.5" }
    }
  };
  const unresolved = unresolvedInternalDeps(pkg, {}, resolverMissing(["@tenonhq/dovetail-types"]));
  assert.deepStrictEqual(unresolved, ["@tenonhq/dovetail-types@~0.0.5"]);
});

test("does not check devDependencies (not installed by consumers)", function () {
  const pkg = { manifest: { devDependencies: { "@tenonhq/dovetail-eslint-plugin": "~0.0.3" } } };
  assert.deepStrictEqual(unresolvedInternalDeps(pkg, {}, resolveNone), []);
});

test("de-duplicates a spec listed in both dependencies and peerDependencies", function () {
  const pkg = {
    manifest: {
      dependencies: { "@tenonhq/dovetail-types": "~0.0.5" },
      peerDependencies: { "@tenonhq/dovetail-types": "~0.0.5" }
    }
  };
  const unresolved = unresolvedInternalDeps(pkg, {}, resolveNone);
  assert.deepStrictEqual(unresolved, ["@tenonhq/dovetail-types@~0.0.5"]);
});

test("tolerates a manifest with no dependency groups", function () {
  assert.deepStrictEqual(unresolvedInternalDeps({ manifest: {} }, {}, resolveNone), []);
});
