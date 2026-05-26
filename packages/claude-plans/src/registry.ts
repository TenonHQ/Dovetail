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
  deletePlanSchema,
  getHandoffBundleSchema
} from "./schemas";
import {
  pushPlan,
  updatePlanStatus,
  getPlan,
  listPlans,
  pushArtifact,
  deletePlan,
  buildHandoffBundle,
  StorageOptions
} from "./storage";

export var TOOL_NAMES = [
  "push_plan",
  "update_plan_status",
  "get_plan",
  "list_recent_plans",
  "push_artifact",
  "push_diagram",
  "delete_plan",
  "get_handoff_bundle"
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

// Sequence-diagram arrow tokens: -> --> ->> -->> -x --x -) --)
var SEQ_ARROW = /(--?>>?|--?[)x])/;

// Strip a wrapping markdown code fence and normalize line endings/BOM/whitespace.
// LLM-authored sources frequently arrive fenced (```mermaid … ```) or with CRLF,
// which makes Mermaid fail on line 1.
function normalizeMermaid(source: string): string {
  var s = source == null ? "" : String(source);
  s = s.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  s = s.replace(/^\s*```[^\n]*\n/, "").replace(/\n```\s*$/, "");
  return s.trim();
}

// In a sequenceDiagram, ';' is a statement separator — a ';' inside message or
// note text silently splits the line and breaks the parser ("Syntax error in
// text"). Reject it with an actionable message. Scoped to sequenceDiagram only,
// since ';' is legal in flowchart/classDef statements.
function lintSequenceSemicolons(source: string): void {
  if (!/^\s*sequenceDiagram\b/.test(source)) return;
  var lines = source.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var colon = line.indexOf(":");
    if (colon === -1) continue;
    var head = line.slice(0, colon);
    var text = line.slice(colon + 1);
    if (text.indexOf(";") === -1) continue;
    var isMessage = SEQ_ARROW.test(head);
    var isNote = /^\s*[Nn]ote\b/.test(head);
    if (isMessage || isNote) {
      throw new Error(
        "mermaid sequenceDiagram line " + (i + 1) + " contains ';' in its text (\"" +
        text.trim() + "\"). Mermaid treats ';' as a statement separator, which breaks " +
        "the diagram — replace ';' with ',' or rephrase."
      );
    }
  }
}

// Validate and normalize a mermaid source. Returns the cleaned source to store
// so the dashboard renders exactly what was validated.
function validateMermaid(source: string): string {
  var normalized = normalizeMermaid(source);
  if (!MERMAID_HEADERS.test(normalized)) {
    throw new Error(
      "mermaid_source does not start with a recognized diagram header (graph, flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, journey, gitGraph, mindmap, timeline, quadrantChart, requirementDiagram, c4Context)"
    );
  }
  lintSequenceSemicolons(normalized);
  return normalized;
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
            content_structured: parsed.content_structured,
            status: parsed.status,
            session_id: parsed.session_id === undefined ? sessionIdFromEnv() : parsed.session_id,
            pr_number: parsed.pr_number,
            pr_url: parsed.pr_url,
            pr_title: parsed.pr_title,
            linked_artifacts: parsed.linked_artifacts
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
        "Attach an artifact to an existing plan. Kind is one of:\n" +
        "  markdown — raw Markdown content.\n" +
        "  mermaid — a Mermaid diagram source (must start with a recognized header).\n" +
        "  prompt-cycle — a JSON-stringified PromptCyclePayload capturing an /improve-prompt run:\n" +
        "    { schema_version:1, original_draft, lint_before:{score,missing,antipatterns?,ceremony?},\n" +
        "      open_questions:[{question,header?,options,answer}], rewritten_prompt,\n" +
        "      lint_after:{score,missing,ceremony?}, source_plan_slug? }\n" +
        "The dashboard renders artifacts under the plan's Artifacts tab.",
      shape: pushArtifactSchema.shape,
      handler: async function (args: any) {
        var parsed = pushArtifactSchema.parse(args);
        if (parsed.kind === "mermaid") parsed.content = validateMermaid(parsed.content);
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
        var source = validateMermaid(parsed.mermaid_source);
        return pushArtifact(
          {
            plan_slug: parsed.plan_slug,
            slug: parsed.slug,
            kind: "mermaid",
            title: parsed.title,
            content: source
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
    },
    {
      name: "get_handoff_bundle",
      description:
        "Compose a single paste-ready Markdown payload for resuming a plan in a fresh Claude session. " +
        "Combines the plan content, its artifacts (markdown / mermaid / prompt-cycle), and optional " +
        "linked-plan expansion. When the plan (or a followed linked plan) carries a prompt-cycle " +
        "artifact, its rewritten_prompt is hoisted to a final '🎯 READY-TO-PASTE PROMPT' section so " +
        "the receiving session can copy it without scrolling.\n\n" +
        "Inputs:\n" +
        "  slug (required) — the plan slug to bundle.\n" +
        "  follow_links (optional, default false) — when true, inline-expands linked plans with relation\n" +
        "    'built-from' or 'improves' (1 level deep, no recursion).\n" +
        "  include_artifact_kinds (optional) — restrict which kinds appear in the bundle.\n\n" +
        "Output: { slug, markdown, ready_to_paste_prompt }.",
      shape: getHandoffBundleSchema.shape,
      handler: async function (args: any) {
        var parsed = getHandoffBundleSchema.parse(args || {});
        return buildHandoffBundle(parsed.slug, {
          rootDir: storageOpts.rootDir,
          follow_links: parsed.follow_links,
          include_artifact_kinds: parsed.include_artifact_kinds
        });
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
