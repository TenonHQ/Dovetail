/**
 * dove-sn publish-app — publish a scoped application to the ServiceNow Store
 * and/or the company Application Repository, headlessly, then poll the
 * publish's progress tracker until it terminates.
 *
 * Two engines, one result shape:
 *
 *   STORE  — replays the sys_app form's "Publish to ServiceNow Store" flow
 *            (ground truth: HAR capture, 2026-07-16): a form-login session
 *            POSTs /xmlhttp.do with sysparm_processor=
 *            sn_appauthor.ScopedAppUploaderAJAX & sysparm_name=start (plus the
 *            Store account credentials), then polls AJAXProgressStatusChecker/
 *            getStatus with the returned execution sys_id. Basic auth alone
 *            NO-OPS on xmlhttp.do — the form session + X-UserToken is required
 *            (proven by the sn-undo-default-push headless revert).
 *
 *   REPO   — uses the supported CI/CD REST API: POST /api/sn_cicd/app_repo/publish
 *            (basic auth via the shared client), then polls
 *            GET /api/sn_cicd/progress/{id}. Requires the sn_cicd role (or admin).
 *
 * STORE PUBLISH IS EXTERNALLY VISIBLE on the ServiceNow Store — the verb
 * refuses to run either engine without confirm:true (dry-run is the default).
 *
 * Store account credentials resolve ONLY inside this module, from
 * SN_STORE_USERNAME / SN_STORE_PASSWORD (or injected params for tests). The
 * password is never logged, never echoed into notes or dry-run previews, and
 * never accepted as a CLI flag.
 */

import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import {
  resolveFormAuth,
  openFormSession,
  postForm,
  decodeHtmlEntities,
} from "./table";
import type { FormAuth, FormSession, PostResult } from "./table";

export type PublishTarget = "store" | "repo";

export interface PublishTransport {
  openSession?: (auth: FormAuth) => Promise<FormSession>;
  post?: (
    auth: FormAuth,
    session: FormSession,
    path: string,
    fields: Record<string, string>,
  ) => Promise<PostResult>;
  sleep?: (ms: number) => Promise<void>;
}

export interface PublishAppParams {
  /** Injectable for tests; defaults to createClient({}). */
  client?: ServiceNowClient;
  /** App selector: scope name (x_cadso_*), sys_app sys_id, or app name. */
  app: string;
  /** Version to publish, e.g. 6.0.20260716. Required — callers derive defaults. */
  version: string;
  devNotes?: string;
  /** One target per call — "both" is CLI-level sequencing. */
  target: PublishTarget;
  /** Store account email; falls back to SN_STORE_USERNAME (store target only). */
  storeUsername?: string;
  /** Test seam only — the CLI never passes this; env SN_STORE_PASSWORD is the real source. */
  storePassword?: string;
  instance?: string;
  user?: string;
  password?: string;
  /** The live gate: without confirm:true the result is a dry-run plan. */
  confirm?: boolean;
  dryRun?: boolean;
  timeoutMs?: number;
  /** Test seam — defaults to the real formSession functions + setTimeout sleep. */
  transport?: PublishTransport;
}

export interface PublishStep {
  name: string;
  state: string;
  percentComplete: string;
  message: string;
}

/** The AJAXProgressStatusChecker getStatus answer, decoded. state "2" = success. */
export interface ProgressNode {
  state: string;
  percent_complete?: string;
  message?: string;
  name?: string;
  result?: Record<string, string> | null;
  children?: Array<ProgressNode>;
}

export interface PublishAppResult {
  status: "dry-run" | "published" | "failed" | "timeout";
  target: PublishTarget;
  appSysId: string;
  appScope: string;
  appName: string;
  /** sys_app.version at plan time (before the publish). */
  versionBefore: string;
  /** The version that was (or would be) published. */
  version: string;
  /** Store: the progress-tracker sys_id. Repo: the CI/CD progress id. */
  executionSysId: string;
  /** Store leg only — root result["sys_update_set.sys_id"]; "" when absent. */
  updateSetSysId: string;
  /** Store: tpp.servicenow.com editapplication URL. Repo: "". */
  appLink: string;
  steps: Array<PublishStep>;
  polls: number;
  /** Root progress message (failure diagnostics live here). */
  message: string;
  /** Dry-run only — the request that would be sent, credentials MASKED. */
  requestPreview?: Record<string, string>;
  note: string;
}

