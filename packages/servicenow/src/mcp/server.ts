/**
 * Self-contained MCP stdio server for @tenonhq/dovetail-servicenow. Invoked via
 * `dove-sn mcp`. Exposes the form/list/related-list layout tools and
 * add_choices_to_field to Claude Code and agents.
 *
 * Kept under src/mcp/ so the library barrel (index.ts) stays free of the MCP SDK
 * dependency — plain library consumers never load it.
 *
 * `runSmoke` lists the registered tools and exits (CI verification with no transport).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerAllTools, TOOL_NAMES } from "./registry";
import type { RegistryDeps } from "./registry";

export interface CreateServerOptions {
  registryDeps?: RegistryDeps;
  serverName?: string;
  serverVersion?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  var server = new McpServer({
    name: options.serverName || "dovetail-servicenow",
    version: options.serverVersion || "0.1.0"
  });
  registerAllTools(server, options.registryDeps || {});
  return server;
}

export async function runSmoke(): Promise<void> {
  var lines: Array<string> = [];
  lines.push("dovetail-servicenow MCP smoke test");
  lines.push("Registered tools (" + TOOL_NAMES.length + "):");
  for (var i = 0; i < TOOL_NAMES.length; i += 1) {
    lines.push("  - " + TOOL_NAMES[i]);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

export async function runStdio(): Promise<void> {
  var server = createServer();
  var transport = new StdioServerTransport();
  await server.connect(transport);
}
