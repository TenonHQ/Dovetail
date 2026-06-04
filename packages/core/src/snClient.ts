import { Sinc, SN } from "@tenonhq/dovetail-types";
import axios, { AxiosPromise, AxiosResponse, AxiosError } from "axios";
import { wrapper } from "axios-cookiejar-support";
import rateLimit from "axios-rate-limit";
import { CookieJar } from "tough-cookie";
import { wait } from "./genericUtils";
import { logger } from "./Logger";
import { fileLogger } from "./FileLogger";
import { BenchmarkCollector } from "./benchmark";

// Benchmark sink. Null when --benchmark is off; zero overhead in that case.
let _benchmarkSink: BenchmarkCollector | null = null;
export function setBenchmarkSink(sink: BenchmarkCollector | null): void {
  _benchmarkSink = sink;
}

// Local helper to strip _ directive keys before sending to ServiceNow API.
// Defined here (not imported from config.ts) to avoid circular dependencies.
function _stripUnderscoreKeys(obj: any): any {
  var result: any = {};
  var keys = Object.keys(obj || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].charAt(0) !== "_") {
      result[keys[i]] = obj[keys[i]];
    }
  }
  return result;
}

export const retryOnErr = async <T>(
  f: () => Promise<T>,
  allowedRetries: number,
  msBetween = 0,
  onRetry?: (retriesLeft: number) => void,
): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    const newRetries = allowedRetries - 1;
    if (newRetries <= 0) {
      throw e;
    }
    if (onRetry) {
      onRetry(newRetries);
    }
    await wait(msBetween);
    return retryOnErr(f, newRetries, msBetween, onRetry);
  }
};

function _getHttpStatus(e: unknown): number | undefined {
  if (axios.isAxiosError(e) && e.response) {
    return e.response.status;
  }
  return undefined;
}

// Dovetail's core Scripted REST API now lives in the Dovetail scoped
// application at /api/cadso/dovetail_core/*. Older instances still expose the
// previous global-scope path /api/cadso/dovetail/*. We try dovetail_core first;
// if it 404s we fall back to the legacy /api/cadso/dovetail/* path for the rest
// of the session, with a one-time deprecation warning.
let _dovetailApiUseLegacyPath = false;
function _dovetailEndpoint(op: string): string {
  return _dovetailApiUseLegacyPath
    ? "api/cadso/dovetail/" + op
    : "api/cadso/dovetail_core/" + op;
}
// Exported for tests only: reset the latched fallback state between test cases.
export function _resetDovetailApiFallback(): void {
  _dovetailApiUseLegacyPath = false;
}
// Exported for tests only: inspect the latched fallback state.
export function _isUsingLegacyPath(): boolean {
  return _dovetailApiUseLegacyPath;
}
// SN returns 400 with this body when a Scripted REST endpoint does not exist
// at the requested URI. The dovetail_core -> dovetail fallback above only fires
// on 404, so the same "endpoint missing" condition presents as an opaque 400 to
// callers. Detect it and surface a clear hint.
var _SN_MISSING_ENDPOINT_BODY = "Requested URI does not represent any resource";

function _summarizeResponseBody(data: unknown): string {
  if (data === undefined || data === null) return "";
  try {
    var asJson = typeof data === "string" ? data : JSON.stringify(data);
    return asJson.length > 500 ? asJson.slice(0, 500) + "…" : asJson;
  } catch (_) {
    return String(data);
  }
}

// Augment an axios error in place with a human-readable message describing
// the attempted Dovetail REST call. Preserves .response/.code/.config so
// existing callers and tests that inspect those fields keep working.
function _enrichDovetailApiError(
  e: unknown,
  attemptedEndpoint: string,
): unknown {
  if (!axios.isAxiosError(e)) return e;
  var status = e.response ? e.response.status : undefined;
  var body = e.response ? _summarizeResponseBody(e.response.data) : "";
  var missingEndpoint =
    status === 400 && body.indexOf(_SN_MISSING_ENDPOINT_BODY) !== -1;
  var hint = missingEndpoint
    ? " — Scripted REST endpoint not found on this instance. Install the Dovetail application's Scripted REST APIs (dovetail_core / dovetail_sync / dovetail_promote)."
    : "";
  e.message =
    "Dovetail REST call failed: " +
    (status ? "HTTP " + status : "no response") +
    " " + attemptedEndpoint +
    (body ? " — " + body : "") +
    hint;
  return e;
}

