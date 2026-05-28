/**
 * v1 contract test — exercises each preserved v1 MCP tool through the
 * registry against a frozen-clock + deterministic-id harness and asserts
 * the response matches the recorded fixture in src/tests/fixtures/v1/.
 *
 * Placeholders in the fixture (strings like "<sha256 of content_md,
 * recomputed at test time>" or "q_<seeded id from push_question>") are
 * substituted by the corresponding value from the live response — the
 * point is to lock the SHAPE (and every concrete non-derived field), not
 * to pretend we can predict a hash without running the code.
 *
 * Adding a tool: drop a JSON fixture into the fixtures dir and the
 * fixturesAll() loader picks it up; the test table is data-driven so
 * there is no hard-coded list to keep in sync.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { buildDescriptors } from "../registry";
import { __setIdGenerator } from "../storage";

interface Fixture {
  tool: string;
  request: any;
  response: any;
  seed?: { tool: string; request: any } | Array<{ tool: string; request: any }>;
  notes?: string;
}

var FIXTURES_DIR = path.join(__dirname, "fixtures/v1");
var FROZEN_NOW = "2026-05-26T12:00:00.000Z";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "v1-contract-"));
}

function loadFixture(tool: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, tool + ".json"), "utf8"));
}

function listFixtures(): string[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter(function (f) { return f.endsWith(".json"); })
    .map(function (f) { return f.replace(/\.json$/, ""); });
}

// Replace placeholder strings in `expected` with their corresponding
// value from `actual`. A placeholder is any string that starts with "<"
// and ends with ">" OR a string that contains "<seeded" (covers the
// "q_<seeded id from push_question>" id placeholders).
function substitutePlaceholders(expected: any, actual: any): any {
  if (typeof expected === "string") {
    // A placeholder is any string containing both "<" and ">" — covers
    // pure "<sha256 …>" and prefixed "q_<seeded …>" forms alike. Real
    // v1 values never contain angle brackets.
    if (expected.indexOf("<") !== -1 && expected.indexOf(">") !== -1) {
      return actual;
    }
    return expected;
  }
  if (Array.isArray(expected)) {
    return expected.map(function (e, i) {
      return substitutePlaceholders(e, actual ? actual[i] : undefined);
    });
  }
  if (expected && typeof expected === "object") {
    var out: Record<string, any> = {};
    for (var k in expected) {
      if (Object.prototype.hasOwnProperty.call(expected, k)) {
        out[k] = substitutePlaceholders(expected[k], actual ? actual[k] : undefined);
      }
    }
    return out;
  }
  return expected;
}

describe("v1 contract — preserved tools return byte-identical shapes", function () {
  var realDateNow = Date.now;
  var realToISOString = Date.prototype.toISOString;
  var realSessionId: string | undefined;
  var restoreIdGen: () => void;

  beforeEach(function () {
    // Freeze nowIso() output. storage.ts builds timestamps via
    // `new Date().toISOString()`; pinning Date.prototype.toISOString
    // covers every callsite without monkey-patching individual helpers.
    Date.prototype.toISOString = function () { return FROZEN_NOW; };

    // The registry derives session_id from CLAUDE_CODE_SESSION_ID when the
    // caller doesn't pass one. Unset for the test so the contract anchors
    // on session_id: null, which is what every fixture records.
    realSessionId = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;

    // Deterministic, counter-based question id generator. Reset per-test
    // so each fixture's seeded ids start from q_00000001.
    var counter = 0;
    var prev = __setIdGenerator(function () {
      counter += 1;
      return "q_" + counter.toString(16).padStart(8, "0");
    });
    restoreIdGen = function () { __setIdGenerator(prev); };
  });

  afterEach(function () {
    Date.prototype.toISOString = realToISOString;
    Date.now = realDateNow;
    if (realSessionId !== undefined) process.env.CLAUDE_CODE_SESSION_ID = realSessionId;
    if (restoreIdGen) restoreIdGen();
  });

  var toolNames = listFixtures();
  // Each tool gets its own test row — failures point at the specific tool.
  toolNames.forEach(function (tool) {
    it("round-trips " + tool + " against its fixture", async function () {
      var fixture = loadFixture(tool);
      var root = mkTmp();
      var descriptors = buildDescriptors({ storage: { rootDir: root } });

      function descriptor(name: string) {
        var d = descriptors.find(function (x) { return x.name === name; });
        if (!d) throw new Error("unknown tool in fixture: " + name);
        return d;
      }

      // Apply any seed ops (e.g. push_plan before push_artifact). Capture
      // the first push_question response so request fields referring to
      // "<seeded id from push_question>" can be resolved.
      var seededQuestionId: string | null = null;
      if (fixture.seed) {
        var seeds = Array.isArray(fixture.seed) ? fixture.seed : [fixture.seed];
        for (var i = 0; i < seeds.length; i++) {
          var seedResult = await descriptor(seeds[i].tool).handler(seeds[i].request);
          if (seeds[i].tool === "push_question" && seededQuestionId === null) {
            seededQuestionId = seedResult.id;
          }
        }
      }

      // Resolve request-side placeholders before validation. The only
      // request placeholder in v1 is the seeded question id.
      var request = JSON.parse(
        JSON.stringify(fixture.request).replace(
          /"q_<seeded id from push_question>"/g,
          JSON.stringify(seededQuestionId || "")
        )
      );

      var actual = await descriptor(fixture.tool).handler(request);
      var expected = substitutePlaceholders(fixture.response, actual);
      expect(actual).toEqual(expected);
    });
  });
});
