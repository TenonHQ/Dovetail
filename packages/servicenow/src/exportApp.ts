/**
 * Export a scoped application to an importable `<unload>` XML document — the
 * headless equivalent of the classic UI's **Publish to Update Set → Export to
 * XML**, with secret values stripped before the document is returned.
 *
 * Ground truth: `brainstorms/sn-export-app-flow.md` (HAR capture, tenonworkshop
 * 2026-06-08) and the live run recorded there. "Export an app" is two operations
 * chained, with no single button behind it:
 *
 *   1. `POST /xmlhttp.do` com.snc.apps.AppsAjaxProcessor `createUpdateSet` →
 *      the new set's sys_id arrives in the answer attribute.
 *   2. `POST /xmlhttp.do` AppsAjaxProcessor `publishToUpdateSet` → a worker id;
 *      poll AJAXProgressStatusChecker/getStatus until "Successfully published"
 *      (the HAR took 48 polls / ~44s for 1,088 files).
 *   3. export that update set — delegated to exportUpdateSet, which owns the
 *      in-progress empty-200 gotcha and the secret stripping.
 *
 * PUBLISHING IS A REAL SHARED-INSTANCE WRITE: it creates an update set and
 * ~1000+ sys_update_xml rows. DRY-RUN BY DEFAULT — without confirm:true this
 * resolves the app and returns the plan, having written nothing.
 *
 * This is NOT the Store publish. That is publishApp, which is externally
 * visible; this one stays inside the instance.
 *
 * ES6 only, no optional chaining.
 */

import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import { resolveFormAuth, openFormSession, postForm, decodeHtmlEntities } from "./table";
import type { FormAuth, FormSession, PostResult } from "./table";
import {
  parseXmlAnswer,
  parseProgressTree,
  classifyProgress,
  PUBLISH_POLL_DELAYS_MS,
} from "./publishApp";
import { exportUpdateSet } from "./exportUpdateSet";
import type { ExportUpdateSetResult, ExportTransport } from "./exportUpdateSet";
import type { SecretField } from "./secrets/stripSecrets";

/** Injectable transport so tests never touch the network. */
export interface ExportAppTransport extends ExportTransport {
  post?: (
    auth: FormAuth,
    session: FormSession,
    path: string,
    fields: Record<string, string>,
  ) => Promise<PostResult>;
  sleep?: (ms: number) => Promise<void>;
}

/** Inputs for exportApp. */
export interface ExportAppParams {
  /** App sys_id, scope, or name. */
  app: string;
  /** Publish version. Defaults to the app's current version. */
  version?: string;
  /** Description recorded on the update set. */
  description?: string;
  /** Include table DATA as well as schema. Off by default. */
  includeData?: boolean;
  /** Leave the published update set behind. Default true — deleting is not ours to do. */
  keepSet?: boolean;
  client?: ServiceNowClient;
  instance?: string;
  user?: string;
  password?: string;
  /** Required: publishing writes to the instance. */
  confirm?: boolean;
  /** Force a plan-only run. Wins over confirm. */
  dryRun?: boolean;
  /** Optional JSON secret-rules file. */
  rulesPath?: string;
  /** Milliseconds to wait for the publish worker. Default 300000. */
  timeoutMs?: number;
  transport?: ExportAppTransport;
}

/** Outcome of an app export. */
export interface ExportAppResult {
  status: "dry-run" | "exported" | "failed" | "timeout";
  appName: string;
  appScope: string;
  appSysId: string;
  version: string;
  /** The update set the publish produced. */
  updateSetSysId: string;
  /** getStatus polls performed. */
  polls: number;
  recordCount: number;
  xml?: string;
  secretFields: Array<SecretField>;
  message?: string;
  note: string;
}

/** Publishing a large app is slow — the HAR run took ~44s for 1,088 files. */
export var DEFAULT_EXPORT_APP_TIMEOUT_MS = 300000;

var SYS_ID_RE = /^[0-9a-f]{32}$/;

interface ResolvedApp {
  sysId: string;
  scope: string;
  name: string;
  version: string;
}