// True when an error indicates the Dovetail Scripted REST endpoint does not
// exist on this instance (404, or the 400 "Requested URI does not represent any
// resource" body). Used to degrade createUpdateSet to the Table API path on
// instances that do not have the createUpdateSet op deployed yet.
function _isMissingDovetailEndpoint(e: unknown): boolean {
  if (!axios.isAxiosError(e)) return false;
  var status = e.response ? e.response.status : undefined;
  if (status === 404) return true;
  if (status === 400) {
    var body = e.response ? _summarizeResponseBody(e.response.data) : "";
    return body.indexOf(_SN_MISSING_ENDPOINT_BODY) !== -1;
  }
  return false;
}

export async function _callDovetailApi<T>(
  op: string,
  call: (endpoint: string) => Promise<AxiosResponse<T>>,
): Promise<AxiosResponse<T>> {
  var endpoint = _dovetailEndpoint(op);
  try {
    return await call(endpoint);
  } catch (e) {
    if (!_dovetailApiUseLegacyPath && _getHttpStatus(e) === 404) {
      logger.warn(
        "[deprecation] /api/cadso/dovetail_core/" + op +
          " returned 404. Falling back to legacy /api/cadso/dovetail/" + op +
          ". Install the Dovetail application's Scripted REST APIs to silence this warning.",
      );
      _dovetailApiUseLegacyPath = true;
      var legacyEndpoint = _dovetailEndpoint(op);
      try {
        return await call(legacyEndpoint);
      } catch (e2) {
        throw _enrichDovetailApiError(e2, legacyEndpoint);
      }
    }
    throw _enrichDovetailApiError(e, endpoint);
  }
}

