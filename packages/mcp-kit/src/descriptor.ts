import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * The shared descriptor every Dovetail MCP server builds its tools as.
 *
 * `name` is a plain string so each package keeps its own narrower ToolName union
 * (a string-literal subtype is assignable here) while the kit stays generic.
 * When `outputSchema` is set, registerKitTool returns `structuredContent` in
 * addition to the legacy JSON-in-text content block.
 */
export interface KitToolDescriptor {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  annotations: ToolAnnotations;
  outputSchema?: z.ZodRawShape;
  handler: (args: any) => Promise<any>;
}
