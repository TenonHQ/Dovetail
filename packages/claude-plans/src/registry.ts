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
  pushPromptSchema,
  deletePlanSchema,
  getHandoffBundleSchema,
  pushQuestionSchema,
  recordAnswerSchema,
  getAnswersSchema,
  pushLintEventSchema,
  getLintEventsSchema,
  setStageSchema,
  pullPlanSchema
} from "./schemas";
import {
  pushPlan,
  updatePlanStatus,
  getPlan,
  listPlans,
  pushArtifact,
  pushPrompt,
  deletePlan,
  buildHandoffBundle,
  pushQuestion,
  recordAnswer,
  getAnswers,
  pushLintEvent,
  getLintEvents,
  setStage,
  loadPlanFull,
  StorageOptions
} from "./storage";

export var TOOL_NAMES = [
  "push_plan",
  "update_plan_status",
  "get_plan",
  "list_recent_plans",
  "push_artifact",
  "push_diagram",
  "push_prompt",
  "delete_plan",
  "get_handoff_bundle",
  "push_question",
  "record_answer",
  "get_answers",
  "push_lint_event",
  "get_lint_events",
  "set_stage",
  "pull_plan"
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

// Build the dashboard deep-link for a plan. Override the base via
// CLAUDE_PLANS_DASHBOARD_URL if the dashboard runs on a non-default port/host.
// Trailing slashes on the base are tolerated.
export function planDashboardUrl(slug: string): string {
  var raw = process.env.CLAUDE_PLANS_DASHBOARD_URL || "http://localhost:3456";
  var base = raw.replace(/\/+$/, "");
  return base + "/claude-plans?plan=" + encodeURIComponent(slug);
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
        var plan = pushPlan(
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
            linked_artifacts: parsed.linked_artifacts,
            categories: parsed.categories
          },
          storageOpts
        );
        return Object.assign({}, plan, { url: planDashboardUrl(plan.slug) });
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
      name: "push_prompt",
      description:
        "Attach a rewritten prompt to an existing plan. Surfaces on the dashboard's Prompt tab " +
        "alongside the plan that motivated it, and the newest prompt is hoisted into the " +
        "'READY-TO-PASTE PROMPT' section of get_handoff_bundle when no prompt-cycle artifact " +
        "already supplies one. Use this from /improve-prompt --push to persist a rewrite + " +
        "before/after lint scores so the next session can pick it up.\n\n" +
        "Inputs:\n" +
        "  plan_slug (required) — slug of the plan to attach to.\n" +
        "  title (required) — short label shown on the Prompt tab card.\n" +
        "  content (required) — the rewritten prompt body (XML scaffold or markdown).\n" +
        "  slug — optional explicit slug; auto-derived from title otherwise.\n" +
        "  source_draft — the original draft before rewrite (rendered in <details>).\n" +
        "  score_before / score_after — Turn-0 lint scores (0-100), shown as a badge.\n\n" +
        "Stored at <root>/<plan-slug>/prompts/<prompt-slug>.json. Dashboard updates live via SSE.",
      shape: pushPromptSchema.shape,
      handler: async function (args: any) {
        var parsed = pushPromptSchema.parse(args);
        return pushPrompt(parsed, storageOpts);
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
    },
    {
      name: "push_question",
      description:
        "Park a question on an existing plan so it can be answered by the operator (dashboard) " +
        "or another Claude session. Returns the new PlanQuestion with an assigned id (format: " +
        "q_<8-hex>). The id is required to call record_answer later.\n\n" +
        "Inputs:\n" +
        "  plan_slug (required) — the plan that owns this question.\n" +
        "  question (required) — the question text.\n" +
        "  header (optional, <=24 chars) — short chip label, mirrors AskUserQuestion.\n" +
        "  options (optional, up to 8) — suggested answers.\n" +
        "  stage (optional, free-form, <=32 chars) — pipeline stage that raised it\n" +
        "    (e.g. 'research', 'plan', 'tests'). No enum — free text for v2.\n" +
        "  asked_by (optional) — agent or session label (e.g. 'idea-shaper').\n\n" +
        "Notes: appends to the plan's questions list (creating it if absent). Last-write-wins " +
        "atomic write of the plan record; dashboard watcher picks up the change on save.",
      shape: pushQuestionSchema.shape,
      handler: async function (args: any) {
        var parsed = pushQuestionSchema.parse(args);
        var resolvedAskedBy = parsed.asked_by !== undefined
          ? parsed.asked_by
          : (process.env.CLAUDE_CODE_SESSION_ID || undefined);
        return pushQuestion(
          {
            plan_slug: parsed.plan_slug,
            question: parsed.question,
            header: parsed.header,
            options: parsed.options,
            stage: parsed.stage,
            asked_by: resolvedAskedBy
          },
          storageOpts
        );
      }
    },
    {
      name: "record_answer",
      description:
        "Record (or overwrite) an answer to a question on a plan. The question must already " +
        "exist on the plan — call push_question first if it does not. Returns the updated " +
        "PlanQuestion. Last-write-wins; previous answer (if any) is replaced.\n\n" +
        "Inputs:\n" +
        "  plan_slug (required) — the plan that owns the question.\n" +
        "  question_id (required, matches /^q_[0-9a-f]{8}$/) — the id returned by push_question.\n" +
        "  answer (required, non-empty) — free-text answer; not validated against the\n" +
        "    question's options[] (operators may answer off-menu).\n" +
        "  answered_by (optional) — who answered ('daniel', 'claude', agent name).",
      shape: recordAnswerSchema.shape,
      handler: async function (args: any) {
        var parsed = recordAnswerSchema.parse(args);
        return recordAnswer(
          {
            plan_slug: parsed.plan_slug,
            question_id: parsed.question_id,
            answer: parsed.answer,
            answered_by: parsed.answered_by
          },
          storageOpts
        );
      }
    },
    {
      name: "get_answers",
      description:
        "List Q&A entries for a plan with optional filters. Returns the full PlanQuestion list " +
        "(each entry has the question, the answer if recorded, and metadata). Empty list if the " +
        "plan has no questions or is a v1 record.\n\n" +
        "Inputs:\n" +
        "  plan_slug (required) — the plan to read.\n" +
        "  answered (optional boolean) — true: only items with an answer; false: only unanswered;\n" +
        "    absent: both.\n" +
        "  stage (optional) — exact-match filter on the question's stage tag.\n\n" +
        "Output: { plan_slug, questions: PlanQuestion[] }. Questions are returned in insertion order.",
      shape: getAnswersSchema.shape,
      handler: async function (args: any) {
        var parsed = getAnswersSchema.parse(args);
        return getAnswers(
          {
            plan_slug: parsed.plan_slug,
            answered: parsed.answered,
            stage: parsed.stage
          },
          storageOpts
        );
      }
    },
    {
      name: "push_lint_event",
      description:
        "Record a prompt-lint observation in the global lint-events store, surfaced on the " +
        "dashboard's standalone Prompt Lints page at /prompt-lints. Unlike artifacts/prompts, " +
        "lint events are NOT owned by a plan — they capture Turn-0 checklist scores for arbitrary " +
        "prompts (typically emitted by the UserPromptSubmit hook). plan_slug/session_id are " +
        "optional associations.\n\n" +
        "Inputs:\n" +
        "  score (required, 0-100) — Turn-0 checklist score.\n" +
        "  missing (optional) — missing checklist tags, e.g. [\"<done>\",\"<target>\"].\n" +
        "  antipatterns / ceremony (optional) — detected anti-patterns / ceremony words.\n" +
        "  threshold (optional) — the cutoff that triggered recording.\n" +
        "  prompt_excerpt (optional, <=2000 chars) — truncated prompt text for context.\n" +
        "  source (optional) — emitter label, e.g. \"hook\".\n" +
        "  session_id (optional) — Claude Code session id.\n" +
        "  plan_slug (optional) — associate with a plan if one applies.\n\n" +
        "Stored at <root>/_lint-events/<event-id>.json. Dashboard updates live via SSE.",
      shape: pushLintEventSchema.shape,
      handler: async function (args: any) {
        var parsed = pushLintEventSchema.parse(args);
        return pushLintEvent(
          {
            score: parsed.score,
            missing: parsed.missing,
            antipatterns: parsed.antipatterns,
            ceremony: parsed.ceremony,
            threshold: parsed.threshold,
            prompt_excerpt: parsed.prompt_excerpt,
            source: parsed.source,
            session_id: parsed.session_id === undefined ? sessionIdFromEnv() : parsed.session_id,
            plan_slug: parsed.plan_slug
          },
          storageOpts
        );
      }
    },
    {
      name: "get_lint_events",
      description:
        "List prompt-lint events from the global store, newest first. Optional filters: " +
        "session_id, plan_slug, limit (default all). Output: { events: PromptLintEvent[] }.",
      shape: getLintEventsSchema.shape,
      handler: async function (args: any) {
        var parsed = getLintEventsSchema.parse(args || {});
        return getLintEvents(
          {
            session_id: parsed.session_id,
            plan_slug: parsed.plan_slug,
            limit: parsed.limit
          },
          storageOpts
        );
      }
    },
    {
      name: "set_stage",
      description:
        "Move a plan to a new pipeline stage. Validates the transition against the v2 state " +
        "machine (claude-plans/src/state-machine.ts) and rejects illegal moves with " +
        "IllegalTransitionError. On success, atomically writes the new stage + appends a " +
        "StageTransition to stage_history + issues a one-time DispatchToken bound to the new " +
        "stage with a 5-minute TTL.\n\n" +
        "The returned token is the only way to call dispatch_stage in live mode. Each call to " +
        "set_stage rotates the token — the previous outstanding token is overwritten and becomes " +
        "effectively stale.\n\n" +
        "Conflict rule (docs/v2-design.md §4): dashboard-sourced writes always accept; " +
        "code-sourced writes are rejected with ConflictRejectedError if the last recorded " +
        "transition was dashboard-sourced and falls within the 30-second grace window " +
        "(DOVE_CLAUDE_PLANS_DASHBOARD_GRACE_MS to tune).\n\n" +
        "Inputs:\n" +
        "  plan_slug (required) — the plan to move.\n" +
        "  to (required) — target stage. One of: research, pre-stage-improve, planning,\n" +
        "    post-plan-improve, test-first, code, per-step-review, architectural-review,\n" +
        "    test-reality, documentation.\n" +
        "  by (optional) — who initiated the move. Defaults to CLAUDE_CODE_SESSION_ID.\n" +
        "  source (optional) — 'code' (default) or 'dashboard'. The conflict rule keys off this.\n\n" +
        "Output: { plan_slug, stage, token: DispatchToken, history_length }.",
      shape: setStageSchema.shape,
      handler: async function (args: any) {
        var parsed = setStageSchema.parse(args);
        return setStage(
          {
            plan_slug: parsed.plan_slug,
            to: parsed.to,
            by: parsed.by,
            source: parsed.source
          },
          storageOpts
        );
      }
    },
    {
      name: "pull_plan",
      description:
        "Single-read snapshot of a plan and all its v2 surface: artifacts, prompts, questions, " +
        "current stage, full stage_history, and dispatch_log. The dashboard's plan-detail page " +
        "uses this so it can render without making three round-trips.\n\n" +
        "Returns 404-equivalent (PlanNotFoundError) when the slug does not exist.\n\n" +
        "Inputs:\n" +
        "  plan_slug (required) — the plan to read.\n\n" +
        "Output: { plan, artifacts[], prompts[], questions[], stage, stage_history[], dispatch_log[] }.",
      shape: pullPlanSchema.shape,
      handler: async function (args: any) {
        var parsed = pullPlanSchema.parse(args);
        var result = loadPlanFull(parsed.plan_slug, storageOpts);
        if (!result) throw new Error("plan not found: " + parsed.plan_slug);
        return result;
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
