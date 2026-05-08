#!/usr/bin/env node
/**
 * Bin entry. Library exports come from index.ts; this file only runs the
 * stdio transport and supports a `--smoke` flag for CI verification that
 * doesn't depend on a live MCP client.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./index";
import { TOOL_NAMES } from "./registry";

export { createServer };

async function runSmoke(): Promise<void> {
  // List the registered tools and exit. Verifies wiring without a transport.
  var lines: string[] = [];
  lines.push("dovetail-mcp smoke test");
  lines.push("Registered tools (" + TOOL_NAMES.length + "):");
  for (var i = 0; i < TOOL_NAMES.length; i++) {
    lines.push("  - " + TOOL_NAMES[i]);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function runStdio(): Promise<void> {
  var server = createServer();
  var transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  if (process.argv.indexOf("--smoke") !== -1) {
    await runSmoke();
    return;
  }
  await runStdio();
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write("dovetail-mcp fatal: " + (err && err.message ? err.message : String(err)) + "\n");
    process.exit(1);
  });
}
