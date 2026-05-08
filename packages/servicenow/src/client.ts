/**
 * ServiceNow REST client for @tenonhq/dovetail-servicenow.
 *
 * Provides two entry points:
 *   - `table.*`       — read-only GETs against the native Table API
 *   - `claude.*`      — writes via the Dovetail Scripted REST API
 *                       (/api/cadso/dovetail/*), which handles update-set + scope
 *                       switching atomically so every write lands in the right
 *                       update set without touching sys_user_preference.
 *                       Falls back to the legacy /api/cadso/claude/* path on
 *                       instances where the API has not yet been re-imported.
 *                       The namespace name `claude` is preserved for API
 *                       compatibility; the underlying server-side API is now
 *                       named "Dovetail".
 *
 * Env fallbacks mirror prior dashboard-fetch helpers so dev setups that already
 * have SN_INSTANCE/SN_USER/SN_PASSWORD work without reconfiguration.
 */

import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import type { ServiceNowClientConfig } from "./types";

/**
 * Env precedence for instance/auth: explicit cfg > SN_* > SN_DEV_* > SN_PROD_*.
 * SN_DEV_* / SN_PROD_* fallbacks match the names documented in Craftsman/CLAUDE.local.md
 * so existing developer setups work without re-exporting variables. SN_DEV_INSTANCE
 * may be a bare instance name (e.g. "TenonWorkStudio") — `.service-now.com` is
 * appended when it isn't already part of the host.
 */
function normalizeHost(raw: string): string {
  var host = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (host && host.indexOf(".") === -1) {
    host = host.toLowerCase() + ".service-now.com";
  }
  return host;
}

function resolveInstance(cfg: ServiceNowClientConfig): string {
  var raw = cfg.instance
    || process.env.SN_INSTANCE
    || process.env.SN_DEV_INSTANCE
    || process.env.SN_PROD_INSTANCE
    || "";
  if (!raw) {
    throw new Error(
      "ServiceNow instance not configured. Set SN_INSTANCE (preferred) or SN_DEV_INSTANCE / SN_PROD_INSTANCE, or pass { instance }."
    );
  }
  return normalizeHost(raw);
}

