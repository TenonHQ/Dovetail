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
  pushDiagramSchema,
  deletePlanSchema
} from "./schemas";
import {
  pushPlan,
  updatePlanStatus,
  getPlan,
  listPlans,
  pushArtifact,
  deletePlan,
  StorageOptions
} from "./storage";

export var TOOL_NAMES = [
  "push_plan",
  "update_plan_status",
  "get_plan",
  "list_recent_plans",
  "push_artifact",
  "push_diagram",
  "delete_plan"
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
        "Create or update a plan shown in the Dovetail dashboard at /claude-plans. " +
        "Auto-slugs from title when slug is omitted. Status defaults to DRAFT.\n\n" +
        "Content — supply exactly one of:\n" +
        "  content_md: string — raw Markdown\n" +
        "  content_html: string — raw HTML (sanitized by DOMPurify)\n" +
        "  content_structured: object — zero-design component layout (preferred). Schema:\n" +
        "    { sections: [ ...section objects ] }\n\n" +
        "content_structured section types:\n" +
        '  { type:"header", title, subtitle? }\n' +
        '    Large title block, optional subtitle.\n' +
        '  { type:"meta", title?, rows:[{label,value,badge?}] }\n' +
        '    Key-value table. badge values: default|success|warning|danger|info\n' +
        '  { type:"callout", variant?, title?, message }\n' +
        '    Alert box. variant: info|warning|danger|success (default: info)\n' +
        '  { type:"checklist", title?, items:[{label,done,note?}] }\n' +
        '    Task list with checked/unchecked items.\n' +
        '  { type:"steps", title?, steps:[{label,status,note?}] }\n' +
        '    Pipeline stages. status: done|active|pending|error\n' +
        '  { type:"metrics", items:[{label,value,sub?,variant?}] }\n' +
        '    Stat cards. variant: default|success|warning|danger|info\n' +
        '  { type:"section", title }\n' +
        '    Labeled section divider.\n' +
        '  { type:"table", title?, headers:string[], rows:string[][] }\n' +
        '    Data table.\n' +
        '  { type:"text", content }\n' +
        '    Plain paragraph. Newlines become <br>.\n' +
        '  { type:"code", title?, lang?, content }\n' +
        "    Preformatted code block.\n\n" +
        "Example content_structured:\n" +
        '  { "sections": [\n' +
        '    { "type":"header", "title":"Deploy PR #42", "subtitle":"DEV → PROD" },\n' +
        '    { "type":"meta", "rows":[{"label":"Branch","value":"feature/auth"},{"label":"Status","value":"Approved","badge":"success"}] },\n' +
        '    { "type":"steps", "steps":[{"label":"DEV","status":"done"},{"label":"TEST","status":"active"},{"label":"PROD","status":"pending"}] },\n' +
        '    { "type":"checklist", "title":"Pre-deploy", "items":[{"label":"Tests pass","done":true},{"label":"Migration run","done":false}] }\n' +
        "  ] }",
      shape: pushPlanSchema.shape,
      handler: async function (args: any) {
        var parsed = pushPlanSchema.parse(args);
        if (!parsed.content_md && !parsed.content_html && !parsed.content_structured) {
          throw new Error(
            "at least one of content_md, content_html, or content_structured must be provided"
          );
        }
        return pushPlan(
          {
            slug: parsed.slug,
            title: parsed.title,
            content_md: parsed.content_md,
            content_html: parsed.content_html,
            content_structured: parsed.content_structured as any,
            status: parsed.status,
            session_id: parsed.session_id === undefined ? sessionIdFromEnv() : parsed.session_id,
            pr_number: parsed.pr_number,
            pr_url: parsed.pr_url,
            pr_title: parsed.pr_title
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
    },
    {
      name: "delete_plan",
      description: "Permanently delete a plan and all its artifacts from local storage.",
      shape: deletePlanSchema.shape,
      handler: async function (args: any) {
        var parsed = deletePlanSchema.parse(args);
        var deleted = deletePlan(parsed.slug, storageOpts);
        return { deleted: deleted, slug: parsed.slug };
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
