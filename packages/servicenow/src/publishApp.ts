/**
 * dove-sn publish-app — publish a scoped application to the ServiceNow Store,
 * the company Application Repository, and/or a new update set, headlessly, then
 * poll each publish's progress tracker until it terminates.
 *
 * Three engines, one result shape:
 *
 *   UPLOADER — replays the sys_app form's upload flow (ground truth: HAR
 *            captures 2026-07-16 and 2026-07-29): a form-login session POSTs
 *            /xmlhttp.do with sysparm_processor=
 *            sn_appauthor.ScopedAppUploaderAJAX & sysparm_name=start, then polls
 *            AJAXProgressStatusChecker/getStatus with the returned execution
 *            sys_id. Basic auth alone NO-OPS on xmlhttp.do — the form session +
 *            X-UserToken is required (proven by the sn-undo-default-push
 *            headless revert). Serves BOTH the "store" target
 *            (sysparm_publish_to_store=true, plus Store credentials) and the
 *            "repo-ui" target (=false, no credentials) — the destination is one
 *            flag apart.
 *
 *   REPO   — uses the supported CI/CD REST API: POST /api/sn_cicd/app_repo/publish
 *            (basic auth via the shared client), then polls
 *            GET /api/sn_cicd/progress/{id}. Requires the sn_cicd role (or admin).
 *            NOTE: the plugin is absent on some instances (tenonworkshop has no
 *            sn_cicd scope and no app_repo service) — use "repo-ui" there.
 *
 *   UPDATE-SET — replays the "Publish to Update Set" dialog: two POSTs to
 *            /xmlhttp.do against com.snc.apps.AppsAjaxProcessor —
 *            sysparm_function=createUpdateSet (answers the new sys_update_set
 *            sys_id), then =publishToUpdateSet (answers a progress worker id) —
 *            polled through the same AJAXProgressStatusChecker as the uploader.
 *            There is no REST equivalent for this operation.
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

/**
 * - "store"      — ServiceNow Store, via ScopedAppUploaderAJAX (UI replay).
 * - "repo"       — company app repository, via the sn_cicd CI/CD REST API.
 * - "repo-ui"    — company app repository, via ScopedAppUploaderAJAX (UI replay).
 *                  Use when the CI/CD plugin is absent: tenonworkshop has no
 *                  sn_cicd scope and no app_repo service, so "repo" 404s there
 *                  while the UI path (HAR-proven) works.
 * - "update-set" — publish the app INTO a new update set, via the two-call
 *                  com.snc.apps.AppsAjaxProcessor flow. No REST equivalent.
 */
export type PublishTarget = "store" | "repo" | "repo-ui" | "update-set";

export var PUBLISH_TARGETS: ReadonlyArray<string> = [
  "store",
  "repo",
  "repo-ui",
  "update-set",
];

/**
 * Expand a CLI --target value into an ordered target list.
 *
 * "both" stays an alias for store,repo (back-compat). Anything else may be a
 * comma-separated list, so one invocation can publish to the app repository AND
 * capture the app into an update set — the order given is the order run.
 * Returns { targets } on success or { error } with a caller-printable message;
 * never throws, so the CLI can exit 1 cleanly on bad input.
 */
export function parsePublishTargets(raw: string): {
  targets: Array<PublishTarget>;
  error: string;
} {
  var value = String(raw || "").trim();
  if (value === "both") {
    return { targets: ["store", "repo"], error: "" };
  }
  var parts = value
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
  if (parts.length === 0) {
    return { targets: [], error: "--target is empty" };
  }
  for (var i = 0; i < parts.length; i += 1) {
    if (PUBLISH_TARGETS.indexOf(parts[i]) === -1) {
      return {
        targets: [],
        error:
          "--target must be one of " +
          PUBLISH_TARGETS.join(", ") +
          ", 'both', or a comma-separated list of them (got '" +
          parts[i] +
          "')",
      };
    }
  }
  return { targets: parts as Array<PublishTarget>, error: "" };
}

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
  /**
   * update-set target only — the name of the update set to create. Defaults to
   * the app's name, which is exactly what the UI dialog submits (its app_name
   * input is readonly), so the default reproduces the manual flow.
   */
  updateSetName?: string;
  /**
   * update-set target only — the update set's description. Tenon convention is
   * the release date stamp (YYYYMMDD) so a whole release is one query:
   * sys_update_set where description=<stamp>.
   */
  updateSetDescription?: string;
  /**
   * update-set target only — the dialog's "Include demo data" checkbox. The
   * checkbox renders checked, but the captured HAR sent an EMPTY string, so the
   * default here reproduces the observed wire value rather than the markup.
   */
  includeData?: boolean;
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
  /**
   * Store/repo-ui/update-set: the progress-tracker sys_id (the update-set leg's
   * <workerid>). Repo: the CI/CD progress id.
   */
  executionSysId: string;
  /**
   * Store: harvested from root result["sys_update_set.sys_id"].
   * update-set: the sys_update_set created by createUpdateSet — the whole point
   * of the call, so it is set BEFORE the publish is polled and survives a
   * failure (the set exists on the instance either way, and the caller needs
   * the sys_id to clean up). "" when absent.
   */
  updateSetSysId: string;
  /** Store: tpp.servicenow.com editapplication URL. Everything else: "". */
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