function resolveAuth(cfg: ServiceNowClientConfig): { user: string; password: string } {
  var user = cfg.user
    || process.env.SN_USER
    || process.env.SN_DEV_USERNAME
    || process.env.SN_PROD_USERNAME
    || "";
  var password = cfg.password
    || process.env.SN_PASSWORD
    || process.env.SN_DEV_PASSWORD
    || process.env.SN_PROD_PASSWORD
    || "";
  if (!user || !password) {
    throw new Error(
      "ServiceNow credentials missing — set SN_USER/SN_PASSWORD (preferred) " +
      "or SN_DEV_USERNAME/SN_DEV_PASSWORD (or SN_PROD_*)."
    );
  }
  return { user: user, password: password };
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

export interface TableQueryOptions {
  limit?: number;
  fields?: string[];
}

export interface ServiceNowClient {
  table: {
    /** GET /api/now/table/<t>?sysparm_query=...&sysparm_limit=N — returns result array. */
    query: {
      <T = Record<string, any>>(table: string, query: string, limit?: number): Promise<Array<T>>;
      <T = Record<string, any>>(table: string, query: string, options: TableQueryOptions): Promise<Array<T>>;
    };
  };
  claude: {
    /** POST /api/cadso/dovetail/createRecord (legacy path: /api/cadso/claude/createRecord). */
    createRecord: (params: {
      table: string;
      fields: Record<string, any>;
      scope?: string;
      update_set_sys_id?: string;
      sys_id?: string;
    }) => Promise<{ sys_id: string; [k: string]: any }>;
    /** POST /api/cadso/dovetail/pushWithUpdateSet (legacy: /api/cadso/claude/pushWithUpdateSet). */
    pushWithUpdateSet: (params: {
      update_set_sys_id: string;
      table: string;
      record_sys_id: string;
      fields: Record<string, any>;
    }) => Promise<{ sys_id: string; [k: string]: any }>;
    /** GET /api/cadso/dovetail/currentUpdateSet?scope=... (legacy: /api/cadso/claude/currentUpdateSet). */
    currentUpdateSet: (scope?: string) => Promise<{ sys_id: string; name: string }>;
  };
}

export function createClient(config: ServiceNowClientConfig = {}): ServiceNowClient {
  var host = resolveInstance(config);
  var creds = resolveAuth(config);
  var intervalMs = config.requestIntervalMs != null
    ? config.requestIntervalMs
    : Number(process.env.SN_REQUEST_INTERVAL_MS) || 20;
  var max429 = config.maxRetries429 != null
    ? config.maxRetries429
    : Number(process.env.SN_MAX_RETRIES_429) || 5;
  var max5xx = config.maxRetries5xx != null
    ? config.maxRetries5xx
    : Number(process.env.SN_MAX_RETRIES_5XX) || 3;

  var http: AxiosInstance = axios.create({
    baseURL: "https://" + host,
    auth: { username: creds.user, password: creds.password },
    headers: { accept: "application/json", "content-type": "application/json" },
    validateStatus: function () { return true; }
  });

  var lastAt = 0;
  // Dovetail Scripted REST API rebrand: prefer /api/cadso/dovetail/* and fall back
  // to the legacy /api/cadso/claude/* path on instances where the rename hasn't
  // been imported yet. Latch the legacy flag after the first 404 to avoid paying
  // the round-trip cost on every subsequent call.
  var useDovetailLegacyClaudePath = false;

  async function request<T = any>(cfg: AxiosRequestConfig, ctx: string): Promise<T> {
    var attempt429 = 0;
    var attempt5xx = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      var elapsed = Date.now() - lastAt;
      if (elapsed < intervalMs) {
        await sleep(intervalMs - elapsed);
      }
      lastAt = Date.now();

      var res;
      try {
        res = await http.request(cfg);
      } catch (netErr: any) {
        if (attempt5xx >= max5xx) {
          throw new Error("SN network error on " + ctx + ": " + (netErr && netErr.message));
        }
        attempt5xx += 1;
        await sleep(Math.pow(2, attempt5xx) * 1000);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error("SN auth error " + res.status + " on " + ctx + " — check SN_USER/SN_PASSWORD and ACLs.");
      }
      if (res.status === 404) {
        throw new Error("SN 404 on " + ctx + " — endpoint or record not found.");
      }
      if (res.status === 429) {
        if (attempt429 >= max429) {
          throw new Error("SN 429 rate limit — retries exhausted on " + ctx);
        }
        attempt429 += 1;
        await sleep(Math.min(60000, Math.pow(2, attempt429) * 1000));
        continue;
      }
      if (res.status >= 500) {
        if (attempt5xx >= max5xx) {
          throw new Error("SN " + res.status + " on " + ctx + " — retries exhausted.");
        }
        attempt5xx += 1;
        await sleep(Math.pow(2, attempt5xx) * 1000);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        var body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        throw new Error("SN " + res.status + " on " + ctx + ": " + body.substring(0, 400));
      }
      return res.data as T;
    }
  }

  // Dovetail Scripted REST API request: try /api/cadso/dovetail/<op>, fall back to
  // /api/cadso/claude/<op> on 404 (with a one-time deprecation warning).
  async function dovetailRequest<T = any>(
    method: string,
    op: string,
    body: any | null,
    params: any | null,
    ctx: string,
  ): Promise<T> {
    var url = useDovetailLegacyClaudePath
      ? "/api/cadso/claude/" + op
      : "/api/cadso/dovetail/" + op;
    try {
      return await request<T>({ method: method, url: url, data: body, params: params }, ctx);
    } catch (e: any) {
      var msg = e && e.message ? String(e.message) : "";
      if (!useDovetailLegacyClaudePath && msg.indexOf("SN 404 on") === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          "[deprecation] /api/cadso/dovetail/" + op +
            " returned 404. Falling back to legacy /api/cadso/claude/" + op +
            ". Re-import the Dovetail Scripted REST API XML on your ServiceNow instance to silence this warning.",
        );
        useDovetailLegacyClaudePath = true;
        var legacyUrl = "/api/cadso/claude/" + op;
        return await request<T>({ method: method, url: legacyUrl, data: body, params: params }, ctx);
      }
      throw e;
    }
  }

  return {
    table: {
      query: async function <T = Record<string, any>>(
        table: string,
        query: string,
        limitOrOptions?: number | TableQueryOptions
      ): Promise<Array<T>> {
        var limit: number = 100;
        var fields: string[] | undefined;
        if (typeof limitOrOptions === "number") {
          limit = limitOrOptions;
        } else if (limitOrOptions && typeof limitOrOptions === "object") {
          if (typeof limitOrOptions.limit === "number") {
            limit = limitOrOptions.limit;
          }
          if (limitOrOptions.fields && limitOrOptions.fields.length > 0) {
            fields = limitOrOptions.fields;
          }
        }
        var params: Record<string, any> = {
          sysparm_query: query,
          sysparm_limit: limit,
          sysparm_display_value: false
        };
        if (fields) {
          params.sysparm_fields = fields.join(",");
        }
        var data = await request<{ result: Array<T> }>(
          {
            method: "GET",
            url: "/api/now/table/" + encodeURIComponent(table),
            params: params
          },
          "table.query(" + table + ")"
        );
        return data.result || [];
      }
    },
    claude: {
      createRecord: async function (params) {
        var data = await dovetailRequest<{ result: any }>(
          "POST",
          "createRecord",
          params,
          null,
          "claude.createRecord(" + params.table + ")",
        );
        return data.result || data;
      },
      pushWithUpdateSet: async function (params) {
        var data = await dovetailRequest<{ result: any }>(
          "POST",
          "pushWithUpdateSet",
          params,
          null,
          "claude.pushWithUpdateSet(" + params.table + ")",
        );
        return data.result || data;
      },
      currentUpdateSet: async function (scope) {
        var data = await dovetailRequest<{ result: any }>(
          "GET",
          "currentUpdateSet",
          null,
          scope ? { scope: scope } : null,
          "claude.currentUpdateSet",
        );
        return data.result || data;
      }
    }
  };
}