export var DEFAULT_PUBLISH_TIMEOUT_MS = 120000;
/** Repeat the LAST delay until the budget is spent — a publish can outrun 15s. */
export var PUBLISH_POLL_DELAYS_MS: ReadonlyArray<number> = [
  1000, 1000, 2000, 2000, 5000,
];

var SYS_ID_RE = /^[0-9a-f]{32}$/;
var MASK = "***";

/**
 * Build the exact ScopedAppUploaderAJAX start-call field map the browser sends
 * (HAR ground truth). The repo variant is kept for parity/fixtures even though
 * the repo leg ships on the CI/CD API: publish_to_store=false, empty username,
 * and NO sysparm_password key at all.
 */
export function buildStartFields(p: {
  appSysId: string;
  version: string;
  devNotes: string;
  target: PublishTarget;
  storeUsername: string;
  storePassword: string;
}): Record<string, string> {
  var fields: Record<string, string> = {
    sysparm_processor: "sn_appauthor.ScopedAppUploaderAJAX",
    sysparm_name: "start",
    sysparm_scope: "global",
    sysparm_want_session_messages: "true",
    sysparm_sys_id: p.appSysId,
    // The UI sends a single space when the notes box is empty — mirror it.
    sysparm_dev_notes: p.devNotes || " ",
    sysparm_version: p.version,
    sysparm_target_upload_URL: "",
    sysparm_is_customization: "",
    "ni.nolog.x_referer": "ignore",
    x_referer: "sys_app.do?sys_id=" + p.appSysId,
  };
  if (p.target === "store") {
    fields.sysparm_publish_to_store = "true";
    fields.sysparm_username = p.storeUsername;
    fields.sysparm_password = p.storePassword;
  } else {
    fields.sysparm_publish_to_store = "false";
    fields.sysparm_username = "";
  }
  return fields;
}

/**
 * Extract the `answer` attribute from an xmlhttp.do response envelope
 * (`<xml answer="..." .../>`) and entity-decode it. A missing/empty answer is
 * returned as an error, never thrown — callers fold it into a failed result.
 */
export function parseXmlAnswer(xml: string): { answer: string; error: string } {
  if (typeof xml !== "string" || xml.length === 0) {
    return { answer: "", error: "empty xmlhttp.do response body" };
  }
  var m = /\banswer\s*=\s*"([^"]*)"/.exec(xml);
  if (!m) {
    return {
      answer: "",
      error:
        "no answer attribute in xmlhttp.do response: " + xml.slice(0, 200),
    };
  }
  return { answer: decodeHtmlEntities(m[1]), error: "" };
}

function isProgressNode(v: unknown): v is ProgressNode {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { state?: unknown }).state === "string"
  );
}

/**
 * Parse a decoded getStatus answer (a JSON progress tree). Throws a clear
 * error on malformed JSON or an unexpected shape — the poll loop surfaces it
 * as a failed result rather than a raw stack.
 */
export function parseProgressTree(decodedAnswer: string): ProgressNode {
  var parsed: unknown;
  try {
    parsed = JSON.parse(decodedAnswer);
  } catch (e) {
    throw new Error(
      "publish-app: getStatus answer is not valid JSON: " +
        decodedAnswer.slice(0, 200),
    );
  }
  if (!isProgressNode(parsed)) {
    throw new Error(
      "publish-app: getStatus answer is not a progress tree (no state field): " +
        decodedAnswer.slice(0, 200),
    );
  }
  return parsed;
}

/**
 * Terminal-state classification for the AJAX progress tracker.
 * "2" = Succeeded (HAR ground truth). "3"/"4" = Failed/Cancelled per the
 * GlideExecutionTracker state model. Anything else keeps polling until the
 * timeout budget — conservative on purpose: an unknown state must not be
 * reported as success OR failure.
 */
export function classifyProgress(root: ProgressNode): {
  terminal: boolean;
  success: boolean;
} {
  if (root.state === "2") return { terminal: true, success: true };
  if (root.state === "3" || root.state === "4") {
    return { terminal: true, success: false };
  }
  return { terminal: false, success: false };
}

