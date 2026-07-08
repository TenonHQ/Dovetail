"use strict";

// Unit tests for the pure helpers in notify-slack-publish.js. Run via
// `node --test Scripts/notify-slack-publish.test.js` (part of the repo gate).
// Requiring the module must NOT post to Slack — the side-effecting main is
// guarded by require.main === module, which these tests rely on.

var test = require("node:test");
var assert = require("node:assert");

var notify = require("./notify-slack-publish.js");

test("escapeMrkdwn escapes mrkdwn control chars", function () {
  assert.strictEqual(notify.escapeMrkdwn("a < b & c > d"), "a &lt; b &amp; c &gt; d");
});

test("escapeMrkdwn defuses mass-mention triggers", function () {
  // The zero-width space between @ and the keyword is what breaks the ping.
  assert.ok(notify.escapeMrkdwn("@channel deploy").indexOf("@channel") === -1);
  assert.ok(notify.escapeMrkdwn("ping @here now").indexOf("@here") === -1);
});

test("escapeMrkdwn tolerates null/undefined", function () {
  assert.strictEqual(notify.escapeMrkdwn(null), "");
  assert.strictEqual(notify.escapeMrkdwn(undefined), "");
});

test("parsePublished extracts and dedupes published specs", function () {
  var log = [
    "  published @tenonhq/dovetail-core@0.0.110",
    "noise noise",
    "  published @tenonhq/dovetail-mcp@0.0.22",
    "  published @tenonhq/dovetail-core@0.0.110", // dup
  ].join("\n");
  assert.deepStrictEqual(notify.parsePublished(log), [
    "@tenonhq/dovetail-core@0.0.110",
    "@tenonhq/dovetail-mcp@0.0.22",
  ]);
});

test("parsePublished returns [] when nothing published", function () {
  assert.deepStrictEqual(notify.parsePublished("No publishable package changes detected."), []);
  assert.deepStrictEqual(notify.parsePublished(""), []);
  assert.deepStrictEqual(notify.parsePublished(null), []);
});

test("classify flags npmAheadOfMain when published but push failed (GH013)", function () {
  var log = [
    "  published @tenonhq/dovetail-dashboard@0.0.48",
    "remote: error: GH013: Repository rule violations found",
    "FATAL: Failed to push version bumps to main after 3 attempts",
  ].join("\n");
  var info = notify.classify({ log: log, jobStatus: "failure" });
  assert.strictEqual(info.npmAheadOfMain, true);
  assert.strictEqual(info.pushRejected, true);
  assert.strictEqual(info.pushSucceeded, false);
});

test("classify does NOT flag npmAheadOfMain on a clean success", function () {
  var log = [
    "  published @tenonhq/dovetail-dashboard@0.0.48",
    "  pushed version bumps to main",
  ].join("\n");
  var info = notify.classify({ log: log, jobStatus: "success" });
  assert.strictEqual(info.npmAheadOfMain, false);
  assert.strictEqual(info.pushSucceeded, true);
});

test("classify does NOT flag npmAheadOfMain when nothing was published", function () {
  var info = notify.classify({ log: "build failed before publish", jobStatus: "failure" });
  assert.strictEqual(info.npmAheadOfMain, false);
  assert.deepStrictEqual(info.published, []);
});

test("buildMessage dry-run produces the test headline and no publish claim", function () {
  var msg = notify.buildMessage({ isDryRun: true, jobStatus: "success", publishLog: "" });
  var json = JSON.stringify(msg.blocks);
  assert.ok(msg.headline.indexOf("dry run") !== -1);
  assert.ok(json.indexOf("no packages were published") !== -1);
});

test("buildMessage success lists published packages", function () {
  var msg = notify.buildMessage({
    isDryRun: false,
    jobStatus: "success",
    publishLog: "  published @tenonhq/dovetail-dashboard@0.0.48",
  });
  var json = JSON.stringify(msg.blocks);
  assert.ok(json.indexOf("Published to npm") !== -1);
  assert.ok(json.indexOf("@tenonhq/dovetail-dashboard@0.0.48") !== -1);
});

test("buildMessage surfaces the silent npm-ahead-of-main failure", function () {
  var msg = notify.buildMessage({
    isDryRun: false,
    jobStatus: "failure",
    publishLog: "  published @tenonhq/dovetail-core@0.0.110\nremote: error: GH013 rule violations",
  });
  var json = JSON.stringify(msg.blocks);
  assert.ok(json.indexOf("npm is now ahead of") !== -1);
});

test("buildMessage escapes a commit subject containing mrkdwn", function () {
  var msg = notify.buildMessage({
    isDryRun: false,
    jobStatus: "success",
    publishLog: "",
    commitMsg: "fix: handle <a> & @channel edge case",
    commitSha: "abcdef1234",
    commitUrl: "https://x/abcdef1234",
  });
  var json = JSON.stringify(msg.blocks);
  assert.ok(json.indexOf("&lt;a&gt;") !== -1);
  assert.ok(json.indexOf("&amp;") !== -1);
  assert.ok(json.indexOf("@channel") === -1);
});
