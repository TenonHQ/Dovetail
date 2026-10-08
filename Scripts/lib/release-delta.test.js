"use strict";

/**
 * Unit tests for the release-commit field deltas.
 * Run: node --test Scripts/lib/release-delta.test.js
 */

const test = require("node:test");
const assert = require("node:assert");
const rd = require("./release-delta");

test("manifestDelta captures version and changed internal ranges only", function () {
  const before = {
    name: "@tenonhq/dovetail-core",
    version: "0.0.120",
    dependencies: { "@tenonhq/dovetail-schema": "~0.0.13", axios: "^1.20.0" },
  };
  const after = {
    name: "@tenonhq/dovetail-core",
    version: "0.0.121",
    dependencies: { "@tenonhq/dovetail-schema": "~0.0.14", axios: "^1.20.0" },
  };
  assert.deepStrictEqual(rd.manifestDelta(before, after), {
    version: "0.0.121",
    deps: { dependencies: { "@tenonhq/dovetail-schema": "~0.0.14" } },
  });
});

test("manifestDelta is empty when nothing moved", function () {
  const m = { version: "1.0.0", dependencies: { a: "1.0.0" } };
  assert.ok(rd.isEmptyDelta(rd.manifestDelta(m, JSON.parse(JSON.stringify(m)))));
});

// The b46e30a regression: a concurrent merge bumped a third-party dep while
// the run was publishing. The release delta must not revert it.
test("applyManifestDelta keeps a concurrent third-party bump on the tip", function () {
  const checkout = {
    version: "0.0.12",
    dependencies: { "@tenonhq/dovetail-google-auth": "~0.0.12", "sanitize-html": "^2.17.4" },
  };
  const afterRun = {
    version: "0.0.13",
    dependencies: { "@tenonhq/dovetail-google-auth": "~0.0.13", "sanitize-html": "^2.17.4" },
  };
  const tip = {
    version: "0.0.12",
    engines: { node: ">=22.12.0" },
    dependencies: { "@tenonhq/dovetail-google-auth": "~0.0.12", "sanitize-html": "^2.17.7" },
  };
  const result = rd.applyManifestDelta(tip, rd.manifestDelta(checkout, afterRun));
  assert.deepStrictEqual(result, {
    version: "0.0.13",
    engines: { node: ">=22.12.0" },
    dependencies: { "@tenonhq/dovetail-google-auth": "~0.0.13", "sanitize-html": "^2.17.7" },
  });
});

test("applyManifestDelta never downgrades a version the tip already raised", function () {
  const delta = { version: "0.0.121", deps: {} };
  assert.strictEqual(rd.applyManifestDelta({ version: "0.0.125" }, delta).version, "0.0.125");
  assert.strictEqual(rd.applyManifestDelta({ version: "0.0.100" }, delta).version, "0.0.121");
});

test("applyManifestDelta never downgrades an internal pin the tip already raised", function () {
  const delta = { version: null, deps: { dependencies: { "@tenonhq/dovetail-core": "~0.0.120" } } };
  const tip = { dependencies: { "@tenonhq/dovetail-core": "~0.0.130" } };
  assert.strictEqual(rd.applyManifestDelta(tip, delta).dependencies["@tenonhq/dovetail-core"], "~0.0.130");
});

test("applyManifestDelta adds a dependency group the tip lacks", function () {
  const delta = { version: null, deps: { peerDependencies: { "@tenonhq/dovetail-types": "~0.0.5" } } };
  assert.deepStrictEqual(rd.applyManifestDelta({ version: "1.0.0" }, delta), {
    version: "1.0.0",
    peerDependencies: { "@tenonhq/dovetail-types": "~0.0.5" },
  });
});