/** Flatten the progress tree's children into an ordered step list. */
export function flattenSteps(root: ProgressNode): Array<PublishStep> {
  var out: Array<PublishStep> = [];
  function walk(node: ProgressNode): void {
    if (node !== root && node.name) {
      out.push({
        name: node.name,
        state: node.state,
        percentComplete: node.percent_complete || "",
        message: node.message || "",
      });
    }
    var children = node.children;
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i += 1) {
        if (isProgressNode(children[i])) walk(children[i]);
      }
    }
  }
  walk(root);
  return out;
}

/**
 * Harvest the interesting result values from the progress tree: the deepest
 * non-empty appLink/appName any node carries, and the root's update-set sys_id.
 */
export function harvestProgressResults(root: ProgressNode): {
  appLink: string;
  appName: string;
  updateSetSysId: string;
} {
  var appLink = "";
  var appName = "";
  var updateSetSysId = "";
  function walk(node: ProgressNode): void {
    var result = node.result;
    if (result && typeof result === "object") {
      if (typeof result.appLink === "string" && result.appLink && !appLink) {
        appLink = result.appLink;
      }
      if (typeof result.appName === "string" && result.appName && !appName) {
        appName = result.appName;
      }
      var us = result["sys_update_set.sys_id"];
      if (typeof us === "string" && us && !updateSetSysId) {
        updateSetSysId = us;
      }
    }
    var children = node.children;
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i += 1) {
        if (isProgressNode(children[i])) walk(children[i]);
      }
    }
  }
  walk(root);
  return { appLink: appLink, appName: appName, updateSetSysId: updateSetSysId };
}

/** CI/CD publish response: harvest the progress id (and echo status_label). */
export function parseCicdPublishResponse(body: unknown): {
  progressId: string;
  statusLabel: string;
  error: string;
} {
  if (typeof body !== "object" || body === null) {
    return { progressId: "", statusLabel: "", error: "empty CI/CD response" };
  }
  var result = (body as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) {
    return {
      progressId: "",
      statusLabel: "",
      error: "CI/CD response has no result object",
    };
  }
  var r = result as {
    links?: { progress?: { id?: unknown } };
    status_label?: unknown;
  };
  var id = "";
  if (
    r.links &&
    typeof r.links === "object" &&
    r.links.progress &&
    typeof r.links.progress === "object" &&
    typeof r.links.progress.id === "string"
  ) {
    id = r.links.progress.id;
  }
  var label = typeof r.status_label === "string" ? r.status_label : "";
  if (!id) {
    return {
      progressId: "",
      statusLabel: label,
      error: "CI/CD response carries no progress id",
    };
  }
  return { progressId: id, statusLabel: label, error: "" };
}

export interface CicdProgress {
  /** "0" pending, "1" running, "2" successful, "3" failed, "4" cancelled. */
  status: string;
  statusLabel: string;
  statusMessage: string;
  statusDetail: string;
  percentComplete: string;
}