function _getRetryAfterMs(e: unknown): number {
  if (axios.isAxiosError(e) && e.response && e.response.headers) {
    var retryAfter = e.response.headers["retry-after"];
    if (retryAfter) {
      var seconds = Number(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
  }
  return 10000; // Default 10s for 429 without Retry-After
}

export const retryOnHttpErr = async <T>(
  f: () => Promise<T>,
  recSummary: string,
): Promise<T> => {
  var maxServerRetries = 3;
  var backoffMs = 1000;
  var attempt = 0;

  while (true) {
    try {
      return await f();
    } catch (e) {
      var status = _getHttpStatus(e);
      attempt++;

      // 401/403: Auth failure — fail immediately
      if (status === 401 || status === 403) {
        var authMsg = status === 401 ? "Unauthorized" : "Forbidden";
        logger.error(
          authMsg + " (" + status + ") pushing " + recSummary +
          ". Verify your ServiceNow credentials and permissions."
        );
        throw e;
      }

      // 404: Record not found — fail immediately
      if (status === 404) {
        logger.error(
          "Record not found (404) pushing " + recSummary +
          ". The record may have been deleted from the instance."
        );
        throw e;
      }

      // 429: Rate limited — honor Retry-After, then retry
      if (status === 429) {
        var retryWait = _getRetryAfterMs(e);
        logger.warn(
          "Rate limited (429) pushing " + recSummary +
          ". Waiting " + Math.round(retryWait / 1000) + "s before retry."
        );
        await wait(retryWait);
        continue;
      }

      // 500/502/503: Server error — exponential backoff, max 3 retries
      if (status === 500 || status === 502 || status === 503) {
        if (attempt > maxServerRetries) {
          logger.error(
            "Server error (" + status + ") pushing " + recSummary +
            " after " + maxServerRetries + " retries. Giving up."
          );
          throw e;
        }
        var cappedBackoff = Math.min(backoffMs, 8000);
        logger.warn(
          "Server error (" + status + ") pushing " + recSummary +
          ". Retrying in " + (cappedBackoff / 1000) + "s (" +
          (maxServerRetries - attempt) + " retries left)."
        );
        await wait(cappedBackoff);
        backoffMs = backoffMs * 2;
        continue;
      }

      // Unknown status or non-HTTP error — retry once, then fail
      if (attempt > 1) {
        var errDetail = status ? "HTTP " + status : "unknown error";
        logger.error(
          "Push failed for " + recSummary + " (" + errDetail +
          ") after 1 retry. Giving up."
        );
        throw e;
      }
      var retryDetail = status ? "HTTP " + status : "unknown error";
      logger.warn(
        "Unexpected error (" + retryDetail + ") pushing " + recSummary +
        ". Retrying once."
      );
      await wait(1000);
    }
  }
};

export const processPushResponse = (
  response: AxiosResponse,
  recSummary: string,
): Sinc.PushResult => {
  const { status } = response;
  if (status === 404) {
    return {
      success: false,
      message: `Could not find ${recSummary} on the server.`,
    };
  }
  if (status < 200 || status > 299) {
    return {
      success: false,
      message: `Failed to push ${recSummary}. Recieved an unexpected response (${status})`,
    };
  }
  return {
    success: true,
    message: `${recSummary} pushed successfully!`,
  };
};

export const snClient = (
  baseURL: string,
  username: string,
  password: string,
) => {
  const jar = new CookieJar();
  const rawAxios = wrapper(
    axios.create({
      withCredentials: true,
      auth: {
        username,
        password,
      },
      headers: {
        "Content-Type": "application/json",
      },
      baseURL,
      jar,
    } as any),
  );

  // Request interceptor: stamp startedAt so the response interceptor can
  // compute durationMs. Only when a benchmark sink is attached — when it
  // isn't, this is a single property assignment and does not change shape.
  rawAxios.interceptors.request.use(function (cfg: any) {
    if (_benchmarkSink) {
      cfg._benchStartedAt = Date.now();
    }
    return cfg;
  });

  rawAxios.interceptors.response.use(
    function (response: any) {
      if (!_benchmarkSink) return response;
      var startedAt = response.config && response.config._benchStartedAt;
      if (!startedAt) return response;
      var url = (response.config && response.config.url) || "";
      var payload: any = response.data;
      var responseBytes = 0;
      try {
        responseBytes = payload ? JSON.stringify(payload).length : 0;
      } catch (e) {
        responseBytes = 0;
      }
      var tableCount = 0;
      var result: any = payload && payload.result;
      if (result && typeof result === "object") {
        if (url.indexOf("bulkDownload") !== -1) {
          tableCount = Object.keys(result).length;
        } else if (url.indexOf("getManifest") !== -1 && result.tables) {
          tableCount = Object.keys(result.tables).length;
        }
      }
      _benchmarkSink.recordHttp({
        path: url,
        tableCount: tableCount,
        durationMs: Date.now() - startedAt,
        statusCode: response.status,
        responseBytes: responseBytes,
      });
      return response;
    },
    function (error: any) {
      // Preserve original rejection; don't record errored requests (they skew
      // latency tails without adding signal for the "scales the same" question).
      return Promise.reject(error);
    },
  );

  const client = rateLimit(rawAxios, { maxRPS: 20 });

  const getAppList = () => {
    const endpoint = "api/cadso/dovetail_sync/getAppList";
    type AppListResponse = Sinc.SNAPIResponse<SN.App[]>;
    return client.get<AppListResponse>(endpoint);
  };

  const updateATFfile = (contents: string, sysId: string) => {
    const endpoint = "api/cadso/dovetail_sync/pushATFfile";
    try {
      return client.post(endpoint, { file: contents, sys_id: sysId });
    } catch (e) {
      throw e;
    }
  };

  const updateRecord = (
    table: string,
    recordId: string,
    fields: Record<string, string>,
  ) => {
    if (table === "sys_atf_step") {
      updateATFfile(fields["inputs.script"], recordId);
    }
    const endpoint = `api/now/table/${table}/${recordId}`;
    return client.patch(endpoint, fields);
  };

  const getScopeId = (scopeName: string) => {
    const endpoint = "api/now/table/sys_scope";
    type ScopeResponse = Sinc.SNAPIResponse<SN.ScopeRecord[]>;
    return client.get<ScopeResponse>(endpoint, {
      params: {
        sysparm_query: `scope=${scopeName}`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const getUserSysId = (userName: string = process.env.SN_USER as string) => {
    const endpoint = "api/now/table/sys_user";
    type UserResponse = Sinc.SNAPIResponse<SN.UserRecord[]>;
    return client.get<UserResponse>(endpoint, {
      params: {
        sysparm_query: `user_name=${userName}`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const getCurrentAppUserPrefSysId = (userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    type UserPrefResponse = Sinc.SNAPIResponse<SN.UserPrefRecord[]>;
    return client.get<UserPrefResponse>(endpoint, {
      params: {
        sysparm_query: `user=${userSysId}^name=apps.current_app`,
        sysparm_fields: "sys_id",
      },
    });
  };

  const updateCurrentAppUserPref = (
    appSysId: string,
    userPrefSysId: string,
  ) => {
    const endpoint = `api/now/table/sys_user_preference/${userPrefSysId}`;
    return client.put(endpoint, { value: appSysId });
  };

  const createCurrentAppUserPref = (appSysId: string, userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    return client.post(endpoint, {
      value: appSysId,
      name: "apps.current_app",
      type: "string",
      user: userSysId,
    });
  };

  const getCurrentScope = () => {
    const endpoint = "api/cadso/dovetail_sync/getCurrentScope";
    type ScopeResponse = Sinc.SNAPIResponse<SN.ScopeObj>;
    return client.get<ScopeResponse>(endpoint);
  };

  const createUpdateSet = async (
    updateSetName: string,
    scopeSysId?: string,
    description?: string,
  ): Promise<AxiosResponse<Sinc.SNAPIResponse<SN.UpdateSetRecord>>> => {
    type UpdateSetCreateResponse = Sinc.SNAPIResponse<SN.UpdateSetRecord>;
    // Prefer the scope-safe Dovetail server op. It switches the current
    // application and inserts the set in one server call, so the set always
    // lands in `scopeSysId`. A raw Table API POST ignores `application` (the
    // field defaults to the session's current app), and the old
    // changeScope-then-POST path raced and mis-scoped sets created back to back.
    const data: any = {
      name: updateSetName,
      state: "in progress",
    };
    if (scopeSysId) {
      data.application = scopeSysId;
    }
    if (description) {
      data.description = description;
    }
    try {
      const resp = await _callDovetailApi<any>("createUpdateSet", (endpoint) =>
        client.post<any>(endpoint, data),
      );
      const payload: any = resp.data || {};
      const sysId = payload.sys_id || (payload.result && payload.result.sys_id);
      if (!sysId) {
        throw new Error("createUpdateSet endpoint returned no sys_id");
      }
      // Normalize to the Table-API shape that unwrapSNResponse expects
      // (resp.data.result), so callers stay unchanged.
      return {
        ...resp,
        data: {
          result: {
            sys_id: sysId,
            name: payload.name || updateSetName,
            application: payload.application,
          },
        },
      } as AxiosResponse<UpdateSetCreateResponse>;
    } catch (e) {
      if (!_isMissingDovetailEndpoint(e)) {
        throw e;
      }
      // Instance without the createUpdateSet op yet: degrade to the legacy
      // Table API path so existing flows keep working during rollout. Sets
      // created this way may be mis-scoped until the op is deployed.
      logger.warn(
        "Dovetail createUpdateSet endpoint not found on this instance; falling " +
          "back to the Table API. Update sets may be mis-scoped until the " +
          "Dovetail createUpdateSet REST op is installed on this instance.",
      );
      const endpoint = `api/now/table/sys_update_set`;
      return client.post<UpdateSetCreateResponse>(endpoint, data);
    }
  };

  const getCurrentUpdateSetUserPref = (userSysId: string) => {
    const endpoint = `api/now/table/sys_user_preference`;
    type CurrentUpdateSetResponse = Sinc.SNAPIResponse<SN.UserPrefRecord[]>;
    return client.get<CurrentUpdateSetResponse>(endpoint, {
      params: {
        sysparm_query: `user=${userSysId}^name=sys_update_set`,
        sysparm_fields: "sys_id",
      },
    });
  };
  const updateCurrentUpdateSetUserPref = (
    updateSetSysId: string,
    userPrefSysId: string,
  ) => {
    const endpoint = `api/now/table/sys_user_preference/${userPrefSysId}`;
    return client.put(endpoint, { value: updateSetSysId });
  };

  const createCurrentUpdateSetUserPref = (
    updateSetSysId: string,
    userSysId: string,
  ) => {
    const endpoint = `api/now/table/sys_user_preference`;
    return client.put(endpoint, {
      value: updateSetSysId,
      name: "sys_update_set",
      type: "string",
      user: userSysId,
    });
  };

  const getMissingFiles = (
    missingFiles: SN.MissingFileTableMap,
    tableOptions: Sinc.ITableOptionsMap,
  ) => {
    const endpoint = `api/cadso/dovetail_sync/bulkDownload`;

    const tableCount = Object.keys(missingFiles).length;
    fileLogger.debug("Bulk downloading files for " + tableCount + " tables");

    type TableMap = Sinc.SNAPIResponse<SN.TableMap>;
    return client.post<TableMap>(endpoint, { missingFiles, tableOptions });
  };

  const getManifest = (
    scope: string,
    config: Sinc.ScopedConfig,
    withFiles = false,
  ) => {
    const endpoint = `api/cadso/dovetail_sync/getManifest/${scope}`;
    const {
      includes = {},
      excludes = {},
      tableOptions = {},
      scopes = {},
    } = config;

    // Strip _ directive keys before sending to ServiceNow API
    var cleanIncludes = _stripUnderscoreKeys(includes);
    var cleanExcludes = _stripUnderscoreKeys(excludes);

    fileLogger.debug("Fetching manifest for scope " + scope + (withFiles ? " (with file contents)" : " (structure only)"));

    type AppResponse = Sinc.SNAPIResponse<SN.AppManifest>;
    return client.post<AppResponse>(endpoint, {
      includes: cleanIncludes,
      excludes: cleanExcludes,
      tableOptions,
      withFiles,
      getContents: withFiles, // ServiceNow expects getContents, not withFiles
    });
  };

  const changeUpdateSet = (params: {
    sysId?: string;
    name?: string;
    scope?: string;
  }) => {
    type ChangeUpdateSetResponse = { message?: string; error?: string };
    return _callDovetailApi<ChangeUpdateSetResponse>("changeUpdateSet", (endpoint) =>
      client.get<ChangeUpdateSetResponse>(endpoint, { params }),
    );
  };

  const getCurrentUpdateSet = (scope?: string) => {
    type CurrentUpdateSetResponse = {
      message?: string;
      sysId?: string;
      name?: string;
      error?: string;
    };
    const params: any = {};
    if (scope) {
      params.scope = scope;
    }
    return _callDovetailApi<CurrentUpdateSetResponse>("currentUpdateSet", (endpoint) =>
      client.get<CurrentUpdateSetResponse>(endpoint, { params }),
    );
  };

  const changeScope = (scope: string) => {
    type ChangeScopeResponse = {
      message?: string;
      sysId?: string;
      name?: string;
      error?: string;
    };
    return _callDovetailApi<ChangeScopeResponse>("changeScope", (endpoint) =>
      client.get<ChangeScopeResponse>(endpoint, { params: { scope } }),
    );
  };

  const pushWithUpdateSet = (
    updateSetSysId: string,
    table: string,
    recordSysId: string,
    fields: Record<string, string>,
  ) => {
    return _callDovetailApi<unknown>("pushWithUpdateSet", (endpoint) =>
      client.post(endpoint, {
        update_set_sys_id: updateSetSysId,
        table,
        record_sys_id: recordSysId,
        fields,
      }),
    );
  };

  const createRecord = (params: {
    table: string;
    fields: Record<string, string>;
    sys_id?: string;
    scope?: string;
    update_set_sys_id?: string;
  }) => {
    type CreateRecordResponse = {
      result: {
        sys_id: string;
        table: string;
        name: string;
        error?: string;
      };
    };
    return _callDovetailApi<CreateRecordResponse>("createRecord", (endpoint) =>
      client.post<CreateRecordResponse>(endpoint, params),
    );
  };

  const deleteRecord = (params: {
    table: string;
    sys_id: string;
    scope?: string;
  }) => {
    type DeleteRecordResponse = {
      result: {
        success: boolean;
        sys_id: string;
        table: string;
        name: string;
        error?: string;
      };
    };
    return _callDovetailApi<DeleteRecordResponse>("deleteRecord", (endpoint) =>
      client.post<DeleteRecordResponse>(endpoint, params),
    );
  };

  return {
    getAppList,
    updateRecord,
    getScopeId,
    getUserSysId,
    getCurrentAppUserPrefSysId,
    updateCurrentAppUserPref,
    createCurrentAppUserPref,
    getCurrentScope,
    createUpdateSet,
    getCurrentUpdateSetUserPref,
    updateCurrentUpdateSetUserPref,
    createCurrentUpdateSetUserPref,
    getMissingFiles,
    getManifest,
    changeUpdateSet,
    getCurrentUpdateSet,
    changeScope,
    pushWithUpdateSet,
    createRecord,
    deleteRecord,
    client, // Expose the axios client for custom queries
  };
};

let internalClient: SNClient | undefined = undefined;
export const defaultClient = () => {
  if (internalClient) {
    return internalClient;
  }
  const { SN_USER = "", SN_PASSWORD = "", SN_INSTANCE = "" } = process.env;
  internalClient = snClient(`https://${SN_INSTANCE}/`, SN_USER, SN_PASSWORD);
  return internalClient;
};

export type SNClient = ReturnType<typeof snClient>;

export const unwrapSNResponse = async <T>(
  clientPromise: AxiosPromise<Sinc.SNAPIResponse<T>>,
): Promise<T> => {
  try {
    const resp = await clientPromise;

    // Log response summary for key endpoints
    if (resp.config && resp.config.url) {
      const url = resp.config.url;
      const result: any = resp.data.result;

      if (url.includes("getManifest") && result && result.tables) {
        const tableCount = Object.keys(result.tables).length;
        fileLogger.debug("Manifest received: " + tableCount + " tables (status " + resp.status + ")");
      } else if (url.includes("bulkDownload") && result) {
        const tableCount = Object.keys(result).length;
        fileLogger.debug("Bulk download received: " + tableCount + " tables (status " + resp.status + ")");
      }
    }

    return resp.data.result;
  } catch (e) {
    const instance = process.env.SN_INSTANCE || "unknown";

    if (axios.isAxiosError(e) && e.response) {
      const status = e.response.status;
      const statusText = e.response.statusText || "";
      const method = ((e.config && e.config.method) || "").toUpperCase();
      const url = (e.config && e.config.url) || "";
      const data: any = e.response.data;

      // Extract ServiceNow-shaped error message if present (`{error: {message, detail}, status}`)
      let snMessage = "";
      if (data && typeof data === "object") {
        if (data.error && typeof data.error === "object" && data.error.message) {
          snMessage = " — " + String(data.error.message);
        } else if (typeof data.message === "string") {
          snMessage = " — " + data.message;
        }
      }

      // Pull scope out of /getManifest/:scope URLs for easy grepping
      let scope: string | undefined;
      const manifestMatch = url.match(/\/getManifest\/([^/?]+)/);
      if (manifestMatch) scope = manifestMatch[1];

      logger.error(
        "Error from " + instance + ": HTTP " + status + " " +
        method + " " + url + snMessage
      );

      fileLogger.debug("REST error detail", {
        instance: instance,
        scope: scope,
        method: method,
        url: url,
        status: status,
        statusText: statusText,
        responseData: data,
        responseHeaders: e.response.headers,
      });
    } else {
      // Non-Axios error: preserve today's behaviour, add debug detail
      let message;
      if (e instanceof Error) message = e.message;
      else message = String(e);
      logger.error("Error from " + instance + ": " + message);
      fileLogger.debug("Non-Axios error detail", {
        instance: instance,
        errorName: e instanceof Error ? e.name : undefined,
        errorStack: e instanceof Error ? e.stack : undefined,
        message: message,
      });
    }

    throw e;
  }
};

export async function unwrapTableAPIFirstItem<T>(
  clientPromise: AxiosPromise<Sinc.SNAPIResponse<T[]>>,
): Promise<T>;
export async function unwrapTableAPIFirstItem<T>(
  clientPromise: AxiosPromise<Sinc.SNAPIResponse<T[]>>,
  extractField: keyof T,
): Promise<string>;
export async function unwrapTableAPIFirstItem<T extends Record<string, string>>(
  clientPromise: AxiosPromise<Sinc.SNAPIResponse<T[]>>,
  extractField?: keyof T,
): Promise<T | string> {
  try {
    const resp = await unwrapSNResponse(clientPromise);
    if (resp.length === 0) {
      throw new Error("Response was not a populated array!");
    }
    if (!extractField) {
      return resp[0];
    }
    return resp[0][extractField];
  } catch (e) {
    throw e;
  }
}
