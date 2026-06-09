/**
 * Tool registration glue for the MCP server. Mirrors the descriptor + handler
 * pattern from @tenonhq/dovetail-mcp's registry.ts. Handlers stay thin —
 * validation lives in zod schemas, persistence in storage.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  READ_ONLY,
  WRITE_ADDITIVE_IDEMPOTENT,
  WRITE_CREATE,
  WRITE_OVERWRITE,
  WRITE_EXECUTE,
  registerKitTools
} from "@tenonhq/dovetail-mcp-kit";
import type { ToolAnnotations } from "@tenonhq/dovetail-mcp-kit";

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
  pullPlanSchema,
  dispatchStageSchema,
  listPlanVersionsSchema,
  getPlanVersionSchema,
  restorePlanVersionSchema,
  createPromptDraftSchema,
  getPromptDraftSchema,
  updatePromptDraftSchema
} from "./schemas";
import {
  pushPlan,
  updatePlanStatus,
  getPlan,
  listPlans,
  listArtifacts,
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
  dispatchStage,
  listVersions,
  getVersion,
  restoreVersion,
  createPromptDraft,
  getPromptDraft,
  listPromptDraftsWithActive,
  updatePromptDraft,
  getActivePromptDraft,
  StorageOptions
} from "./storage";
import { scorePlanFeatures } from "./score";

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
  "pull_plan",
  "dispatch_stage",
  "list_plan_versions",
  "get_plan_version",
  "restore_plan_version",
  "list_prompt_drafts",
  "get_active_prompt_draft",
  "get_prompt_draft",
  "create_prompt_draft",
  "update_prompt_draft"
] as const;

export type ToolName = typeof TOOL_NAMES[number];

export interface RegistryDeps {
  storage?: StorageOptions;
}

interface ToolDescriptor {
  name: ToolName;
  description: string;
  shape: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: any) => Promise<any>;
}

// Annotation presets (READ_ONLY / WRITE_ADDITIVE_IDEMPOTENT / WRITE_CREATE /
// WRITE_OVERWRITE / WRITE_EXECUTE) come from @tenonhq/dovetail-mcp-kit.
// openWorldHint is left at its spec default — these tools operate on local plan storage;
// dispatch_stage is the lone tool that can reach outside it (spawns a subprocess in live mode).

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
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
      description:
        "Create or update a plan shown in the Dovetail dashboard at /claude-plans. " +
        "Auto-slugs from title when slug is omitted. Status defaults to DRAFT.\n\n" +
        "Returns a feature_score {score:0..1, missing:[], hint} rating how fully this " +
        "push uses the display surface (structured content, diagrams, linked PR, etc.). " +
        "Act on a low score by attaching what's missing — push_diagram / push_artifact / " +
        "content_structured — before presenting the plan.\n\n" +
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
        // Feature-usage score (0..1) returned to the caller as a nudge to use
        // the full surface — diagrams, structured content, linked PR, etc.
        // Advisory only; reflects what's attached at push time.
        var feature_score = scorePlanFeatures({
          plan: plan,
          artifacts: listArtifacts(plan.slug, storageOpts)
        });
        return Object.assign({}, plan, {
          url: planDashboardUrl(plan.slug),
          feature_score: feature_score
        });
      }
    },
    {
      name: "update_plan_status",
      annotations: WRITE_CREATE,
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
      annotations: READ_ONLY,
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
      annotations: READ_ONLY,
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
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
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
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
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
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
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
      annotations: WRITE_OVERWRITE,
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
      annotations: READ_ONLY,
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
      annotations: WRITE_CREATE,
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
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
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
      annotations: READ_ONLY,
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
      annotations: WRITE_CREATE,
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
      annotations: READ_ONLY,
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
      annotations: WRITE_CREATE,
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
      annotations: READ_ONLY,
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
    },
    {
      name: "dispatch_stage",
      annotations: WRITE_EXECUTE,
      description:
        "Resolve (and optionally spawn) a Claude Code subprocess to drive a plan at the given " +
        "pipeline stage. THIS IS THE RISKIEST V2 TOOL — read docs/v2-design.md §7 before relying " +
        "on it in automation.\n\n" +
        "MODES:\n" +
        "  Dry-run (default): resolves the spawn command + working dir, appends a 'dry-run' " +
        "DispatchEvent to the plan's dispatch_log, and returns. NO process is launched.\n" +
        "  Live (confirm:true + token): consumes the plan's outstanding dispatch_token atomically " +
        "before spawning the subprocess. The token must (a) equal plan.dispatch_token.token, " +
        "(b) be unconsumed, (c) be within its 5-minute TTL, and (d) match target_stage. Failing " +
        "any check raises NoTokenError / StaleTokenError.\n\n" +
        "AGENT GATE: target_stage 'test-first' and 'test-reality' raise MissingAgentError until " +
        "PR #160 ships the test-author + test-reality-checker agents. Never silent no-op.\n\n" +
        "Inputs:\n" +
        "  plan_slug (required) — the plan whose stage you want to drive.\n" +
        "  target_stage (required) — one of the 10 PipelineStage values.\n" +
        "  confirm (optional, default false) — when true, attempt a live spawn; otherwise dry-run.\n" +
        "  token (required when confirm===true) — the token from the most recent set_stage call.\n" +
        "  by (optional) — caller label for the dispatch_log entry. Defaults to CLAUDE_CODE_SESSION_ID.\n\n" +
        "Output: { mode, plan_slug, target_stage, command, cwd, pid?, event }.",
      shape: dispatchStageSchema.shape,
      handler: async function (args: any) {
        var parsed = dispatchStageSchema.parse(args);
        return dispatchStage(
          {
            plan_slug: parsed.plan_slug,
            target_stage: parsed.target_stage,
            confirm: parsed.confirm,
            token: parsed.token,
            by: parsed.by
          },
          storageOpts
        );
      }
    },
    {
      name: "list_plan_versions",
      annotations: READ_ONLY,
      description:
        "List a plan's saved version snapshots, newest-first. A snapshot is auto-saved " +
        "whenever a push changes the plan's content, so an inferior overwrite can be " +
        "recovered. Returns { slug, versions: [{version, saved_at, title, status}] }.",
      shape: listPlanVersionsSchema.shape,
      handler: async function (args: any) {
        var parsed = listPlanVersionsSchema.parse(args);
        return { slug: parsed.slug, versions: listVersions(parsed.slug, storageOpts) };
      }
    },
    {
      name: "get_plan_version",
      annotations: READ_ONLY,
      description:
        "Read a single saved version of a plan (full snapshot). Returns the PlanVersion " +
        "{ version, saved_at, plan }. Use list_plan_versions to discover version numbers.",
      shape: getPlanVersionSchema.shape,
      handler: async function (args: any) {
        var parsed = getPlanVersionSchema.parse(args);
        var v = getVersion(parsed.slug, parsed.version, storageOpts);
        if (!v) throw new Error("version not found: " + parsed.slug + " v" + parsed.version);
        return v;
      }
    },
    {
      name: "restore_plan_version",
      annotations: WRITE_ADDITIVE_IDEMPOTENT,
      description:
        "Restore a prior version: re-push its content as the new current record. " +
        "Non-destructive — the pre-restore current is itself snapshotted first, so nothing " +
        "is lost. Use to recover after a session pushed an inferior plan. Returns the new " +
        "current plan with its dashboard url.",
      shape: restorePlanVersionSchema.shape,
      handler: async function (args: any) {
        var parsed = restorePlanVersionSchema.parse(args);
        var plan = restoreVersion(parsed.slug, parsed.version, storageOpts);
        return Object.assign({}, plan, { url: planDashboardUrl(plan.slug) });
      }
    },
    {
      name: "list_prompt_drafts",
      annotations: READ_ONLY,
      description:
        "List the prompt drafts open in the dashboard's Prompt Editor (one per tab), oldest " +
        "first, plus which one is active. Output: { drafts: PromptDraft[], active_id: string|null }. " +
        "Each draft has { id, title, content, created_at, updated_at }. Use this to see what the " +
        "user is drafting before enhancing.",
      shape: {},
      handler: async function () {
        return listPromptDraftsWithActive(storageOpts);
      }
    },
    {
      name: "get_active_prompt_draft",
      annotations: READ_ONLY,
      description:
        "Get the prompt draft the user is currently working in (the active tab in the dashboard " +
        "Prompt Editor). This is the canonical 'the prompt I'm working on' read — call it when the " +
        "user asks you to enhance/improve the prompt they're editing. Returns the PromptDraft, or " +
        "{ draft: null } when no draft is active. After enhancing, write the result back with " +
        "update_prompt_draft using the returned id; the editor updates live.",
      shape: {},
      handler: async function () {
        var draft = getActivePromptDraft(storageOpts);
        return draft ? draft : { draft: null };
      }
    },
    {
      name: "get_prompt_draft",
      annotations: READ_ONLY,
      description:
        "Get one prompt draft by id (pd_<8-hex>). Output: the PromptDraft, or { draft: null } if " +
        "not found. Prefer get_active_prompt_draft unless you already hold a specific id.",
      shape: getPromptDraftSchema.shape,
      handler: async function (args: any) {
        var parsed = getPromptDraftSchema.parse(args);
        var draft = getPromptDraft(parsed.id, storageOpts);
        return draft ? draft : { draft: null };
      }
    },
    {
      name: "create_prompt_draft",
      annotations: WRITE_CREATE,
      description:
        "Create a new prompt draft (a new tab in the dashboard Prompt Editor). All inputs optional: " +
        "title (defaults to 'Untitled prompt'), content (the prompt body — may contain HTML/XML " +
        "prompt-template markup), session_id. The first draft on a fresh store becomes active " +
        "automatically. Returns the created PromptDraft. The new tab appears live in the editor.",
      shape: createPromptDraftSchema.shape,
      handler: async function (args: any) {
        var parsed = createPromptDraftSchema.parse(args || {});
        return createPromptDraft(
          {
            title: parsed.title,
            content: parsed.content,
            session_id: parsed.session_id === undefined ? sessionIdFromEnv() : parsed.session_id
          },
          storageOpts
        );
      }
    },
    {
      name: "update_prompt_draft",
      annotations: WRITE_OVERWRITE,
      description:
        "Overwrite a prompt draft's title and/or content by id (pd_<8-hex>). This is how you write an " +
        "ENHANCED prompt back into the tab the user is editing: read with get_active_prompt_draft, " +
        "improve the prompt, then update_prompt_draft with the same id and the rewritten content. " +
        "At least one of title/content is required. The editor reflects the change live via SSE. " +
        "Returns the updated PromptDraft.",
      shape: updatePromptDraftSchema.shape,
      handler: async function (args: any) {
        var parsed = updatePromptDraftSchema.parse(args);
        if (parsed.title === undefined && parsed.content === undefined) {
          throw new Error("update_prompt_draft requires at least one of title or content");
        }
        return updatePromptDraft(
          { id: parsed.id, title: parsed.title, content: parsed.content },
          storageOpts
        );
      }
    }
  ];
}

export function registerAllTools(server: McpServer, deps: RegistryDeps = {}): void {
  // registerKitTools owns serialization + the { error, retryable, tool } contract.
  // No telemetry recorder is injected here (telemetry parity is a P2 follow-on).
  registerKitTools(server, buildDescriptors(deps));
}
