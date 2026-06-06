/**
 * The shared registerOne. Wires a KitToolDescriptor onto an McpServer:
 *  - registers description + inputSchema + annotations (+ outputSchema when set),
 *  - optionally wraps the handler in an injected telemetry recorder,
 *  - serializes the result to a text content block (plus structuredContent when
 *    outputSchema is declared),
 *  - maps any thrown error to the unified { error, retryable, tool } contract.
 *
 * This is lifted from dovetail-mcp's registry — the richest of the three — so
 * the retryable error contract and telemetry seam are preserved verbatim, not
 * re-derived.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { mapToolError } from "./errors";
import type { KitToolDescriptor } from "./descriptor";

export interface RegisterOptions {
  /**
   * Inject a telemetry wrapper (e.g. the kit's withTelemetry). When omitted the
   * handler runs untelemetered — used by servers that do not record telemetry
   * yet. Keeping it injectable means telemetry parity stays a one-line opt-in.
   */
  telemetry?: <T>(tool: string, args: unknown, fn: () => Promise<T>) => Promise<T>;
}

export function registerKitTool(
  server: McpServer,
  desc: KitToolDescriptor,
  opts?: RegisterOptions
): void {
  var telemetry = opts ? opts.telemetry : undefined;

  var config: any = {
    description: desc.description,
    inputSchema: desc.shape,
    annotations: desc.annotations
  };
  if (desc.outputSchema) {
    config.outputSchema = desc.outputSchema;
  }

  // Cast at the SDK boundary: registerTool's deep generic inference over
  // ZodRawShapeCompat blows past the TypeScript instantiation depth limit when
  // a heterogeneous descriptor list feeds the same call site.
  (server.registerTool as any)(
    desc.name,
    config,
    async function (args: any) {
      try {
        var run = function () {
          return desc.handler(args);
        };
        var result = telemetry ? await telemetry(desc.name, args, run) : await run();
        if (desc.outputSchema) {
          return {
            structuredContent: result,
            content: [{ type: "text" as const, text: JSON.stringify(result) }]
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }]
        };
      } catch (err) {
        var mapped = mapToolError(err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: mapped.message,
                retryable: mapped.retryable,
                tool: desc.name
              })
            }
          ]
        };
      }
    }
  );
}

export function registerKitTools(
  server: McpServer,
  descs: KitToolDescriptor[],
  opts?: RegisterOptions
): void {
  for (var i = 0; i < descs.length; i++) {
    registerKitTool(server, descs[i], opts);
  }
}
