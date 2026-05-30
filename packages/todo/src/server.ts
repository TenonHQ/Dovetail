/**
 * MCP stdio transport runner. Invoked via `dove-todo mcp`.
 * --smoke lists registered tools and exits (CI verification without a transport).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./index";
import { TOOL_NAMES } from "./registry";

export async function runSmoke(): Promise<void> {
  var lines: string[] = [];
  lines.push("dovetail-todo smoke test");
  lines.push("Registered tools (" + TOOL_NAMES.length + "):");
  for (var i = 0; i < TOOL_NAMES.length; i++) lines.push("  - " + TOOL_NAMES[i]);
  process.stdout.write(lines.join("\n") + "\n");
}

export async function runStdio(): Promise<void> {
  var server = createServer();
  var transport = new StdioServerTransport();
  await server.connect(transport);
}
