/**
 * @tenonhq/dovetail-todo — library exports.
 * The bin entry lives in cli.ts (it also hosts the `mcp` subcommand).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAllTools, TOOL_NAMES } from "./registry";
import type { RegistryDeps, ToolName } from "./registry";

export { TOOL_NAMES };
export type { ToolName, RegistryDeps };
export * from "./types";
export * as storage from "./storage";

export interface CreateServerOptions {
  registryDeps?: RegistryDeps;
  serverName?: string;
  serverVersion?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  var server = new McpServer({
    name: options.serverName || "dovetail-todo",
    version: options.serverVersion || "0.0.1"
  });
  registerAllTools(server, options.registryDeps || {});
  return server;
}
