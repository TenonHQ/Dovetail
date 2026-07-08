import fs from "fs";
import dotenv from "dotenv";
import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import type { ServiceNowClientConfig } from "./types";

/**
 * Build a ServiceNowClientConfig from a `.env`-style file WITHOUT mutating the
 * global process.env.
 *
 * Unlike `loadEnvFile` (which calls `dotenv.config()` and is correct for a
 * one-shot CLI), this reads the file into a local object via `dotenv.parse` so
 * it is safe to call repeatedly inside a long-lived process — e.g. a per-call
 * retarget in the MCP server, where a global dotenv mutation would race across
 * concurrent reads.
 *
 * Instance/auth precedence within the file mirrors `createClient`'s env
 * precedence (SN_* > SN_DEV_* > SN_PROD_*) so a file written for either the
 * dev-style or prod-style variable names resolves the same way. The resolved
 * values are returned as an explicit config object — they are never read from
 * the surrounding process.env, so the file fully determines the target.
 *
 * Throws if the file cannot be read, or if it does not define an instance and
 * a complete credential pair — failing loudly rather than silently falling
 * back to whatever instance the host process happens to be pointed at.
 */
export function resolveConfigFromEnvFile(
  envPath: string,
): ServiceNowClientConfig {
  if (typeof envPath !== "string" || envPath.length === 0) {
    throw new Error(
      "resolveConfigFromEnvFile: envPath must be a non-empty string.",
    );
  }
  var raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (e: any) {
    throw new Error(
      "Cannot read env file '" +
        envPath +
        "': " +
        (e && e.message ? e.message : String(e)),
    );
  }

  var parsed = dotenv.parse(raw);

  var instance =
    parsed.SN_INSTANCE ||
    parsed.SN_DEV_INSTANCE ||
    parsed.SN_PROD_INSTANCE ||
    "";
  var user =
    parsed.SN_USER || parsed.SN_DEV_USERNAME || parsed.SN_PROD_USERNAME || "";
  var password =
    parsed.SN_PASSWORD ||
    parsed.SN_DEV_PASSWORD ||
    parsed.SN_PROD_PASSWORD ||
    "";

  if (!instance) {
    throw new Error(
      "env file '" +
        envPath +
        "' does not define a ServiceNow instance — " +
        "set SN_INSTANCE (preferred) or SN_DEV_INSTANCE / SN_PROD_INSTANCE.",
    );
  }
  if (!user || !password) {
    throw new Error(
      "env file '" +
        envPath +
        "' is missing ServiceNow credentials — " +
        "set SN_USER/SN_PASSWORD (preferred) or SN_DEV_USERNAME/SN_DEV_PASSWORD (or SN_PROD_*).",
    );
  }

  return { instance: instance, user: user, password: password };
}

/**
 * Construct a ServiceNowClient bound to the instance/credentials defined in a
 * `.env`-style file, without touching the global process.env. See
 * `resolveConfigFromEnvFile` for the precedence and failure rules.
 */
export function createClientFromEnvFile(envPath: string): ServiceNowClient {
  return createClient(resolveConfigFromEnvFile(envPath));
}
