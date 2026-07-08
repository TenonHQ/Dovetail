/**
 * Promotion-ladder validation — the authoritative SHAPE check for the
 * `promotion` block of automation-config.json (D1: the package owns the shape;
 * automation-config.json owns the data). The Craftsman CI guard imports this.
 *
 * Input is treated as untrusted JSON (`unknown`) and narrowed defensively.
 */

import type { Transport } from "./types";

export interface ValidationIssue {
  /** Dotted path into the promotion config, e.g. "statusMap['push to yard'].transport". */
  path: string;
  message: string;
}

export interface ValidatePromotionLadderParams {
  /** The parsed `promotion` block (untrusted). */
  config: unknown;
  /** branching.taskIdPattern, to assert the two agree. Optional. */
  branchTaskIdPattern?: string;
}

var TRANSPORTS: Transport[] = ["sawmill", "company-repo", "manual"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Returns the list of problems with a promotion config. Empty array = valid.
 * Checks (semantic, beyond a plain JSON Schema):
 *  - taskIdPattern present, a valid regex, and (if provided) equal to branchTaskIdPattern
 *  - instances / statusMap present
 *  - each rung: clickupStatusId present + unique, transport in enum,
 *    source/target instances exist
 *  - no ENABLED rung references a disabled instance or one with a null url
 */
export function validatePromotionLadder(
  params: ValidatePromotionLadderParams,
): ValidationIssue[] {
  var issues: ValidationIssue[] = [];
  var config = asRecord(params.config);
  if (!config) {
    return [
      {
        path: "promotion",
        message: "promotion config is missing or not an object",
      },
    ];
  }

  // taskIdPattern
  if (!isNonEmptyString(config.taskIdPattern)) {
    issues.push({
      path: "taskIdPattern",
      message: "taskIdPattern is required",
    });
  } else {
    try {
      new RegExp(config.taskIdPattern);
    } catch (err) {
      issues.push({
        path: "taskIdPattern",
        message: "taskIdPattern is not a valid regular expression",
      });
    }
    if (
      params.branchTaskIdPattern !== undefined &&
      config.taskIdPattern !== params.branchTaskIdPattern
    ) {
      issues.push({
        path: "taskIdPattern",
        message:
          "taskIdPattern must equal branching.taskIdPattern (" +
          params.branchTaskIdPattern +
          ")",
      });
    }
  }

  var instances = asRecord(config.instances);
  if (!instances) {
    issues.push({ path: "instances", message: "instances map is required" });
  }
  var statusMap = asRecord(config.statusMap);
  if (!statusMap) {
    issues.push({ path: "statusMap", message: "statusMap is required" });
  }

  if (!instances || !statusMap) {
    return issues;
  }

  // Capture the narrowed (non-null) maps so the closures below keep the narrowing.
  var instanceMap = instances;
  var statusRungs = statusMap;
  var seenStatusIds: Record<string, string> = {};

  Object.keys(statusRungs).forEach(function (statusName) {
    var base = "statusMap['" + statusName + "']";
    var rung = asRecord(statusRungs[statusName]);
    if (!rung) {
      issues.push({ path: base, message: "rung must be an object" });
      return;
    }

    // clickupStatusId present + unique
    if (!isNonEmptyString(rung.clickupStatusId)) {
      issues.push({
        path: base + ".clickupStatusId",
        message: "clickupStatusId is required",
      });
    } else if (seenStatusIds[rung.clickupStatusId]) {
      issues.push({
        path: base + ".clickupStatusId",
        message:
          "duplicate clickupStatusId also used by " +
          seenStatusIds[rung.clickupStatusId],
      });
    } else {
      seenStatusIds[rung.clickupStatusId] = statusName;
    }

    // transport enum
    if (
      typeof rung.transport !== "string" ||
      TRANSPORTS.indexOf(rung.transport as Transport) === -1
    ) {
      issues.push({
        path: base + ".transport",
        message: "transport must be one of " + TRANSPORTS.join(", "),
      });
    }

    // instance references exist
    var refs: Array<{ key: string; ref: unknown }> = [
      { key: "sourceInstance", ref: rung.sourceInstance },
      { key: "targetInstance", ref: rung.targetInstance },
    ];
    refs.forEach(function (r) {
      if (!isNonEmptyString(r.ref) || !instanceMap[r.ref]) {
        issues.push({
          path: base + "." + r.key,
          message: r.key + " is not defined in instances",
        });
      }
    });

    // an enabled rung must point at ready (enabled + url) instances
    if (rung.enabled === true) {
      refs.forEach(function (r) {
        if (!isNonEmptyString(r.ref)) {
          return;
        }
        var inst = asRecord(instanceMap[r.ref]);
        if (inst && (inst.enabled !== true || !isNonEmptyString(inst.url))) {
          issues.push({
            path: base,
            message:
              "enabled rung references instance '" +
              r.ref +
              "' which is disabled or has no url",
          });
        }
      });
    }
  });

  return issues;
}