var APPS_AJAX_PROCESSOR = "com.snc.apps.AppsAjaxProcessor";

/**
 * Field map for AppsAjaxProcessor.createUpdateSet — call 1 of the two-call
 * "Publish to Update Set" flow (HAR ground truth). The answer attribute is the
 * new sys_update_set sys_id.
 *
 * The app sys_id rides as `sysparm_appid` HERE but as `sysparm_sys_id` in call
 * 2 (and `sysparm_app_id` in the version validator). The platform spells it
 * differently per function and they are NOT interchangeable.
 */
export function buildCreateUpdateSetFields(p: {
  appSysId: string;
  updateSetName: string;
  description: string;
}): Record<string, string> {
  return {
    sysparm_processor: APPS_AJAX_PROCESSOR,
    sysparm_scope: "global",
    sysparm_want_session_messages: "true",
    sysparm_function: "createUpdateSet",
    sysparm_name: p.updateSetName,
    sysparm_appid: p.appSysId,
    sysparm_description: p.description,
    // "false" = create the set but do NOT adopt it as the session's current
    // update set. A batch that flipped the session set would silently capture
    // unrelated writes into the last app's set.
    sysparm_current: "false",
    "ni.nolog.x_referer": "ignore",
    x_referer: "sys_app.do?sys_id=" + p.appSysId,
  };
}

/**
 * Field map for AppsAjaxProcessor.publishToUpdateSet — call 2. The answer
 * attribute is the progress-worker sys_id (echoed as a <workerid> element).
 *
 * `sysparm_name` is the literal "start", NOT a name: the dialog composes an
 * "<app> - <version>" label, but the generic progress viewer overwrites
 * sysparm_name with "start" before the request leaves the browser, so the
 * composed label never reaches the wire. The set keeps the name call 1 gave it.
 */
