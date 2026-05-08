/**
 * @tenonhq/dovetail-mcp
 *
 * MCP server exposing read-only tools for ClickUp, Gmail, Google Calendar,
 * and ServiceNow, backed by the existing Dovetail integration packages.
 *
 * Library exports here are consumed by tests and by alternate hosts
 * (e.g. an HTTP transport in the future). The bin entry lives in server.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  loadConfig,
  formatMissingEnvError,
  ServiceNowSafetyConfig
} from "./config";
import type { ClickUpConfig, GoogleConfig, SincMcpConfig } from "./config";
import { registerAllTools, TOOL_NAMES } from "./registry";
import type { ToolName, RegistryDeps } from "./registry";

export { TOOL_NAMES };
export type { ToolName, SincMcpConfig, ClickUpConfig, GoogleConfig, ServiceNowSafetyConfig };

export interface CreateServerOptions {
  /** Override loaded config; tests pass mocks here. */
  registryDeps?: RegistryDeps;
  /** Override server name shown to MCP clients. */
  serverName?: string;
  /** Override package version reported to MCP clients. */
  serverVersion?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  var server = new McpServer({
    name: options.serverName || "dovetail-mcp",
    version: options.serverVersion || "0.0.1"
  });

  var deps = options.registryDeps || buildDepsFromEnv();
  registerAllTools(server, deps);
  return server;
}

export function buildDepsFromEnv(): RegistryDeps {
  var loaded = loadConfig();
  var missingDescription: string | undefined;
  var hasMissing = loaded.missing.clickup.length > 0 || loaded.missing.google.length > 0;
  if (hasMissing) {
    missingDescription = formatMissingEnvError(loaded.missing);
  }

  var deps: RegistryDeps = {
    servicenow: { safety: loaded.config.servicenowSafety },
    missingDescription: missingDescription
  };

  if (loaded.config.clickup) {
    deps.clickup = { config: loaded.config.clickup };
  }
  if (loaded.config.google) {
    deps.gmail = { config: loaded.config.google };
    deps.calendar = { config: loaded.config.google };
  }
  return deps;
}