async function resolveApp(client: ServiceNowClient, selector: string): Promise<ResolvedApp> {
  var fields = ["sys_id", "scope", "name", "version"];
  var queries: Array<string> = [];
  if (SYS_ID_RE.test(selector)) {
    queries.push("sys_id=" + selector);
  } else {
    queries.push("scope=" + selector);
    queries.push("name=" + selector);
  }
  for (var i = 0; i < queries.length; i += 1) {
    var rows = await client.table.query<Record<string, string>>("sys_app", queries[i], {
      limit: 2,
      fields: fields,
    });
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
        "export-app: '" + selector + "' matches more than one application — pass the sys_id.",
      );
    }
  }
  throw new Error(
    "export-app: no application matches '" + selector + "' — pass its sys_id, scope, or name.",
  );
}

function realSleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Fields for the AppsAjaxProcessor createUpdateSet call. The UI sends a single
 * space when the description box is empty — mirrored here so the processor sees
 * what it sees from a browser.
 */
export function buildCreateSetFields(app: ResolvedApp, description: string): Record<string, string> {
  return {
    sysparm_processor: "com.snc.apps.AppsAjaxProcessor",
    sysparm_function: "createUpdateSet",
    sysparm_name: app.name,
    sysparm_appid: app.sysId,
    sysparm_description: description === "" ? " " : description,
    sysparm_current: "false",
  };
}

/** Fields for the AppsAjaxProcessor publishToUpdateSet call. */
export function buildPublishFields(
  app: ResolvedApp,
  updateSetSysId: string,
  version: string,
  description: string,
  includeData: boolean,
): Record<string, string> {
  return {
    sysparm_processor: "com.snc.apps.AppsAjaxProcessor",
    sysparm_function: "publishToUpdateSet",
    sysparm_update_set_id: updateSetSysId,
    sysparm_sys_id: app.sysId,
    sysparm_name: "start",
    sysparm_version: version,
    sysparm_description: description === "" ? " " : description,
    sysparm_include_data: includeData ? "true" : "",
    sysparm_progress_name: "Publishing application",
  };
}

function baseResult(app: ResolvedApp, version: string): ExportAppResult {
  return {
    status: "failed",
    appName: app.name,
    appScope: app.scope,
    appSysId: app.sysId,
    version: version,
    updateSetSysId: "",
    polls: 0,
    recordCount: 0,
    secretFields: [],
    note: "",
  };
}

/**
 * Publish an application into a fresh update set and export that set.
 *
 * Remote failures are RETURNED as a failed/timeout result; only caller errors
 * (bad selector, bad timeout) throw.
 */
