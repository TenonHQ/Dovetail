"use strict";

/**
 * Unit tests for the publish-pipeline helpers that gained cascade behaviour.
 * Pure functions only — no git, no npm, no filesystem.
 *
 * Run: node --test Scripts/lib/workspace.test.js   (Node 18+; repo uses Node 22)
 */

const test = require("node:test");
const assert = require("node:assert");
const ws = require("./workspace");

test("applyRangePrefix rewrites a complete pin and preserves its operator", function () {
  assert.strictEqual(ws.applyRangePrefix("^0.0.9", "0.0.10"), "^0.0.10");
  assert.strictEqual(ws.applyRangePrefix("~0.0.5", "0.0.10"), "~0.0.10");
  assert.strictEqual(ws.applyRangePrefix("0.0.9", "0.0.10"), "0.0.10");
  assert.strictEqual(ws.applyRangePrefix(">=1.2.0", "0.0.10"), ">=0.0.10");
});

test("applyRangePrefix leaves non-pin and multi-term specs untouched", function () {
  // Non-pin specs must never be corrupted.
  assert.strictEqual(ws.applyRangePrefix("*", "0.0.10"), "*");
  assert.strictEqual(ws.applyRangePrefix("workspace:*", "0.0.10"), "workspace:*");
  assert.strictEqual(ws.applyRangePrefix("latest", "0.0.10"), "latest");
  // Compound / hyphen ranges already admit the new version — leave them be.
  assert.strictEqual(ws.applyRangePrefix(">=0.0.9 <0.1.0", "0.0.10"), ">=0.0.9 <0.1.0");
  assert.strictEqual(ws.applyRangePrefix("0.0.9 - 0.1.0", "0.0.10"), "0.0.9 - 0.1.0");
  // Prerelease pins are out of scope and must pass through unchanged.
  assert.strictEqual(ws.applyRangePrefix("^0.0.9-beta.1", "0.0.10"), "^0.0.9-beta.1");
});

test("dependentsClosure returns the seed plus its transitive dependents", function () {
  // Graph: a <- b <- c (c depends on b, b depends on a); d is unrelated.
  const packages = [
    { dirName: "a", name: "@x/a", manifest: { dependencies: {} } },
    { dirName: "b", name: "@x/b", manifest: { dependencies: { "@x/a": "^0.0.1" } } },
    { dirName: "c", name: "@x/c", manifest: { dependencies: { "@x/b": "^0.0.1" } } },
    { dirName: "d", name: "@x/d", manifest: { dependencies: {} } }
  ];
  const closure = ws.dependentsClosure({ a: true }, packages);
  assert.strictEqual(closure.a, true, "seed is included");
  assert.strictEqual(closure.b, true, "direct dependent of a");
  assert.strictEqual(closure.c, true, "transitive dependent via b");
  assert.strictEqual(closure.d, undefined, "unrelated package excluded");
});

test("dependentsClosure of a leaf consumer is just itself", function () {
  // b depends on a; seeding b must NOT drag in a (a is a dependency, not a dependent).
  const packages = [
    { dirName: "a", name: "@x/a", manifest: { dependencies: {} } },
    { dirName: "b", name: "@x/b", manifest: { dependencies: { "@x/a": "^0.0.1" } } }
  ];
  const closure = ws.dependentsClosure({ b: true }, packages);
  assert.strictEqual(closure.b, true);
  assert.strictEqual(closure.a, undefined);
  assert.strictEqual(Object.keys(closure).length, 1);
});

test("dependentsClosure follows devDependencies and peerDependencies too", function () {
  const packages = [
    { dirName: "a", name: "@x/a", manifest: { dependencies: {} } },
    { dirName: "b", name: "@x/b", manifest: { devDependencies: { "@x/a": "^0.0.1" } } },
    { dirName: "c", name: "@x/c", manifest: { peerDependencies: { "@x/a": "^0.0.1" } } }
  ];
  const closure = ws.dependentsClosure({ a: true }, packages);
  assert.strictEqual(closure.b, true, "dev dependent included");
  assert.strictEqual(closure.c, true, "peer dependent included");
});
