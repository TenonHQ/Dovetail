"use strict";

/**
 * Tests for Scripts/normalize-internal-deps.js — the internal-range guard.
 *
 * Run explicitly:  node --test Scripts/normalize-internal-deps.test.js
 * (Scripts/run-workspaces.js test only runs per-package npm test scripts, so a
 * Scripts/-root test file is invisible to it and must be invoked directly.)
 *
 * ES6 only — no optional chaining / nullish coalescing (repo standard).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const norm = require("./normalize-internal-deps");

test("classifyRange ACCEPTS the floating forms", function () {
  const accept = ["~0.0.10", "~0.0.1", "~0.0.19", "~0.0.999", "~0.0.0", ">=0.0.10 <0.1.0"];
  for (let i = 0; i < accept.length; i++) {
    const verdict = norm.classifyRange(accept[i]);
    assert.equal(verdict.ok, true, "expected ACCEPT for " + accept[i]);
  }
});

test("classifyRange REJECTS every non-floating form (default-deny)", function () {
  const reject = [
    "^0.0.10",          // the 21-edge defect: caret hard-pin
    "^0.0.9",
    "0.0.10",           // exact pin
    "1.2.3",            // exact pin, non-0.0.x
    "*",                // wildcard (the 2 dashboard edges)
    "x",
    "workspace:*",
    "latest",
    "next",
    "dev",
    ">=0.0.10",         // unbounded
    ">=1.2.0",
    "~0.1.0",           // tilde, wrong floor band
    "~1.0.0",
    "^0.1.0",           // caret, non-0.0.x
    "^1.0.0",
    "0.0.10-beta.1",    // prerelease
    "^0.0.10-rc.1",
    "file:../x",
    "link:../x",
    "git+https://example.com/x.git"
  ];
  for (let i = 0; i < reject.length; i++) {
    const verdict = norm.classifyRange(reject[i]);
    assert.equal(verdict.ok, false, "expected REJECT for " + reject[i]);
    assert.ok(verdict.reason && verdict.reason.length > 0, "reject must carry a reason: " + reject[i]);
  }
});

test("computeFloor anchors to min(npmLatest, source) — both directions", function () {
  // npm leads source (a freshly republished, not-yet-source-bumped package).
  assert.equal(norm.computeFloor("dep", "0.0.14", "0.0.15"), "~0.0.14");
  // source leads npm (the normal +1 postpublish-bump invariant).
  assert.equal(norm.computeFloor("dep", "0.0.20", "0.0.19"), "~0.0.19");
  // small numbers.
  assert.equal(norm.computeFloor("dep", "0.0.2", "0.0.1"), "~0.0.1");
  // equal.
  assert.equal(norm.computeFloor("dep", "0.0.10", "0.0.10"), "~0.0.10");
});

test("computeFloor falls back to the source version when npm is null", function () {
  assert.equal(norm.computeFloor("dep", "0.0.5", null), "~0.0.5");
});

test("computeFloor floor admits the npm-latest patch (installable)", function () {
  // ~0.0.14 must admit the published 0.0.15, proving the floor is installable.
  const semver = require("semver");
  const floor = norm.computeFloor("dep", "0.0.14", "0.0.15"); // "~0.0.14"
  assert.equal(floor, "~0.0.14");
  assert.equal(semver.satisfies("0.0.15", floor), true);
});

test("LIVE: every internal range in the repo is floating (regression anchor)", function () {
  // Fails before the 23+1 edges are normalized; passes after. Also fails if any
  // future change re-introduces a hard pin, exact pin, or wildcard.
  const edges = norm.collectEdges();
  assert.ok(edges.length > 0, "expected to find internal edges in the workspace");
  const bad = [];
  for (let i = 0; i < edges.length; i++) {
    if (!norm.classifyRange(edges[i].range).ok) {
      bad.push(edges[i].label + " [" + edges[i].group + "] " + edges[i].depName + " = " + edges[i].range);
    }
  }
  assert.deepEqual(bad, [], "non-floating internal ranges found:\n" + bad.join("\n"));
});
