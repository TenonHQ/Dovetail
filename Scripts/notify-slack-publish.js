#!/usr/bin/env node
/**
 * notify-slack-publish.js
 *
 * Posts the outcome of the "Publish packages" workflow to Slack (#deployment)
 * so a red run is never silent. It is called as the final, always()-guarded
 * step of .github/workflows/publish.yml.
 *
 * WHY THIS EXISTS
 *   npm publish and the post-publish version-bump push to main are two separate
 *   operations. The common silent failure is: npm publish SUCCEEDS, then the
 *   bump-push to main is rejected by branch protection (GH006 / GH013). The
 *   workflow goes red, but the packages already shipped to npm — leaving npm
 *   ahead of main with nobody notified. This notifier surfaces exactly that,
 *   plus ordinary build/test failures and clean successes.
 *
 * INPUTS (all via env, injected by the workflow)
 *   SLACK_WEBHOOK_URL  Incoming webhook for #deployment. If unset, the notifier
 *                      logs a warning and exits 0 — it NEVER fails the job.
 *   JOB_STATUS         github job.status: "success" | "failure" | "cancelled".
 *   PUBLISH_LOG        Path to the tee'd stdout of the publish step (optional —
 *                      absent when the run failed before that step).
 *   RUN_URL, COMMIT_SHA, COMMIT_URL, COMMIT_MSG, ACTOR, REPO  run context.
 *
 * No third-party deps — uses only Node core (https). CommonJS, ES6-only
 * (no optional chaining), to match the rest of Scripts/.
 */

"use strict";

var https = require("https");
var fs = require("fs");

function env(name, fallback) {
  var v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback || "" : v;
}

var webhookUrl = env("SLACK_WEBHOOK_URL");
if (!webhookUrl) {
  console.log("::warning::SLACK_WEBHOOK_URL is not set — skipping Slack publish notification.");
  process.exit(0);
}

var jobStatus = env("JOB_STATUS", "unknown").toLowerCase();
var isDryRun = env("IS_DRY_RUN").toLowerCase() === "true";
var runUrl = env("RUN_URL");
var commitSha = env("COMMIT_SHA");
var commitUrl = env("COMMIT_URL");
var commitMsg = env("COMMIT_MSG");
var actor = env("ACTOR", "unknown");
var repo = env("REPO", "TenonHQ/Dovetail");

// First line of the commit message only, trimmed to a sane length.
var commitSubject = commitMsg.split("\n")[0].slice(0, 140);
var shortSha = commitSha ? commitSha.slice(0, 7) : "";

// ── Parse the publish log (best-effort) ────────────────────────────────────
// Extracts which packages hit npm and whether the post-publish push failed.
// The log may be absent (early build/test failure) — that's handled gracefully.
var publishLog = "";
var logPath = env("PUBLISH_LOG");
if (logPath) {
  try {
    publishLog = fs.readFileSync(logPath, "utf8");
  } catch (err) {
    publishLog = ""; // missing/unreadable → treat as no publish info
  }
}

function parsePublished(log) {
  var seen = {};
  var out = [];
  // Matches: "  published @tenonhq/dovetail-mcp@0.0.22"
  var re = /published\s+(@tenonhq\/[^\s@]+@\d+\.\d+\.\d+)/g;
  var m;
  while ((m = re.exec(log)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      out.push(m[1]);
    }
  }
  return out;
}

var published = parsePublished(publishLog);
var pushSucceeded = /pushed version bumps to main/.test(publishLog);
var pushRejected =
  /GH013|GH006|push declined|remote rejected|Failed to push version bumps/.test(publishLog);
// The silent case: packages reached npm, but the bump-push to main did not land.
var npmAheadOfMain =
  published.length > 0 && !pushSucceeded && (pushRejected || jobStatus === "failure");

// ── Build the message ──────────────────────────────────────────────────────
var emoji;
var headline;
if (isDryRun) {
  emoji = "🧪"; // 🧪
  headline = "Dovetail publish — dry run (test)";
} else if (jobStatus === "success") {
  emoji = "✅"; // ✅
  headline = published.length > 0 ? "Dovetail publish succeeded" : "Dovetail publish — nothing to ship";
} else if (jobStatus === "cancelled") {
  emoji = "⚪"; // ⚪
  headline = "Dovetail publish cancelled";
} else {
  emoji = "🔴"; // 🔴
  headline = "Dovetail publish FAILED";
}

var blocks = [];
blocks.push({
  type: "header",
  text: { type: "plain_text", text: emoji + " " + headline, emoji: true },
});

var commitField = commitUrl && shortSha ? "<" + commitUrl + "|" + shortSha + "> " + commitSubject : commitSubject;
blocks.push({
  type: "section",
  fields: [
    { type: "mrkdwn", text: "*Commit:*\n" + commitField },
    { type: "mrkdwn", text: "*Triggered by:*\n" + actor },
  ],
});

if (isDryRun) {
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: ":white_check_mark: Webhook + workflow wiring verified. This was a dry run — *no packages were published*.",
    },
  });
}

if (!isDryRun && published.length > 0) {
  var list = published
    .map(function (spec) {
      return "• `" + spec + "`";
    })
    .join("\n");
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "*Published to npm:*\n" + list },
  });
}

if (!isDryRun && npmAheadOfMain) {
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        ":warning: *Packages published to npm, but the post-publish version bump-push to `main` was rejected.* " +
        "npm is now ahead of `main`. Check the branch-protection / ruleset bypass for the release deploy key, then reconcile source.",
    },
  });
} else if (!isDryRun && jobStatus === "failure") {
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        (published.length > 0
          ? ":warning: Failed *after* publishing the packages above — inspect the run."
          : ":warning: Failed before any package was published (build / test / dependency-range gate). Nothing shipped to npm."),
    },
  });
}

blocks.push({
  type: "context",
  elements: [{ type: "mrkdwn", text: "<" + runUrl + "|View workflow run> · " + repo }],
});

var payload = JSON.stringify({ blocks: blocks });

// ── Post to Slack (fail-safe: warn and exit 0 on any error) ─────────────────
var url;
try {
  url = new URL(webhookUrl);
} catch (err) {
  console.log("::warning::SLACK_WEBHOOK_URL is malformed — skipping notification.");
  process.exit(0);
}

var options = {
  hostname: url.hostname,
  path: url.pathname + url.search,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  },
};

var req = https.request(options, function (res) {
  var body = "";
  res.on("data", function (chunk) {
    body += chunk;
  });
  res.on("end", function () {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log("Slack notification posted (" + headline + ").");
    } else {
      console.log(
        "::warning::Slack responded " + res.statusCode + " " + body + " — notification not delivered."
      );
    }
    process.exit(0);
  });
});

req.on("error", function (err) {
  console.log("::warning::Slack notification failed: " + (err && err.message ? err.message : err));
  process.exit(0);
});

req.write(payload);
req.end();
