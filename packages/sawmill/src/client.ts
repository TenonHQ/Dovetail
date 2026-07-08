import axios, { AxiosInstance, AxiosError } from "axios";
import rateLimit from "axios-rate-limit";
import { SawmillApiConfig, PromoteRequest, PromoteResponse } from "./types";

var PROMOTE_PATH = "/api/cadso/dovetail_promote/promote";
var MAX_RETRIES = 3;
var RATE_LIMIT_PER_SEC = 20;

export interface SawmillApi {
  readonly instance: string;
  promote(req: PromoteRequest): Promise<PromoteResponse>;
}

export class SawmillApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "SawmillApiError";
    this.status = status;
    this.body = body;
  }
}

// Accepts a full URL ("https://x.service-now.com"), a bare host
// ("x.service-now.com"), or just an instance subdomain ("x"). Only the bare
// subdomain gets ".service-now.com" appended — a value that already contains a
// dot is treated as a complete host, so "x.service-now.com" is never doubled
// into "x.service-now.com.service-now.com".
export function buildBaseUrl(instance: string): string {
  var trimmed = instance.replace(/\/+$/, "");
  if (trimmed.indexOf("http://") === 0 || trimmed.indexOf("https://") === 0) {
    return trimmed;
  }
  if (trimmed.indexOf(".") !== -1) {
    return "https://" + trimmed;
  }
  return "https://" + trimmed + ".service-now.com";
}

function createClient(config: SawmillApiConfig): AxiosInstance {
  var raw = axios.create({
    baseURL: buildBaseUrl(config.instance),
    auth: { username: config.username, password: config.password },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    validateStatus: function (status: number) {
      return status >= 200 && status < 300;
    },
  });
  return rateLimit(raw, {
    maxRequests: RATE_LIMIT_PER_SEC,
    perMilliseconds: 1000,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfter(header: unknown): number {
  if (typeof header !== "string") return 1000;
  var n = Number(header);
  if (!isNaN(n)) return Math.max(0, n * 1000);
  var when = Date.parse(header);
  if (!isNaN(when)) return Math.max(0, when - Date.now());
  return 1000;
}

// Retry predicate: 5xx retried up to MAX_RETRIES UNLESS this is a commit (commit:true is never retried on 5xx — commits are non-idempotent)
function shouldRetry5xx(isCommit: boolean): boolean {
  return !isCommit;
}

export function createSawmillApi(config: SawmillApiConfig): SawmillApi {
  if (!config || !config.instance || !config.username || !config.password) {
    throw new Error(
      "createSawmillApi requires instance, username, and password",
    );
  }
  var client = createClient(config);

  async function promote(req: PromoteRequest): Promise<PromoteResponse> {
    if (!req || !req.sourceInstance || !req.updateSetName) {
      throw new Error("promote requires sourceInstance and updateSetName");
    }
    var body: Record<string, unknown> = {
      sourceInstance: req.sourceInstance,
      updateSetName: req.updateSetName,
      commit: req.commit === true,
    };
    if (req.skipPreviewErrors !== undefined) {
      body.skipPreviewErrors = req.skipPreviewErrors;
    }

    var attempt = 0;
    while (true) {
      try {
        var response = await client.post(PROMOTE_PATH, body);
        return response.data as PromoteResponse;
      } catch (err) {
        var axErr = err as AxiosError;
        var status = axErr.response ? axErr.response.status : 0;
        var respBody = axErr.response ? axErr.response.data : undefined;

        if (status === 401 || status === 403) {
          throw new SawmillApiError(
            status,
            respBody,
            "Sawmill auth failed (HTTP " + status + ")",
          );
        }

        if (status === 429) {
          if (attempt >= MAX_RETRIES) {
            throw new SawmillApiError(
              status,
              respBody,
              "Sawmill rate limited (429) — retries exhausted",
            );
          }
          var retryAfter = parseRetryAfter(
            axErr.response && axErr.response.headers
              ? (axErr.response.headers as Record<string, unknown>)[
                  "retry-after"
                ]
              : undefined,
          );
          await sleep(retryAfter);
          attempt = attempt + 1;
          continue;
        }

        if (
          status >= 500 &&
          status < 600 &&
          shouldRetry5xx(body.commit === true)
        ) {
          if (attempt >= MAX_RETRIES) {
            throw new SawmillApiError(
              status,
              respBody,
              "Sawmill server error (HTTP " + status + ") — retries exhausted",
            );
          }
          var backoff = Math.pow(2, attempt) * 500;
          await sleep(backoff);
          attempt = attempt + 1;
          continue;
        }

        if (status >= 200 && status < 300) {
          throw err;
        }
        throw new SawmillApiError(
          status,
          respBody,
          "Sawmill request failed (HTTP " + status + ")",
        );
      }
    }
  }

  return {
    instance: config.instance,
    promote: promote,
  };
}