test("applyManifestDelta does not mutate its input", function () {
  const tip = { version: "0.0.1", dependencies: { a: "~0.0.1" } };
  const snapshot = JSON.stringify(tip);
  rd.applyManifestDelta(tip, { version: "0.0.2", deps: { dependencies: { a: "~0.0.2" } } });
  assert.strictEqual(JSON.stringify(tip), snapshot);
});

test("applyManifestDelta tolerates malformed input", function () {
  assert.deepStrictEqual(rd.applyManifestDelta(null, null), {});
  assert.deepStrictEqual(rd.manifestDelta(undefined, "nope"), { version: null, deps: {} });
  assert.strictEqual(rd.applyManifestDelta({ version: "garbage" }, { version: "0.0.2", deps: {} }).version, "0.0.2");
});

test("pinnedVersion reads single-operator pins and rejects compound ranges", function () {
  assert.strictEqual(rd.pinnedVersion("~0.0.14"), "0.0.14");
  assert.strictEqual(rd.pinnedVersion("0.0.14"), "0.0.14");
  assert.strictEqual(rd.pinnedVersion(">=1.0.0 <2.0.0"), null);
  assert.strictEqual(rd.pinnedVersion("workspace:*"), null);
});

// R-288-2: the release commit is pushed past review, so it must never carry
// anything beyond version bumps. These pin the fail-closed scope check.
function pairs(map) {
  return function (rel) {
    return map[rel] || { before: {}, after: {} };
  };
}

test("releaseCommitViolations accepts a clean release commit", function () {
  const files = [
    "package-lock.json",
    "packages/core/package.json",
    "packages/core/release-manifest.json",
    "release-events/dovetail-core@0.0.126.json",
  ];
  const read = pairs({
    "packages/core/package.json": {
      before: { name: "x", version: "0.0.125", dependencies: { "@tenonhq/dovetail-schema": "~0.0.15", axios: "^1.20.0" } },
      after: { name: "x", version: "0.0.126", dependencies: { "@tenonhq/dovetail-schema": "~0.0.16", axios: "^1.20.0" } },
    },
  });
  assert.deepStrictEqual(rd.releaseCommitViolations(files, read), []);
});

test("releaseCommitViolations refuses a workflow or source file", function () {
  const found = rd.releaseCommitViolations(
    [".github/workflows/publish.yml", "Scripts/lib/release-delta.js", "packages/core/src/index.ts"],
    pairs({})
  );
  assert.strictEqual(found.length, 3);
  assert.ok(found[0].indexOf(".github/workflows/publish.yml") === 0);
});

test("releaseCommitViolations refuses a third-party range change in a manifest", function () {
  const read = pairs({
    "packages/mcp/package.json": {
      before: { version: "0.0.50", dependencies: { "@modelcontextprotocol/sdk": "^1.32.1" } },
      after: { version: "0.0.51", dependencies: { "@modelcontextprotocol/sdk": "^1.30.0" } },
    },
  });
  const found = rd.releaseCommitViolations(["packages/mcp/package.json"], read);
  assert.strictEqual(found.length, 1);
  assert.ok(found[0].indexOf("@modelcontextprotocol/sdk") !== -1);
});

test("releaseCommitViolations refuses any other manifest field change", function () {
  const read = pairs({
    "packages/gmail/package.json": {
      before: { version: "0.0.13", engines: { node: ">=22.12" } },
      after: { version: "0.0.14", engines: { node: ">=22" } },
    },
  });
  const found = rd.releaseCommitViolations(["packages/gmail/package.json"], read);
  assert.deepStrictEqual(found, ["packages/gmail/package.json: field \"engines\" changed"]);
});

test("releaseCommitViolations ignores key order in unchanged fields", function () {
  const read = pairs({
    "packages/core/package.json": {
      before: { version: "1.0.0", scripts: { a: "1", b: "2" } },
      after: { scripts: { b: "2", a: "1" }, version: "1.0.1" },
    },
  });
  assert.deepStrictEqual(rd.releaseCommitViolations(["packages/core/package.json"], read), []);
});
