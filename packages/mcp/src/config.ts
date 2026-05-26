/**
 * Aggregates env-var requirements across the four integrations into a single
 * loadConfig() so users see every missing var at once instead of fixing them
 * one at a time. ServiceNow's createClient() handles its own env precedence
 * (SN_* > SN_DEV_* > SN_PROD_*) — we surface its error verbatim.
 *
 * The ServiceNow deny-list defaults to tables that disclose secrets or audit
 * data on read; users opt in with SINC_MCP_SN_TABLE_OVERRIDE.
 */

export interface ClickUpConfig {
  token: string;
  defaultTeamId?: string;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface ServiceNowSafetyConfig {
  denyTables: string[];
  overrideTables: string[];
}

export interface SincMcpConfig {
  clickup?: ClickUpConfig;
  google?: GoogleConfig;
  servicenowSafety: ServiceNowSafetyConfig;
  // Phase-2 master gate. When false, all write tools refuse. Set via SINC_MCP_WRITES_ENABLE=1.
  writesEnabled: boolean;
}

export interface ConfigLoadResult {
  config: SincMcpConfig;
  missing: { clickup: string[]; google: string[] };
}

var DEFAULT_DENY_TABLES = [
  "sys_user_password",
  "sys_user_token",
  "sys_credential",
  "sys_secret",
  "sys_user_grmember",
  "sys_audit"
];

export function loadConfig(): ConfigLoadResult {
  var clickupMissing = collectClickupMissing();
  var googleMissing = collectGoogleMissing();

  var clickup: ClickUpConfig | undefined;
  if (clickupMissing.length === 0) {
    clickup = {
      token: process.env.CLICKUP_API_TOKEN as string,
      defaultTeamId: process.env.CLICKUP_TEAM_ID || undefined
    };
  }

  var google: GoogleConfig | undefined;
  if (googleMissing.length === 0) {
    google = {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN as string
    };
  }

  return {
    config: {
      clickup: clickup,
      google: google,
      servicenowSafety: loadServiceNowSafety(),
      writesEnabled: process.env.SINC_MCP_WRITES_ENABLE === "1"
    },
    missing: { clickup: clickupMissing, google: googleMissing }
  };
}

function collectClickupMissing(): string[] {
  var missing: string[] = [];
  if (!process.env.CLICKUP_API_TOKEN) missing.push("CLICKUP_API_TOKEN");
  return missing;
}

function collectGoogleMissing(): string[] {
  var missing: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!process.env.GOOGLE_REFRESH_TOKEN) missing.push("GOOGLE_REFRESH_TOKEN");
  return missing;
}

function loadServiceNowSafety(): ServiceNowSafetyConfig {
  var deny = process.env.SINC_MCP_SN_TABLE_DENY
    ? splitCsv(process.env.SINC_MCP_SN_TABLE_DENY)
    : DEFAULT_DENY_TABLES.slice();
  var override = process.env.SINC_MCP_SN_TABLE_OVERRIDE
    ? splitCsv(process.env.SINC_MCP_SN_TABLE_OVERRIDE)
    : [];
  return { denyTables: deny, overrideTables: override };
}

function splitCsv(s: string): string[] {
  var raw = s.split(",");
  var out: string[] = [];
  for (var i = 0; i < raw.length; i++) {
    var trimmed = raw[i].trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

export function formatMissingEnvError(missing: { clickup: string[]; google: string[] }): string {
  var parts: string[] = [];
  if (missing.clickup.length > 0) {
    parts.push("ClickUp: " + missing.clickup.join(", "));
  }
  if (missing.google.length > 0) {
    parts.push("Google (Gmail/Calendar): " + missing.google.join(", "));
  }
  return "Missing required environment variables — " + parts.join("; ") + ".";
}
