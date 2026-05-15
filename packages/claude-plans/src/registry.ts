/**
 * Tool registration glue for the MCP server. Mirrors the descriptor + handler
 * pattern from @tenonhq/dovetail-mcp's registry.ts. Handlers stay thin —
 * validation lives in zod schemas, persistence in storage.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  pushPlanSchema,
  updatePlanStatusSchema,
  getPlanSchema,
  listRecentPlansSchema,
  pushArtifactSchema,
  pushDiagramSchema
} from "./schemas";
import {
  pushPlan,
  updatePlanStatus,
  getPlan,
  listPlans,
  pushArtifact,
  StorageOptions
} from "./storage";

export var TOOL_NAMES = [
  "push_plan",
  "update_plan_status",
  "get_plan",
  "list_recent_plans",
  "push_artifact",
  "push_diagram"
] as const;

export type ToolName = typeof TOOL_NAMES[number];

export interface RegistryDeps {
  storage?: StorageOptions;
}

interface ToolDescriptor {
  name: ToolName;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: any) => Promise<any>;
}

var MERMAID_HEADERS = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|c4Context)\b/;

function validateMermaid(source: string): void {
  if (!MERMAID_HEADERS.test(source)) {
    throw new Error(
      "mermaid_source does not start with a recognized diagram header (graph, flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, journey, gitGraph, mindmap, timeline, quadrantChart, requirementDiagram, c4Context)"
    );
  }
}

function sessionIdFromEnv(): string | null {
  var id = process.env.CLAUDE_CODE_SESSION_ID;
  return id ? id : null;
}

export function buildDescriptors(deps: RegistryDeps = {}): ToolDescriptor[] {
  var storageOpts = deps.storage || {};

  return [
    {
      name: "push_plan",
      description:
        "Create or update a plan. Markdown body (content_md) or raw HTML (content_html, sanitized by DOMPurify in the browser) shows in the dashboard's /claude-plans panel. Auto-slugs from title when slug is omitted. Status defaults to DRAFT.",
      shape: pushPlanSchema.shape,
      handler: async function (args: any) {
        var parsed = pushPlanSchema.parse(args);
        if (!parsed.content_md && !parsed.content_html) {
          throw new Error("at least one of content_md or content_html must be provided");
        }
        return pushPlan(
          {
            slug: parsed.slug,
            title: parsed.title,
            content_md: parsed.content_md,
            content_html: parsed.content_html,
            status: parsed.status,
            session_id: parsed.session_id === undefined ? sessionIdFromEnv() : parsed.session_id
          },
          storageOpts
        );
      }
    },
    {
      name: "update_plan_status",
      description:
        "Transition a plan's status. Allowed: DRAFT->APPROVED, DRAFT->EXITED, APPROVED->EXITED. Reverses and skips are rejected.",
      shape: updatePlanStatusSchema.shape,
      handler: async function (args: any) {
        var parsed = updatePlanStatusSchema.parse(args);
        return updatePlanStatus(parsed.slug, parsed.to, storageOpts);
      }
    },
    {
      name: "get_plan",
      description: "Returns a plan record with its nested artifacts.",
      shape: getPlanSchema.shape,
      handler: async function (args: any) {
        var parsed = getPlanSchema.parse(args);
        var result = getPlan(parsed.slug, storageOpts);
        if (!result) throw new Error("plan not found: " + parsed.slug);
        return result;
      }
    },
    {
      name: "list_recent_plans",
      description: "List plans newest-first. Optional filters: status, limit (default 20).",
      shape: listRecentPlansSchema.shape,
      handler: async function (args: any) {
        var parsed = listRecentPlansSchema.parse(args || {});
        var limit = parsed.limit || 20;
        return { plans: listPlans({ limit: limit, status: parsed.status, rootDir: storageOpts.rootDir }) };
      }
    },
    {
      name: "push_artifact",
      description:
        "Attach an artifact (markdown or mermaid) to an existing plan. The dashboard renders artifacts under the plan's Artifacts tab.",
      shape: pushArtifactSchema.shape,
      handler: async function (args: any) {
        var parsed = pushArtifactSchema.parse(args);
        if (parsed.kind === "mermaid") validateMermaid(parsed.content);
        return pushArtifact(parsed, storageOpts);
      }
    },
    {
      name: "push_diagram",
      description:
        "Attach a Mermaid diagram to a plan. Convenience wrapper around push_artifact with kind='mermaid'. Validates the source begins with a recognized Mermaid header.",
      shape: pushDiagramSchema.shape,
      handler: async function (args: any) {
        var parsed = pushDiagramSchema.parse(args);
        validateMermaid(parsed.mermaid_source);
        return pushArtifact(
          {
            plan_slug: parsed.plan_slug,
            slug: parsed.slug,
            kind: "mermaid",
            title: parsed.title,
            content: parsed.mermaid_source
          },
          storageOpts
        );
      }
    }
  ];
}

export function registerAllTools(server: McpServer, deps: RegistryDeps = {}): void {
  var descriptors = buildDescriptors(deps);
  for (var i = 0; i < descriptors.length; i++) registerOne(server, descriptors[i]);
}

function registerOne(server: McpServer, desc: ToolDescriptor): void {
  (server.registerTool as any)(
    desc.name,
    { description: desc.description, inputSchema: desc.shape },
    async function (args: any) {
      try {
        var result = await desc.handler(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        var message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, tool: desc.name })
            }
          ]
        };
      }
    }
  );
}
