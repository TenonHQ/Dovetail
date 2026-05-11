import { loadConfig, formatMissingEnvError } from "../config";

var ENV_KEYS = [
  "CLICKUP_API_TOKEN",
  "CLICKUP_TEAM_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "SINC_MCP_SN_TABLE_DENY",
  "SINC_MCP_SN_TABLE_OVERRIDE"
];

describe("loadConfig", function () {
  var saved: Record<string, string | undefined> = {};

  beforeEach(function () {
    ENV_KEYS.forEach(function (k) {
      saved[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(function () {
    ENV_KEYS.forEach(function (k) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k] as string;
      }
    });
  });

  it("aggregates every missing env var across both google and clickup", function () {
    var result = loadConfig();
    expect(result.missing.clickup).toEqual(["CLICKUP_API_TOKEN"]);
    expect(result.missing.google).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN"
    ]);
    expect(result.config.clickup).toBeUndefined();
    expect(result.config.google).toBeUndefined();
  });

  it("populates clickup config when CLICKUP_API_TOKEN is set", function () {
    process.env.CLICKUP_API_TOKEN = "pk_t";
    process.env.CLICKUP_TEAM_ID = "1";
    var result = loadConfig();
    expect(result.missing.clickup).toEqual([]);
    expect(result.config.clickup).toEqual({ token: "pk_t", defaultTeamId: "1" });
  });

  it("populates google config only when all three vars are set", function () {
    process.env.GOOGLE_CLIENT_ID = "id";
    var partial = loadConfig();
    expect(partial.missing.google).toEqual([
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN"
    ]);
    expect(partial.config.google).toBeUndefined();

    process.env.GOOGLE_CLIENT_SECRET = "sec";
    process.env.GOOGLE_REFRESH_TOKEN = "tok";
    var full = loadConfig();
    expect(full.missing.google).toEqual([]);
    expect(full.config.google).toEqual({
      clientId: "id",
      clientSecret: "sec",
      refreshToken: "tok"
    });
  });

  it("uses default ServiceNow deny list when env override is unset", function () {
    var result = loadConfig();
    expect(result.config.servicenowSafety.denyTables).toEqual([
      "sys_user_password",
      "sys_user_token",
      "sys_credential",
      "sys_secret",
      "sys_user_grmember",
      "sys_audit"
    ]);
    expect(result.config.servicenowSafety.overrideTables).toEqual([]);
  });

  it("respects SINC_MCP_SN_TABLE_DENY and SINC_MCP_SN_TABLE_OVERRIDE", function () {
    process.env.SINC_MCP_SN_TABLE_DENY = "table_a, table_b ,";
    process.env.SINC_MCP_SN_TABLE_OVERRIDE = "table_b";
    var result = loadConfig();
    expect(result.config.servicenowSafety.denyTables).toEqual(["table_a", "table_b"]);
    expect(result.config.servicenowSafety.overrideTables).toEqual(["table_b"]);
  });
});

describe("formatMissingEnvError", function () {
  it("includes every missing var in a single message", function () {
    var msg = formatMissingEnvError({
      clickup: ["CLICKUP_API_TOKEN"],
      google: ["GOOGLE_CLIENT_ID", "GOOGLE_REFRESH_TOKEN"]
    });
    expect(msg).toContain("CLICKUP_API_TOKEN");
    expect(msg).toContain("GOOGLE_CLIENT_ID");
    expect(msg).toContain("GOOGLE_REFRESH_TOKEN");
    expect(msg).toContain("ClickUp");
    expect(msg).toContain("Google");
  });
});
