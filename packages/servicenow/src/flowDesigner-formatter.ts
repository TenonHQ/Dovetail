/**
 * Human-readable formatter for /sn-build-flow CLI output.
 * JSON output bypasses this — it's for the default human view.
 */

import type { BuildFlowResult } from "./flowDesigner/buildFlowOrchestrator";

function indent(s: string, n: number): string {
  var pad = "";
  for (var i = 0; i < n; i++) pad += " ";
  return s.split("\n").map(function (line) { return pad + line; }).join("\n");
}

export function formatBuildFlowResult(result: BuildFlowResult): string {
  var lines: Array<string> = [];
  var spec = result.spec;
  var verbStem = spec.mode === "clone" ? "Clone" : "Create";

  lines.push(verbStem + " " + spec.kind + ": \"" + spec.newName + "\" (outcome: " + result.outcome + ", exit " + result.exitCode + ")");

  if (result.artifact) {
    lines.push("  Artifact sys_id: " + result.artifact.sysId + " (" + result.artifact.action + ")");
    if (result.artifact.writtenCount > 0) {
      lines.push("  Records written: " + result.artifact.writtenCount);
    }
  }

  if (result.plan && result.plan.length > 0) {
    var byTable: Record<string, number> = {};
    for (var p = 0; p < result.plan.length; p++) {
      var t = result.plan[p].table;
      byTable[t] = (byTable[t] || 0) + 1;
    }
    lines.push("  Plan (dry-run, no writes performed):");
    Object.keys(byTable).sort().forEach(function (t) {
      lines.push(indent(t + " × " + byTable[t], 4));
    });
  }

  if (result.verify) {
    var f = result.verify.found;
    lines.push("  Verify: parent=" + f.parent + " inputs=" + f.inputCount + " outputs=" + f.outputCount + " steps=" + f.stepCount + " snapshot=" + f.snapshotPresent);
    if (result.verify.failures.length > 0) {
      lines.push("  Verify failures:");
      result.verify.failures.forEach(function (failure) {
        lines.push(indent(failure.layer + " " + failure.field + ": expected=" + JSON.stringify(failure.expected) + " actual=" + JSON.stringify(failure.actual), 4));
      });
    }
  }

  if (result.publish) {
    lines.push("  Publish: " + result.publish.status + (result.publish.pushSucceeded ? " (push ok)" : " (push failed)"));
    if (result.publish.uiPublishUrl && result.publish.status !== "published") {
      lines.push("    UI publish: " + result.publish.uiPublishUrl);
    }
    if (result.publish.snapshotSysId) {
      lines.push("    Snapshot sys_id: " + result.publish.snapshotSysId);
    }
  }

  if (result.error) {
    lines.push("  Error at " + result.error.stage + ": " + result.error.message);
  }

  if (result.outcome === "needs-ui-publish") {
    lines.push("");
    lines.push("Next: open Flow Designer in the URL above and click Publish, then commit the update set.");
  } else if (result.outcome === "done") {
    lines.push("");
    lines.push("Next: commit the update set when you're ready to ship.");
  } else if (result.outcome === "unrecoverable") {
    lines.push("");
    lines.push("Spec or auth bug — fix and re-run. No SN state was changed.");
  } else if (result.outcome === "write-failed") {
    lines.push("");
    lines.push("Partial state may be in the update set. Discard the update set in the SN UI to roll back, or re-run after fixing the error above.");
  }

  return lines.join("\n");
}
