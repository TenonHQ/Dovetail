/**
 * Argument redaction for telemetry events.
 *
 * Pure functions only — testable without filesystem or env access. The goal is
 * to keep operational signal (tool shape, query strings, IDs) while removing
 * PII (email bodies, full email addresses) and credentials (tokens, passwords).
 */

import * as crypto from "crypto";

var TOKEN_KEYS = [
  "token",
  "password",
  "refresh_token",
  "refreshtoken",
  "access_token",
  "accesstoken",
  "client_secret",
  "clientsecret",
  "apikey",
  "api_key",
  "clickup_api_token",
  "authorization",
  "auth"
];

var BODY_KEYS = ["body", "html", "text", "content"];

var QUERY_KEYS = [
  "query",
  "q",
  "sysparm_query",
  "subjectpatterns",
  "labels",
  "statuses"
];

var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function redactArgs(args: unknown): unknown {
  return walk(args, "");
}

function walk(value: unknown, keyPath: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, keyPath);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    var out: unknown[] = [];
    for (var i = 0; i < value.length; i++) {
      out.push(walk(value[i], keyPath));
    }
    return out;
  }
  if (typeof value === "object") {
    var record = value as Record<string, unknown>;
    var result: Record<string, unknown> = {};
    var keys = Object.keys(record);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var lowered = key.toLowerCase();
      if (TOKEN_KEYS.indexOf(lowered) !== -1) {
        result[key] = "[REDACTED]";
        continue;
      }
      if (BODY_KEYS.indexOf(lowered) !== -1 && typeof record[key] === "string") {
        result[key] = "[REDACTED:body]";
        continue;
      }
      result[key] = walk(record[key], lowered);
    }
    return result;
  }
  return value;
}

function redactString(value: string, keyPath: string): string {
  if (QUERY_KEYS.indexOf(keyPath) !== -1) {
    return value;
  }
  if (EMAIL_RE.test(value)) {
    return maskEmail(value);
  }
  if (value.length > 200) {
    return "sha256:" + sha256First12(value);
  }
  return value;
}

function maskEmail(addr: string): string {
  var at = addr.indexOf("@");
  if (at < 0) {
    return addr;
  }
  var local = addr.substring(0, at);
  var domain = addr.substring(at + 1);
  var prefix = local.length <= 3 ? local : local.substring(0, 3);
  return prefix + "***@" + domain;
}

function sha256First12(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").substring(0, 12);
}