export function buildPublishToUpdateSetFields(p: {
  appSysId: string;
  updateSetSysId: string;
  version: string;
  description: string;
  includeData: boolean;
}): Record<string, string> {
  return {
    sysparm_processor: APPS_AJAX_PROCESSOR,
    sysparm_scope: "global",
    sysparm_want_session_messages: "true",
    sysparm_function: "publishToUpdateSet",
    sysparm_update_set_id: p.updateSetSysId,
    sysparm_sys_id: p.appSysId,
    sysparm_name: "start",
    sysparm_version: p.version,
    sysparm_description: p.description,
    // The captured HAR sent an EMPTY string here even though the "Include demo
    // data" checkbox renders checked — empty is the observed wire default and
    // "true" is the explicit opt-in.
    sysparm_include_data: p.includeData ? "true" : "",
    sysparm_progress_name: "Publishing application",
    sysparm_ajax_processor: APPS_AJAX_PROCESSOR,
    sysparm_show_done_button: "true",
    "ni.nolog.x_referer": "ignore",
    x_referer: "sys_app.do?sys_id=" + p.appSysId,
  };
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
      error: "no answer attribute in xmlhttp.do response: " + xml.slice(0, 200),
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
 * Harvest the interesting result values from the progress tree, walking
 * root-down: the FIRST non-empty appLink/appName/update-set sys_id encountered
 * wins and is never overwritten. In the observed HAR trees each value appears
 * on exactly one node, so first-wins is equivalent — the rule just needs to be
 * deterministic.
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

/**
 * Resolve the update set's name and description.
 *
 * The name defaults to the app's name because the dialog's `app_name` input is
 * READONLY — the bare app name is what the UI submits, and the live record
 * confirms it (HAR createUpdateSet answer 2d368e8f… → sys_update_set named
 * "@tenon/ui-side-modal"). The description defaults to empty; callers wanting
 * the release-query convention pass the YYYYMMDD stamp.
 */
export function resolveUpdateSetNaming(p: {
  updateSetName?: string;
  updateSetDescription?: string;
  appName: string;
}): { name: string; description: string } {
  var name = typeof p.updateSetName === "string" ? p.updateSetName.trim() : "";
  if (!name) name = String(p.appName || "").trim();
  if (!name) {
    throw new Error(
      "publish-app: the update-set target needs an update set name, and the " +
        "resolved app has no name — pass updateSetName explicitly.",
    );
  }
  var description =
    typeof p.updateSetDescription === "string" ? p.updateSetDescription : "";
  return { name: name, description: description };
}

/**
 * Poll AJAXProgressStatusChecker until the tracker reaches a terminal state.
 *
 * Mutates `result` (polls / status / message / note / steps) and returns the
 * terminal progress tree — or `null` when the caller should return immediately
 * because the outcome is already written onto `result` (timeout, transport
 * failure, or an unparseable answer).
 *
 * Shared by every UI-replay target: the Store upload, the app-repo upload, and
 * the update-set publish all report through this one tracker endpoint.
 */
async function pollAjaxProgress(p: {
  result: PublishAppResult;
  auth: FormAuth;
  session: FormSession;
  post: NonNullable<PublishTransport["post"]>;
  sleepFn: NonNullable<PublishTransport["sleep"]>;
  appSysId: string;
  timeoutMs: number;
}): Promise<ProgressNode | null> {
  var result = p.result;
  var startedAt = Date.now();
  var pollIndex = 0;
  while (true) {
    var delay =
      PUBLISH_POLL_DELAYS_MS[
        Math.min(pollIndex, PUBLISH_POLL_DELAYS_MS.length - 1)
      ];
    if (Date.now() - startedAt + delay > p.timeoutMs) {
      result.status = "timeout";
      result.note =
        "publish-app: progress tracker " +
        result.executionSysId +
        " did not terminate within " +
        p.timeoutMs +
        "ms after " +
        result.polls +
        " poll(s). Check /sys_execution_tracker.do?sys_id=" +
        result.executionSysId +
        " on the instance.";
      return null;
    }
    await p.sleepFn(delay);
    pollIndex += 1;
    result.polls += 1;

    var pollRes = await p.post(p.auth, p.session, "/xmlhttp.do", {
      sysparm_processor: "AJAXProgressStatusChecker",
      sysparm_name: "getStatus",
      sysparm_scope: "global",
      sysparm_want_session_messages: "true",
      sysparm_execution_id: result.executionSysId,
      "ni.nolog.x_referer": "ignore",
      x_referer: "sys_app.do?sys_id=" + p.appSysId,
    });
    if (pollRes.status < 200 || pollRes.status >= 300) {
      result.message = "getStatus returned HTTP " + pollRes.status;
      result.note =
        "publish-app: progress poll failed (HTTP " +
        pollRes.status +
        ") — tracker " +
        result.executionSysId +
        " may still be running on the instance.";
      return null;
    }
    var pollAnswer = parseXmlAnswer(pollRes.body);
    if (pollAnswer.error) {
      result.message = pollAnswer.error;
      result.note =
        "publish-app: could not read the progress answer — " + pollAnswer.error;
      return null;
    }
    var tree: ProgressNode;
    try {
      tree = parseProgressTree(pollAnswer.answer);
    } catch (e) {
      result.message = e instanceof Error ? e.message : String(e);
      result.note = result.message;
      return null;
    }
    if (!classifyProgress(tree).terminal) continue;

    result.steps = flattenSteps(tree);
    result.message = tree.message || "";
    return tree;
  }
}

/**
 * ScopedAppUploaderAJAX upload — the engine behind BOTH the Store publish and
 * the company-app-repo publish. The two differ only by
 * `sysparm_publish_to_store` and whether Store credentials are attached; the
 * session, the start call, and the progress tracker are identical.
 */
async function publishViaUploader(
  params: PublishAppParams,
  app: ResolvedApp,
  target: "store" | "repo-ui",
): Promise<PublishAppResult> {
  var result = baseResult(target, app, params.version);
  // repo-ui never carries Store credentials: publish_to_store=false makes the
  // processor ignore them, and requiring SN_STORE_* would block an internal
  // publish on a Store account it does not need.
  var creds =
    target === "store"
      ? resolveStoreCreds(params)
      : { username: "", password: "" };
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
    target: target,
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
      (startAnswer.error || "got '" + startAnswer.answer.slice(0, 64) + "'") +
      ". The upload never started.";
    return result;
  }
  result.executionSysId = startAnswer.answer;

  var tree = await pollAjaxProgress({
    result: result,
    auth: auth,
    session: session,
    post: post,
    sleepFn: sleepFn,
    appSysId: app.sysId,
    timeoutMs: timeoutMs,
  });
  if (!tree) return result;

  var harvested = harvestProgressResults(tree);
  result.appLink = harvested.appLink;
  result.updateSetSysId = harvested.updateSetSysId;
  if (classifyProgress(tree).success) {
    result.status = "published";
    result.note =
      "Published " +
      app.name +
      " v" +
      params.version +
      " to " +
      (target === "store"
        ? "the ServiceNow Store"
        : "the company application repository") +
      (result.appLink ? " — " + result.appLink : "") +
      " (" +
      result.polls +
      " poll(s)).";
  } else {
    result.status = "failed";
    result.note =
      "publish-app: " +
      (target === "store" ? "store" : "app-repo") +
      " publish terminated in state " +
      tree.state +
      (result.message ? " — " + result.message : "") +
      ". Tracker " +
      result.executionSysId +
      ".";
  }
  return result;
}