/** CI/CD progress response → a typed snapshot. Unknown shapes become status "". */
export function parseCicdProgress(body: unknown): CicdProgress {
  var empty: CicdProgress = {
    status: "",
    statusLabel: "",
    statusMessage: "",
    statusDetail: "",
    percentComplete: "",
  };
  if (typeof body !== "object" || body === null) return empty;
  var result = (body as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return empty;
  var r = result as Record<string, unknown>;
  function str(v: unknown): string {
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return "";
  }
  return {
    status: str(r.status),
    statusLabel: str(r.status_label),
    statusMessage: str(r.status_message),
    statusDetail: str(r.status_detail),
    percentComplete: str(r.percent_complete),
  };
}

function realSleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

interface ResolvedApp {
  sysId: string;
  scope: string;
  name: string;
  version: string;
}

async function resolveApp(
  client: ServiceNowClient,
  selector: string,
): Promise<ResolvedApp> {
  var fields = ["sys_id", "scope", "name", "version"];
  var queries: Array<string> = [];
  if (SYS_ID_RE.test(selector)) {
    queries.push("sys_id=" + selector);
  } else {
    queries.push("scope=" + selector);
    queries.push("name=" + selector);
  }
  for (var i = 0; i < queries.length; i += 1) {
    var rows = await client.table.query<Record<string, string>>(
      "sys_app",
      queries[i],
      { limit: 2, fields: fields },
    );
    if (rows.length === 1) {
      return {
        sysId: rows[0].sys_id || "",
        scope: rows[0].scope || "",
        name: rows[0].name || "",
        version: rows[0].version || "",
      };
    }
    if (rows.length > 1) {
      throw new Error(
        "publish-app: app selector '" +
          selector +
          "' matches more than one sys_app row — use the scope or sys_id.",
      );
    }
  }
  throw new Error(
    "publish-app: no sys_app row matches '" +
      selector +
      "' (tried " +
      queries.join(", then ") +
      ").",
  );
}

function baseResult(
  target: PublishTarget,
  app: ResolvedApp,
  version: string,
): PublishAppResult {
  return {
    status: "failed",
    target: target,
    appSysId: app.sysId,
    appScope: app.scope,
    appName: app.name,
    versionBefore: app.version,
    version: version,
    executionSysId: "",
    updateSetSysId: "",
    appLink: "",
    steps: [],
    polls: 0,
    message: "",
    note: "",
  };
}

function resolveStoreCreds(params: PublishAppParams): {
  username: string;
  password: string;
} {
  var username = params.storeUsername || process.env.SN_STORE_USERNAME || "";
  var password = params.storePassword || process.env.SN_STORE_PASSWORD || "";
  if (!username || !password) {
    throw new Error(
      "publish-app: Store credentials missing — set SN_STORE_USERNAME and " +
        "SN_STORE_PASSWORD in the env file the verb loads (--env). The " +
        "password is never accepted as a flag.",
    );
  }
  return { username: username, password: password };
}

async function publishToStore(
  params: PublishAppParams,
  app: ResolvedApp,
): Promise<PublishAppResult> {
  var result = baseResult("store", app, params.version);
  var creds = resolveStoreCreds(params);
  var transport = params.transport || {};
  var openSession = transport.openSession || openFormSession;
  var post = transport.post || postForm;
  var sleepFn = transport.sleep || realSleep;
  var timeoutMs =
    params.timeoutMs != null ? params.timeoutMs : DEFAULT_PUBLISH_TIMEOUT_MS;

  var auth = resolveFormAuth({
    instance: params.instance,
    user: params.user,
    password: params.password,
  });
  var session = await openSession(auth);

  var startFields = buildStartFields({
    appSysId: app.sysId,
    version: params.version,
    devNotes: params.devNotes || "",
    target: "store",
    storeUsername: creds.username,
    storePassword: creds.password,
  });
  var startRes = await post(auth, session, "/xmlhttp.do", startFields);
  if (startRes.status < 200 || startRes.status >= 300) {
    result.message = "start call returned HTTP " + startRes.status;
    result.note =
      "publish-app: the ScopedAppUploaderAJAX start call failed (HTTP " +
      startRes.status +
      "): " +
      (startRes.body || "").slice(0, 200);
    return result;
  }
  var startAnswer = parseXmlAnswer(startRes.body);
  if (startAnswer.error || !SYS_ID_RE.test(startAnswer.answer)) {
    result.message = startAnswer.error || "answer is not a sys_id";
    result.note =
      "publish-app: the start call did not return an execution sys_id — " +
      (startAnswer.error ||
        "got '" + startAnswer.answer.slice(0, 64) + "'") +
      ". The upload never started.";
    return result;
  }
  result.executionSysId = startAnswer.answer;

  var startedAt = Date.now();
  var pollIndex = 0;
  while (true) {
    var delay =
      PUBLISH_POLL_DELAYS_MS[
        Math.min(pollIndex, PUBLISH_POLL_DELAYS_MS.length - 1)
      ];
    if (Date.now() - startedAt + delay > timeoutMs) {
      result.status = "timeout";
      result.note =
        "publish-app: progress tracker " +
        result.executionSysId +
        " did not terminate within " +
        timeoutMs +
        "ms after " +
        result.polls +
        " poll(s). Check /sys_execution_tracker.do?sys_id=" +
        result.executionSysId +
        " on the instance.";
      return result;
    }
    await sleepFn(delay);
    pollIndex += 1;
    result.polls += 1;

    var pollRes = await post(auth, session, "/xmlhttp.do", {
      sysparm_processor: "AJAXProgressStatusChecker",
      sysparm_name: "getStatus",
      sysparm_scope: "global",
      sysparm_want_session_messages: "true",
      sysparm_execution_id: result.executionSysId,
      "ni.nolog.x_referer": "ignore",
      x_referer: "sys_app.do?sys_id=" + app.sysId,
    });
    if (pollRes.status < 200 || pollRes.status >= 300) {
      result.message = "getStatus returned HTTP " + pollRes.status;
      result.note =
        "publish-app: progress poll failed (HTTP " +
        pollRes.status +
        ") — tracker " +
        result.executionSysId +
        " may still be running on the instance.";
      return result;
    }
    var pollAnswer = parseXmlAnswer(pollRes.body);
    if (pollAnswer.error) {
      result.message = pollAnswer.error;
      result.note =
        "publish-app: could not read the progress answer — " + pollAnswer.error;
      return result;
    }
    var tree: ProgressNode;
    try {
      tree = parseProgressTree(pollAnswer.answer);
    } catch (e) {
      result.message = e instanceof Error ? e.message : String(e);
      result.note = result.message;
      return result;
    }
    var state = classifyProgress(tree);
    if (!state.terminal) continue;

    result.steps = flattenSteps(tree);
    result.message = tree.message || "";
    var harvested = harvestProgressResults(tree);
    result.appLink = harvested.appLink;
    result.updateSetSysId = harvested.updateSetSysId;
    if (state.success) {
      result.status = "published";
      result.note =
        "Published " +
        app.name +
        " v" +
        params.version +
        " to the ServiceNow Store" +
        (result.appLink ? " — " + result.appLink : "") +
        " (" +
        result.polls +
        " poll(s)).";
    } else {
      result.status = "failed";
      result.note =
        "publish-app: store publish terminated in state " +
        tree.state +
        (result.message ? " — " + result.message : "") +
        ". Tracker " +
        result.executionSysId +
        ".";
    }
    return result;
  }
}

async function publishToRepo(
  params: PublishAppParams,
  app: ResolvedApp,
  client: ServiceNowClient,
): Promise<PublishAppResult> {
  var result = baseResult("repo", app, params.version);
  var transport = params.transport || {};
  var sleepFn = transport.sleep || realSleep;
  var timeoutMs =
    params.timeoutMs != null ? params.timeoutMs : DEFAULT_PUBLISH_TIMEOUT_MS;

  var path =
    "/api/sn_cicd/app_repo/publish?sys_id=" +
    encodeURIComponent(app.sysId) +
    "&version=" +
    encodeURIComponent(params.version);
  if (params.devNotes) {
    path += "&dev_notes=" + encodeURIComponent(params.devNotes);
  }
  var res = await client.now.invoke({ method: "POST", path: path });
  if (res.status === 401 || res.status === 403) {
    result.message = "HTTP " + res.status + " from the CI/CD API";
    result.note =
      "publish-app: the CI/CD publish was refused (HTTP " +
      res.status +
      ") — the API user needs the sn_cicd role (or admin) and the CI/CD " +
      "plugin must be active.";
    return result;
  }
  if (res.status < 200 || res.status >= 300) {
    result.message = "HTTP " + res.status + " from the CI/CD API";
    result.note =
      "publish-app: POST /api/sn_cicd/app_repo/publish failed (HTTP " +
      res.status +
      "): " +
      JSON.stringify(res.body).slice(0, 300) +
      " — a version at or below the app's current repo version is the usual cause.";
    return result;
  }
  var publishRes = parseCicdPublishResponse(res.body);
  if (publishRes.error) {
    result.message = publishRes.error;
    result.note =
      "publish-app: the CI/CD publish response is missing its progress link — " +
      publishRes.error;
    return result;
  }
  result.executionSysId = publishRes.progressId;

  var startedAt = Date.now();
  var pollIndex = 0;
  while (true) {
    var delay =
      PUBLISH_POLL_DELAYS_MS[
        Math.min(pollIndex, PUBLISH_POLL_DELAYS_MS.length - 1)
      ];
    if (Date.now() - startedAt + delay > timeoutMs) {
      result.status = "timeout";
      result.note =
        "publish-app: CI/CD progress " +
        result.executionSysId +
        " did not terminate within " +
        timeoutMs +
        "ms after " +
        result.polls +
        " poll(s). Check GET /api/sn_cicd/progress/" +
        result.executionSysId +
        ".";
      return result;
    }
    await sleepFn(delay);
    pollIndex += 1;
    result.polls += 1;

    var progRes = await client.now.invoke({
      method: "GET",
      path: "/api/sn_cicd/progress/" + encodeURIComponent(result.executionSysId),
    });
    if (progRes.status < 200 || progRes.status >= 300) {
      result.message = "HTTP " + progRes.status + " from the CI/CD progress API";
      result.note =
        "publish-app: CI/CD progress poll failed (HTTP " +
        progRes.status +
        ") — progress id " +
        result.executionSysId +
        ".";
      return result;
    }
    var progress = parseCicdProgress(progRes.body);
    result.message = progress.statusMessage || progress.statusLabel;
    if (progress.status === "2") {
      result.status = "published";
      result.steps = [
        {
          name: "CI/CD app_repo publish",
          state: progress.status,
          percentComplete: progress.percentComplete,
          message: result.message,
        },
      ];
      result.note =
        "Published " +
        app.name +
        " v" +
        params.version +
        " to the application repository (" +
        result.polls +
        " poll(s)).";
      return result;
    }
    if (progress.status === "3" || progress.status === "4") {
      result.status = "failed";
      result.steps = [
        {
          name: "CI/CD app_repo publish",
          state: progress.status,
          percentComplete: progress.percentComplete,
          message: progress.statusDetail || result.message,
        },
      ];
      result.note =
        "publish-app: CI/CD publish terminated " +
        (progress.statusLabel || "in state " + progress.status) +
        (progress.statusDetail ? " — " + progress.statusDetail : "") +
        ".";
      return result;
    }
    // "0" pending / "1" running / unknown — keep polling until the budget ends.
  }
}

function maskedPreview(
  target: PublishTarget,
  app: ResolvedApp,
  params: PublishAppParams,
): Record<string, string> {
  if (target === "store") {
    var username = params.storeUsername || process.env.SN_STORE_USERNAME || "";
    var hasPassword = Boolean(
      params.storePassword || process.env.SN_STORE_PASSWORD,
    );
    var fields = buildStartFields({
      appSysId: app.sysId,
      version: params.version,
      devNotes: params.devNotes || "",
      target: "store",
      storeUsername: username || MASK,
      storePassword: hasPassword ? MASK : "(MISSING — set SN_STORE_PASSWORD)",
    });
    // Belt and braces: the preview never carries a real password.
    fields.sysparm_password = hasPassword
      ? MASK
      : "(MISSING — set SN_STORE_PASSWORD)";
    return fields;
  }
  var preview: Record<string, string> = {
    method: "POST",
    path:
      "/api/sn_cicd/app_repo/publish?sys_id=" +
      app.sysId +
      "&version=" +
      params.version,
  };
  if (params.devNotes) preview.dev_notes = params.devNotes;
  return preview;
}

export async function publishApp(
  params: PublishAppParams,
): Promise<PublishAppResult> {
  if (!params || typeof params !== "object") {
    throw new Error("publish-app: params object is required.");
  }
  if (!params.app) {
    throw new Error("publish-app: app (scope, sys_id, or name) is required.");
  }
  if (!params.version) {
    throw new Error("publish-app: version is required.");
  }
  if (params.target !== "store" && params.target !== "repo") {
    throw new Error(
      "publish-app: target must be 'store' or 'repo' (got '" +
        String(params.target) +
        "').",
    );
  }
  var live = params.confirm === true && params.dryRun !== true;
  // Fail fast on missing Store creds BEFORE any network work — a live run that
  // resolves the app and only then discovers the missing password wastes the
  // caller's confirm. Dry-runs still render (with the gap flagged in the preview).
  if (live && params.target === "store") {
    resolveStoreCreds(params);
  }

  var client = params.client || createClient({});
  var app = await resolveApp(client, params.app);

  if (!live) {
    var dry = baseResult(params.target, app, params.version);
    dry.status = "dry-run";
    dry.requestPreview = maskedPreview(params.target, app, params);
    dry.note =
      "dry-run: nothing was published. Would publish " +
      app.name +
      " (" +
      app.scope +
      ", current version " +
      app.version +
      ") as v" +
      params.version +
      " to the " +
      (params.target === "store"
        ? "ServiceNow Store (EXTERNALLY VISIBLE)"
        : "application repository") +
      ". Re-run with confirm to publish.";
    return dry;
  }

  if (params.target === "store") {
    return publishToStore(params, app);
  }
  return publishToRepo(params, app, client);
}
