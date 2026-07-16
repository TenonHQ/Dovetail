/**
 * dove-sn invoke-rest — invoke an arbitrary authenticated ServiceNow REST
 * operation (an application's own Scripted REST endpoints included) with
 * GET / POST / PUT / DELETE. The transport primitive behind the invoke_rest
 * MCP tool (TenonHQ/Dovetail#212).
 *
 * DRY-RUN BY DEFAULT: without confirm:true the resolved method + path + body
 * are echoed back and nothing is sent (no client, no credentials needed).
 * On confirm the response comes back verbatim as { httpStatus, ok, body } —
 * non-2xx responses are returned, not thrown, so a Scripted REST operation's
 * own error contract passes through faithfully (the transport still retries
 * 429/5xx first).
 *
 * PRIVACY: these endpoints carry caller payloads. This module never logs a
 * request or response body — no console output, no debug files; bodies exist
 * only in the returned result. Any log line about an invocation elsewhere must
 * carry method, path and status ONLY.
 */

import { createClient } from "./client";
import type { NowInvokeMethod, ServiceNowClient } from "./client";

export var INVOKE_REST_METHODS: Array<NowInvokeMethod> = ["GET", "POST", "PUT", "DELETE"];

export interface InvokeRestParams {
  /** Optional client injection (tests / reuse). Only resolved on the send path —
   *  a dry-run needs no credentials. */
  client?: ServiceNowClient;
  /** HTTP method — GET, POST, PUT or DELETE (case-insensitive). */
  method: string;
  /** Instance-relative path; must start with /api/ (e.g. /api/x_cadso_core/<service>/<resource>). */
  path: string;
  /** JSON request body for POST/PUT/DELETE. Rejected for GET. */
  body?: unknown;
  /** The send gate: the request is only sent when confirm is exactly true. */
  confirm?: boolean;
  /** Force a dry-run even when confirm is set. */
  dryRun?: boolean;
}

export interface InvokeRestResult {
  status: "dry-run" | "sent";
  method: NowInvokeMethod;
  path: string;
  /** Echo of the request body (present when one was supplied) so the plan is auditable. */
  requestBody?: unknown;
  /** HTTP status of the response (sent only). */
  httpStatus?: number;
  /** True when httpStatus is 2xx (sent only). */
  ok?: boolean;
  /** Response body, verbatim (sent only). */
  body?: unknown;
  note: string;
}

function normalizeMethod(method: unknown): NowInvokeMethod {
  var raw = typeof method === "string" ? method.toUpperCase() : "";
  if (INVOKE_REST_METHODS.indexOf(raw as NowInvokeMethod) === -1) {
    throw new Error(
      "invoke-rest: method must be one of GET, POST, PUT, DELETE (got '"
        + String(method) + "')."
    );
  }
  return raw as NowInvokeMethod;
}

function validatePath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("invoke-rest: path is required.");
  }
  if (path.indexOf("/api/") !== 0) {
    throw new Error(
      "invoke-rest: path must be instance-relative and start with /api/ (got '"
        + path + "'). Absolute URLs are not accepted — the client's base URL supplies the instance."
    );
  }
  if (/\s/.test(path)) {
    throw new Error("invoke-rest: path must not contain whitespace — URL-encode query values.");
  }
  return path;
}

export async function invokeRest(params: InvokeRestParams): Promise<InvokeRestResult> {
  if (!params || typeof params !== "object") {
    throw new Error("invoke-rest: params object is required.");
  }
  var method = normalizeMethod(params.method);
  var path = validatePath(params.path);
  if (method === "GET" && params.body !== undefined) {
    throw new Error("invoke-rest: a request body is not allowed with GET.");
  }

  var send = params.confirm === true && params.dryRun !== true;
  if (!send) {
    var dry: InvokeRestResult = {
      status: "dry-run",
      method: method,
      path: path,
      note: "dry-run (the default): nothing was sent. Would " + method + " " + path
        + (params.body !== undefined ? " with the supplied JSON body" : " with no body")
        + ". Re-run with confirm to send."
    };
    if (params.body !== undefined) {
      dry.requestBody = params.body;
    }
    return dry;
  }

  // Client is resolved only here so a dry-run never needs credentials.
  var client = params.client || createClient({});
  var response = await client.now.invoke({ method: method, path: path, body: params.body });
  var ok = response.status >= 200 && response.status < 300;

  var result: InvokeRestResult = {
    status: "sent",
    method: method,
    path: path,
    httpStatus: response.status,
    ok: ok,
    body: response.body,
    note: ok
      ? "Sent " + method + " " + path + " — HTTP " + response.status + "."
      : "Sent " + method + " " + path + " — HTTP " + response.status
        + " (non-2xx returned verbatim"
        + (response.status === 401 || response.status === 403
          ? "; if unexpected, check SN_USER/SN_PASSWORD and ACLs" : "")
        + ")."
  };
  if (params.body !== undefined) {
    result.requestBody = params.body;
  }
  return result;
}

/**
 * Write an invoke-rest result to a file as pretty-printed JSON — the
 * first-class landing spot for large responses (piped stdout truncates at the
 * OS pipe buffer if the process exits before draining; see the CLI's
 * flush-aware exit). ATOMIC: writes to a same-directory temp file then
 * renames, so a killed process leaves either the old file or the new one —
 * never a silently-truncated hybrid. Overwrites an existing file by design
 * (documented in --help). The parent directory must already exist; a missing
 * or unwritable directory throws with the underlying error so the CLI can
 * exit 1 loudly instead of "succeeding" with no file.
 */
export function writeInvokeRestResultFile(outPath: string, result: unknown): void {
  var fs = require("fs") as typeof import("fs");
  var pathMod = require("path") as typeof import("path");
  var dir = pathMod.dirname(outPath);
  var tempPath = pathMod.join(
    dir,
    "." + pathMod.basename(outPath) + ".tmp-" + process.pid + "-" + Date.now(),
  );
  var payload = JSON.stringify(result, null, 2) + "\n";
  try {
    fs.writeFileSync(tempPath, payload, { encoding: "utf8" });
    fs.renameSync(tempPath, outPath);
  } catch (err) {
    // Best-effort temp cleanup so a failed write leaves no residue.
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupErr) {
      // The temp file never landed — nothing to clean.
    }
    throw err;
  }
}