/**
 * "Publish to Update Set" — the two-call AppsAjaxProcessor flow, replayed over
 * the same form session. Call 1 creates the sys_update_set; call 2 publishes
 * the app into it under a progress worker.
 *
 * `updateSetSysId` is recorded the moment call 1 answers, BEFORE the publish is
 * polled: if call 2 or the worker fails, the set still exists on the instance
 * and the caller needs its sys_id to inspect or delete it.
 */
async function publishToUpdateSet(
  params: PublishAppParams,
  app: ResolvedApp,
): Promise<PublishAppResult> {
  var result = baseResult("update-set", app, params.version);
  var naming = resolveUpdateSetNaming({
    updateSetName: params.updateSetName,
    updateSetDescription: params.updateSetDescription,
    appName: app.name,
  });
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

  // --- call 1: createUpdateSet ---
  var createRes = await post(
    auth,
    session,
    "/xmlhttp.do",
    buildCreateUpdateSetFields({
      appSysId: app.sysId,
      updateSetName: naming.name,
      description: naming.description,
    }),
  );
  if (createRes.status < 200 || createRes.status >= 300) {
    result.message = "createUpdateSet returned HTTP " + createRes.status;
    result.note =
      "publish-app: createUpdateSet failed (HTTP " +
      createRes.status +
      "): " +
      (createRes.body || "").slice(0, 200) +
      ". No update set was created.";
    return result;
  }
  var createAnswer = parseXmlAnswer(createRes.body);
  if (createAnswer.error || !SYS_ID_RE.test(createAnswer.answer)) {
    result.message = createAnswer.error || "answer is not a sys_id";
    result.note =
      "publish-app: createUpdateSet did not return an update set sys_id — " +
      (createAnswer.error || "got '" + createAnswer.answer.slice(0, 64) + "'") +
      ". Nothing was published.";
    return result;
  }
  result.updateSetSysId = createAnswer.answer;

  // --- call 2: publishToUpdateSet ---
  var publishRes = await post(
    auth,
    session,
    "/xmlhttp.do",
    buildPublishToUpdateSetFields({
      appSysId: app.sysId,
      updateSetSysId: result.updateSetSysId,
      version: params.version,
      description: naming.description,
      includeData: params.includeData === true,
    }),
  );
  if (publishRes.status < 200 || publishRes.status >= 300) {
    result.message = "publishToUpdateSet returned HTTP " + publishRes.status;
    result.note =
      "publish-app: publishToUpdateSet failed (HTTP " +
      publishRes.status +
      "): " +
      (publishRes.body || "").slice(0, 200) +
      ". Update set " +
      result.updateSetSysId +
      " was created but is EMPTY.";
    return result;
  }
  var publishAnswer = parseXmlAnswer(publishRes.body);
  if (publishAnswer.error || !SYS_ID_RE.test(publishAnswer.answer)) {
    result.message = publishAnswer.error || "answer is not a sys_id";
    result.note =
      "publish-app: publishToUpdateSet did not return a worker sys_id — " +
      (publishAnswer.error ||
        "got '" + publishAnswer.answer.slice(0, 64) + "'") +
      ". Update set " +
      result.updateSetSysId +
      " was created but is EMPTY.";
    return result;
  }
  result.executionSysId = publishAnswer.answer;

  var tree = await pollAjaxProgress({
    result: result,
    auth: auth,
    session: session,
    post: post,
    sleepFn: sleepFn,
    appSysId: app.sysId,
    timeoutMs: timeoutMs,
  });
  if (!tree) return result;

  if (classifyProgress(tree).success) {
    result.status = "published";
    result.note =
      "Published " +
      app.name +
      " v" +
      params.version +
      " into update set '" +
      naming.name +
      "' (" +
      result.updateSetSysId +
      (naming.description ? ", description '" + naming.description + "'" : "") +
      ") (" +
      result.polls +
      " poll(s)).";
  } else {
    result.status = "failed";
    result.note =
      "publish-app: update-set publish terminated in state " +
      tree.state +
      (result.message ? " — " + result.message : "") +
      ". Tracker " +
      result.executionSysId +
      ". Update set " +
      result.updateSetSysId +
      " exists and may be incomplete.";
  }
  return result;
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
      path:
        "/api/sn_cicd/progress/" + encodeURIComponent(result.executionSysId),
    });
    if (progRes.status < 200 || progRes.status >= 300) {
      result.message =
        "HTTP " + progRes.status + " from the CI/CD progress API";
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
  if (target === "repo-ui") {
    // No credentials are involved at all — publish_to_store=false.
    return buildStartFields({
      appSysId: app.sysId,
      version: params.version,
      devNotes: params.devNotes || "",
      target: "repo-ui",
      storeUsername: "",
      storePassword: "",
    });
  }
  if (target === "update-set") {
    var naming = resolveUpdateSetNaming({
      updateSetName: params.updateSetName,
      updateSetDescription: params.updateSetDescription,
      appName: app.name,
    });
    // Two calls, so the preview is flattened with a call-N prefix — the second
    // call's real sysparm_update_set_id is only known at run time.
    var flat: Record<string, string> = {};
    var create = buildCreateUpdateSetFields({
      appSysId: app.sysId,
      updateSetName: naming.name,
      description: naming.description,
    });
    Object.keys(create).forEach(function (k) {
      flat["1." + k] = create[k];
    });
    var publish = buildPublishToUpdateSetFields({
      appSysId: app.sysId,
      updateSetSysId: "(sys_id returned by call 1)",
      version: params.version,
      description: naming.description,
      includeData: params.includeData === true,
    });
    Object.keys(publish).forEach(function (k) {
      flat["2." + k] = publish[k];
    });
    return flat;
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

/** Human phrase for a target — used in dry-run notes and CLI output. */
export function describeTarget(target: PublishTarget): string {
  if (target === "store") return "ServiceNow Store (EXTERNALLY VISIBLE)";
  if (target === "repo") return "application repository (CI/CD REST API)";
  if (target === "repo-ui") return "company application repository (UI replay)";
  return "new update set";
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
  if (
    params.target !== "store" &&
    params.target !== "repo" &&
    params.target !== "repo-ui" &&
    params.target !== "update-set"
  ) {
    throw new Error(
      "publish-app: target must be 'store', 'repo', 'repo-ui', or " +
        "'update-set' (got '" +
        String(params.target) +
        "').",
    );
  }
  // A NaN/non-positive timeout would make the poll-loop budget check always
  // false — an infinite loop. Refuse it here so every caller is covered.
  if (
    params.timeoutMs != null &&
    (typeof params.timeoutMs !== "number" ||
      !isFinite(params.timeoutMs) ||
      params.timeoutMs <= 0)
  ) {
    throw new Error(
      "publish-app: timeoutMs must be a positive number (got '" +
        String(params.timeoutMs) +
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
      describeTarget(params.target) +
      ". Re-run with confirm to publish.";
    return dry;
  }

  if (params.target === "store" || params.target === "repo-ui") {
    return publishViaUploader(params, app, params.target);
  }
  if (params.target === "update-set") {
    return publishToUpdateSet(params, app);
  }
  return publishToRepo(params, app, client);
}