export async function exportApp(params: ExportAppParams): Promise<ExportAppResult> {
  if (!params || typeof params.app !== "string" || params.app.trim() === "") {
    throw new Error("export-app: app is required (a sys_id, scope, or name).");
  }
  var timeoutMs =
    params.timeoutMs === undefined ? DEFAULT_EXPORT_APP_TIMEOUT_MS : params.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("export-app: timeoutMs must be a positive integer of milliseconds.");
  }

  var client = params.client || createClient({});
  var app = await resolveApp(client, params.app.trim());
  var version = params.version && params.version !== "" ? params.version : app.version;
  var description = params.description === undefined ? "" : params.description;
  var result = baseResult(app, version);

  var live = params.confirm === true && params.dryRun !== true;
  if (!live) {
    result.status = "dry-run";
    result.note =
      "dry-run: nothing was published. Would publish " +
      app.name +
      " (" +
      app.scope +
      ", current version " +
      app.version +
      ") as v" +
      version +
      " into a NEW update set — a real instance write of ~1000+ records — then export it with " +
      "secret values replaced by the sentinel. Re-run with confirm to proceed.";
    return result;
  }

  var transport = params.transport || {};
  var post = transport.post || postForm;
  var openSession = transport.openSession || openFormSession;
  var sleepFn = transport.sleep || realSleep;

  var auth = resolveFormAuth({
    instance: params.instance,
    user: params.user,
    password: params.password,
  });
  var session = await openSession(auth);

  var created = await post(auth, session, "/xmlhttp.do", buildCreateSetFields(app, description));
  var createdAnswer = parseXmlAnswer(created.body);
  if (createdAnswer.error !== "" || !SYS_ID_RE.test(createdAnswer.answer)) {
    result.status = "failed";
    result.message = "createUpdateSet did not return an update set";
    result.note =
      "export-app: the createUpdateSet call did not return an update set sys_id (" +
      (createdAnswer.error || "answer was '" + createdAnswer.answer + "'") +
      "). Nothing was exported.";
    return result;
  }
  result.updateSetSysId = createdAnswer.answer;

  var started = await post(
    auth,
    session,
    "/xmlhttp.do",
    buildPublishFields(
      app,
      result.updateSetSysId,
      version,
      description,
      params.includeData === true,
    ),
  );
  var startedAnswer = parseXmlAnswer(started.body);
  if (startedAnswer.error !== "" || startedAnswer.answer === "") {
    result.status = "failed";
    result.message = "publishToUpdateSet did not start";
    result.note =
      "export-app: the publish did not start (" +
      (startedAnswer.error || "empty worker id") +
      "). Update set " +
      result.updateSetSysId +
      " was created and is empty.";
    return result;
  }

  var workerId = startedAnswer.answer;
  var startedAt = Date.now();
  var pollIndex = 0;
  while (true) {
    var delay =
      PUBLISH_POLL_DELAYS_MS[Math.min(pollIndex, PUBLISH_POLL_DELAYS_MS.length - 1)];
    if (Date.now() - startedAt + delay > timeoutMs) {
      result.status = "timeout";
      result.message = "publish did not finish in time";
      result.note =
        "export-app: the publish worker was still running after " +
        timeoutMs +
        "ms. Update set " +
        result.updateSetSysId +
        " may still be filling — check it on the instance, then export it with export-update-set.";
      return result;
    }
    await sleepFn(delay);
    pollIndex += 1;
    result.polls += 1;

    var status = await post(auth, session, "/xmlhttp.do", {
      sysparm_processor: "AJAXProgressStatusChecker",
      sysparm_name: "getStatus",
      sysparm_scope: "global",
      sysparm_want_session_messages: "true",
      sysparm_execution_id: workerId,
      "ni.nolog.x_referer": "ignore",
      x_referer: "sys_app.do?sys_id=" + app.sysId,
    });
    var answer = parseXmlAnswer(status.body);
    if (answer.error !== "") {
      result.status = "failed";
      result.message = answer.error;
      result.note = "export-app: reading publish progress failed (" + answer.error + ").";
      return result;
    }
    var tree;
    try {
      tree = parseProgressTree(decodeHtmlEntities(answer.answer));
    } catch (e) {
      result.status = "failed";
      result.message = e instanceof Error ? e.message : String(e);
      result.note = "export-app: publish progress could not be read (" + result.message + ").";
      return result;
    }
    var verdict = classifyProgress(tree);
    if (verdict.terminal && !verdict.success) {
      result.status = "failed";
      result.message = tree.message || "publish failed";
      result.note =
        "export-app: the publish failed on the instance (" +
        result.message +
        "). Update set " +
        result.updateSetSysId +
        " may be partially filled.";
      return result;
    }
    if (verdict.terminal) {
      break;
    }
  }

  var exported: ExportUpdateSetResult = await exportUpdateSet({
    updateSet: result.updateSetSysId,
    mode: "complete",
    confirm: true,
    client: client,
    instance: params.instance,
    user: params.user,
    password: params.password,
    rulesPath: params.rulesPath,
    transport: {
      // Reuse the session already opened for the publish.
      openSession: async function () {
        return session;
      },
      get: transport.get,
    },
  });

  result.recordCount = exported.recordCount;
  result.secretFields = exported.secretFields;
  if (exported.status !== "exported") {
    result.status = "failed";
    result.message = exported.message || "export failed";
    result.note =
      "export-app: published to update set " +
      result.updateSetSysId +
      " but the export failed — " +
      exported.note;
    return result;
  }

  result.status = "exported";
  result.xml = exported.xml;
  result.note =
    "published " +
    app.name +
    " v" +
    version +
    " into update set " +
    result.updateSetSysId +
    " (" +
    (params.keepSet === false ? "delete it on the instance when done" : "kept") +
    ") and exported " +
    result.recordCount +
    " record(s); " +
    result.secretFields.length +
    " secret value(s) replaced with the sentinel.";
  return result;
}
