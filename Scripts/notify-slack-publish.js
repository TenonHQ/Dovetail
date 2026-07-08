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
 *   IS_DRY_RUN         "true" on a workflow_dispatch dry run — posts a test msg.
 *   PUBLISH_LOG        Path to the tee'd stdout of the publish step (optional —
 *                      absent when the run failed before that step).
 *   RUN_URL, COMMIT_SHA, COMMIT_URL, COMMIT_MSG, ACTOR, REPO  run context.
 *
 * No third-party deps — uses only Node core (https). CommonJS, ES6-only
 * (no optional chaining), to match the rest of Scripts/. The pure helpers are
 * exported for unit tests; the side-effecting main only runs when invoked
 * directly (require.main === module), so requiring this file posts nothing.
 */

"use strict";

var https = require("https");
var fs = require("fs");

// How long to wait on the Slack POST before giving up. The notifier must never
// block the release job, so a stalled connection is abandoned (and we exit 0).
var SLACK_TIMEOUT_MS = 10000;

function env(name, fallback) {
  var v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback || "" : v;
}

// Neutralize Slack mrkdwn so untrusted-ish strings (commit subject, actor,
// repo) can't break formatting or trigger mass-pings. Escapes the three mrkdwn
// control chars and defuses @channel/@here/@everyone with a zero-width space.
function escapeMrkdwn(s) {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(channel|here|everyone)/gi, "@​$1");
}

// Extract the @tenonhq/* packages that reached npm, from the publish log.
// Matches "  published @tenonhq/dovetail-mcp@0.0.22". Deduped, order-preserving.
function parsePublished(log) {
  var seen = {};
  var out = [];
  var re = /published\s+(@tenonhq\/[^\s@]+@\d+\.\d+\.\d+)/g;
  var m;
  var text = String(log || "");
  while ((m = re.exec(text)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      out.push(m[1]);
    }
  }
  return out;
}

// Classify a run from its job status + publish log. `npmAheadOfMain` is the
// silent-failure case: packages reached npm but the bump-push to main did not.
function classify(opts) {
  var log = String((opts && opts.log) || "");
  var jobStatus = (opts && opts.jobStatus) || "";
  var published = parsePublished(log);
  var pushSucceeded = /pushed version bumps to main/.test(log);
  var pushRejected = /GH013|GH006|push declined|remote rejected|Failed to push version bumps/.test(log);
  var npmAheadOfMain = published.length > 0 && !pushSucceeded && (pushRejected || jobStatus === "failure");
  return {
    published: published,
    pushSucceeded: pushSucceeded,
    pushRejected: pushRejected,
    npmAheadOfMain: npmAheadOfMain,
  };
}

// Build the Slack Block Kit payload. Pure — all interpolated strings are
// escaped here, so callers pass raw values. Returns the {blocks:[...]} object.
function buildMessage(ctx) {
  var isDryRun = !!ctx.isDryRun;
  var jobStatus = (ctx.jobStatus || "unknown").toLowerCase();
  var info = classify({ log: ctx.publishLog, jobStatus: jobStatus });
  var published = info.published;

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

  var shortSha = ctx.commitSha ? String(ctx.commitSha).slice(0, 7) : "";
  var commitSubject = escapeMrkdwn(String(ctx.commitMsg || "").split("\n")[0].slice(0, 140));
  var commitField =
    ctx.commitUrl && shortSha ? "<" + ctx.commitUrl + "|" + shortSha + "> " + commitSubject : commitSubject;

  var blocks = [];
  blocks.push({ type: "header", text: { type: "plain_text", text: emoji + " " + headline, emoji: true } });
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: "*Commit:*\n" + commitField },
      { type: "mrkdwn", text: "*Triggered by:*\n" + escapeMrkdwn(ctx.actor || "unknown") },
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
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Published to npm:*\n" + list } });
  }

  if (!isDryRun && info.npmAheadOfMain) {
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
          published.length > 0
            ? ":warning: Failed *after* publishing the packages above — inspect the run."
            : ":warning: Failed before any package was published (build / test / dependency-range gate). Nothing shipped to npm.",
      },
    });
  }

  var runLink = ctx.runUrl ? "<" + ctx.runUrl + "|View workflow run>" : "View workflow run (link unavailable)";
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: runLink + " · " + escapeMrkdwn(ctx.repo || "TenonHQ/Dovetail") }],
  });

  return { blocks: blocks, headline: headline };
}

// POST to Slack, fail-safe: any error, non-2xx, or timeout logs a warning and
// resolves — it never throws and never fails the caller. Calls done() when the
// request settles (so main can exit 0 exactly once).
function postToSlack(webhookUrl, payload, done) {
  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    done();
  }

  var url;
  try {
    url = new URL(webhookUrl);
  } catch (err) {
    console.log("::warning::SLACK_WEBHOOK_URL is malformed — skipping notification.");
    return finish();
  }

  var body = JSON.stringify(payload);
  var options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  };

  var req = https.request(options, function (res) {
    var responseBody = "";
    res.on("data", function (chunk) {
      responseBody += chunk;
    });
    res.on("end", function () {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log("Slack notification posted.");
      } else {
        console.log("::warning::Slack responded " + res.statusCode + " " + responseBody + " — not delivered.");
      }
      finish();
    });
  });

  req.setTimeout(SLACK_TIMEOUT_MS, function () {
    console.log("::warning::Slack request timed out after " + SLACK_TIMEOUT_MS + "ms — notification not delivered.");
    req.destroy();
  });

  req.on("error", function (err) {
    console.log("::warning::Slack notification failed: " + (err && err.message ? err.message : err));
    finish();
  });

  req.write(body);
  req.end();
}

function main() {
  var webhookUrl = env("SLACK_WEBHOOK_URL");
  if (!webhookUrl) {
    console.log("::warning::SLACK_WEBHOOK_URL is not configured — skipping Slack publish notification.");
    process.exit(0);
  }

  var publishLog = "";
  var logPath = env("PUBLISH_LOG");
  if (logPath) {
    try {
      publishLog = fs.readFileSync(logPath, "utf8");
    } catch (err) {
      publishLog = ""; // missing/unreadable → status-only message
    }
  }

  var message = buildMessage({
    isDryRun: env("IS_DRY_RUN").toLowerCase() === "true",
    jobStatus: env("JOB_STATUS", "unknown"),
    publishLog: publishLog,
    commitSha: env("COMMIT_SHA"),
    commitUrl: env("COMMIT_URL"),
    commitMsg: env("COMMIT_MSG"),
    actor: env("ACTOR", "unknown"),
    repo: env("REPO", "TenonHQ/Dovetail"),
    runUrl: env("RUN_URL"),
  });

  postToSlack(webhookUrl, { blocks: message.blocks }, function () {
    process.exit(0);
  });
}

module.exports = { escapeMrkdwn: escapeMrkdwn, parsePublished: parsePublished, classify: classify, buildMessage: buildMessage };

if (require.main === module) {
  main();
}
