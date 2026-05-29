/**
 * Atomic JSON file store for plans and artifacts.
 *
 * Layout under storageRoot() (~/.dovetail/claude-plans/ by default):
 *   <plan-slug>.json                                 -- plan record
 *   <plan-slug>/artifacts/<artifact-slug>.json       -- artifact records
 *
 * Atomic writes (tmp + rename) guarantee that the dashboard's chokidar watcher
 * never observes a torn file. The store creates directories lazily so the very
 * first push works on a fresh machine.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

import {
  ALLOWED_TRANSITIONS,
  ArtifactKind,
  ClaudeArtifact,
  ClaudePlan,
  ClaudePrompt,
  CURRENT_SCHEMA_VERSION,
  DispatchEvent,
  DispatchToken,
  LinkedArtifact,
  PipelineStage,
  PlanQuestion,
  PlanStatus,
  PlanVersion,
  PlanVersionMeta,
  PlanWithArtifacts,
  PromptCyclePayload,
  PromptLintEvent,
  StageTransition,
  StageTransitionSource
} from "./types";
import { assertTransition, checkConflict } from "./state-machine";
import {
  SpawnFn,
  productionSpawn,
  resolveDispatchCommand,
  assertAgentAvailable,
  validateToken,
  makeEvent,
  NoTokenError,
  StaleTokenError
} from "./dispatch";
import { StructuredPlan, renderStructured } from "./renderer";
import { promptCyclePayloadSchema } from "./schemas";
import { extractCategories } from "./categories";

export interface StorageOptions {
  rootDir?: string;
}

export function storageRoot(options: StorageOptions = {}): string {
  if (options.rootDir) return options.rootDir;
  var override = process.env.DOVE_CLAUDE_PLANS_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".dovetail", "claude-plans");
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "untitled";
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  var tmp = filePath + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  var raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

/**
 * Normalize a freshly-read plan record to the current schema in memory.
 * Idempotent — running it on an already-v2 record is a no-op. Does NOT
 * write to disk; the upgrade materializes when the next pushPlan /
 * updatePlanStatus / pushQuestion / recordAnswer touches the record.
 *
 * Phases C and D extend this helper to default new fields (stage,
 * stage_history, dispatch_token, dispatch_log) so consumers can always
 * count on their presence at read time.
 */
export function migrateV1OnLoad(plan: ClaudePlan): ClaudePlan {
  if (plan.schema_version === CURRENT_SCHEMA_VERSION) return plan;
  return Object.assign({}, plan, { schema_version: CURRENT_SCHEMA_VERSION });
}

function readPlan(filePath: string): ClaudePlan | null {
  var plan = readJson<ClaudePlan>(filePath);
  return plan ? migrateV1OnLoad(plan) : null;
}

function planPath(root: string, slug: string): string {
  return path.join(root, slug + ".json");
}

function artifactDir(root: string, planSlug: string): string {
  return path.join(root, planSlug, "artifacts");
}

function artifactPath(root: string, planSlug: string, slug: string): string {
  return path.join(artifactDir(root, planSlug), slug + ".json");
}

function promptDir(root: string, planSlug: string): string {
  return path.join(root, planSlug, "prompts");
}

function promptPath(root: string, planSlug: string, slug: string): string {
  return path.join(promptDir(root, planSlug), slug + ".json");
}

// Plan version snapshots live under <root>/<plan-slug>/versions/<n>.json.
// Capped at the most-recent MAX_PLAN_VERSIONS to bound disk growth.
export var MAX_PLAN_VERSIONS = 20;

function versionDir(root: string, planSlug: string): string {
  // Sanitize the slug before it reaches a filesystem path. slugify() strips
  // every non-[a-z0-9] character (including "/" and "."), so a hostile slug
  // from the MCP boundary (schemas only bound length, not charset) can't
  // traverse out of the storage root. Idempotent on already-valid slugs.
  return path.join(root, slugify(planSlug), "versions");
}

function versionPath(root: string, planSlug: string, version: number): string {
  return path.join(versionDir(root, planSlug), version + ".json");
}

function versionNumbers(root: string, planSlug: string): number[] {
  var dir = versionDir(root, planSlug);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(function (n) { return /^\d+\.json$/.test(n); })
    .map(function (n) { return parseInt(n, 10); })
    .sort(function (a, b) { return a - b; });
}

// Snapshot `plan` as the next version under its slug, then prune the oldest
// snapshots beyond MAX_PLAN_VERSIONS. Called by pushPlan before it overwrites
// an existing record whose content changed.
function snapshotVersion(root: string, plan: ClaudePlan, savedAt: string): void {
  var nums = versionNumbers(root, plan.slug);
  var next = (nums.length ? nums[nums.length - 1] : 0) + 1;
  var snapshot: PlanVersion = { version: next, saved_at: savedAt, plan: plan };
  atomicWriteJson(versionPath(root, plan.slug, next), snapshot);

  var all = versionNumbers(root, plan.slug);
  var excess = all.length - MAX_PLAN_VERSIONS;
  for (var i = 0; i < excess; i++) {
    try { fs.unlinkSync(versionPath(root, plan.slug, all[i])); } catch (_e) { /* best effort */ }
  }
}

// Lint events are global (not nested under a plan). The leading underscore keeps
// the directory out of listPlans(), which only reads top-level "*.json" files.
function lintEventsDir(root: string): string {
  return path.join(root, "_lint-events");
}

function lintEventPath(root: string, id: string): string {
  return path.join(lintEventsDir(root), id + ".json");
}

export interface PushPlanInput {
  slug?: string;
  title: string;
  content_md?: string;
  content_html?: string;
  content_structured?: StructuredPlan;
  status?: PlanStatus;
  session_id?: string | null;
  pr_number?: number;
  pr_url?: string;
  pr_title?: string;
  linked_artifacts?: LinkedArtifact[];
  /**
   * Optional caller-provided category overrides. When supplied, replaces any
   * auto-extracted categories. When omitted, categories are derived from
   * title + content via extractCategories() so the dashboard topic cloud
   * updates on every push without a manual rebuild.
   */
  categories?: string[];
}

export function pushPlan(input: PushPlanInput, options: StorageOptions = {}): ClaudePlan {
  var root = storageRoot(options);
  var slug = slugify(input.slug || input.title);
  var existing = readPlan(planPath(root, slug));
  var now = nowIso();
  var contentMd = input.content_md !== undefined ? input.content_md : "";
  var resolvedHtml = input.content_html;
  if (!resolvedHtml && input.content_structured) {
    resolvedHtml = renderStructured(input.content_structured);
  }
  var hashSource = resolvedHtml !== undefined ? resolvedHtml : contentMd;

  var resolvedLinks: LinkedArtifact[] | undefined;
  if (input.linked_artifacts !== undefined) {
    resolvedLinks = input.linked_artifacts;
  } else if (existing && existing.linked_artifacts) {
    resolvedLinks = existing.linked_artifacts;
  }

  var resolvedCategories: string[];
  if (input.categories !== undefined) {
    resolvedCategories = input.categories;
  } else {
    resolvedCategories = extractCategories({
      title: input.title,
      content_md: contentMd,
      content_html: resolvedHtml
    });
  }

  var plan: ClaudePlan = {
    slug: slug,
    title: input.title,
    status: input.status || (existing ? existing.status : "DRAFT"),
    content_md: contentMd,
    content_html: resolvedHtml,
    content_hash: sha256(hashSource),
    created_at: existing ? existing.created_at : now,
    updated_at: now,
    session_id: input.session_id === undefined ? (existing ? existing.session_id : null) : input.session_id,
    pr_number: input.pr_number !== undefined ? input.pr_number : (existing ? existing.pr_number : undefined),
    pr_url: input.pr_url !== undefined ? input.pr_url : (existing ? existing.pr_url : undefined),
    pr_title: input.pr_title !== undefined ? input.pr_title : (existing ? existing.pr_title : undefined),
    linked_artifacts: resolvedLinks,
    categories: resolvedCategories,
    schema_version: CURRENT_SCHEMA_VERSION
  };
  if (existing && existing.questions) plan.questions = existing.questions;
  // Preserve v2 stage state across plan-content updates — pushPlan is a
  // content-write surface, not a stage-write surface; only setStage may
  // mutate stage / stage_history / dispatch_token.
  if (existing && existing.stage !== undefined) plan.stage = existing.stage;
  if (existing && existing.stage_history) plan.stage_history = existing.stage_history;
  if (existing && existing.dispatch_token !== undefined) plan.dispatch_token = existing.dispatch_token;
  if (existing && existing.dispatch_log) plan.dispatch_log = existing.dispatch_log;

  // Version history: snapshot the prior record whenever content actually
  // changed, so an inferior overwrite can be recovered from the dashboard.
  // Identical re-pushes (same content_hash) don't create a snapshot.
  if (existing && existing.content_hash !== plan.content_hash) {
    snapshotVersion(root, existing, now);
  }

  atomicWriteJson(planPath(root, slug), plan);

  var focusPath = path.join(root, ".focus");
  var focusTmp = focusPath + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(focusTmp, JSON.stringify({ slug: plan.slug, ts: plan.updated_at }));
  fs.renameSync(focusTmp, focusPath);

  return plan;
}

export function updatePlanStatus(slug: string, to: PlanStatus, options: StorageOptions = {}): ClaudePlan {
  var root = storageRoot(options);
  var existing = readPlan(planPath(root, slug));
  if (!existing) throw new Error("plan not found: " + slug);

  var allowed = ALLOWED_TRANSITIONS[existing.status];
  if (allowed.indexOf(to) === -1) {
    throw new Error("invalid transition: " + existing.status + " -> " + to);
  }

  var next: ClaudePlan = Object.assign({}, existing, {
    status: to,
    updated_at: nowIso(),
    schema_version: CURRENT_SCHEMA_VERSION
  });
  atomicWriteJson(planPath(root, slug), next);
  return next;
}

export function getPlan(slug: string, options: StorageOptions = {}): PlanWithArtifacts | null {
  var root = storageRoot(options);
  var plan = readPlan(planPath(root, slug));
  if (!plan) return null;
  return {
    plan: plan,
    artifacts: listArtifacts(slug, options),
    prompts: listPrompts(slug, options)
  };
}

export interface ListOptions extends StorageOptions {
  status?: PlanStatus;
  limit?: number;
}

export function listPlans(options: ListOptions = {}): ClaudePlan[] {
  var root = storageRoot(options);
  if (!fs.existsSync(root)) return [];
  var entries = fs.readdirSync(root);
  var plans: ClaudePlan[] = [];
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i];
    if (!name.endsWith(".json")) continue;
    var plan = readPlan(path.join(root, name));
    if (!plan) continue;
    if (options.status && plan.status !== options.status) continue;
    plans.push(plan);
  }
  plans.sort(function (a, b) {
    return b.updated_at.localeCompare(a.updated_at);
  });
  if (typeof options.limit === "number") plans = plans.slice(0, options.limit);
  return plans;
}

export function listArtifacts(planSlug: string, options: StorageOptions = {}): ClaudeArtifact[] {
  var root = storageRoot(options);
  var dir = artifactDir(root, planSlug);
  if (!fs.existsSync(dir)) return [];
  var entries = fs.readdirSync(dir);
  var artifacts: ClaudeArtifact[] = [];
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].endsWith(".json")) continue;
    var a = readJson<ClaudeArtifact>(path.join(dir, entries[i]));
    if (a) artifacts.push(a);
  }
  artifacts.sort(function (a, b) {
    return a.created_at.localeCompare(b.created_at);
  });
  return artifacts;
}

export function listPrompts(planSlug: string, options: StorageOptions = {}): ClaudePrompt[] {
  var root = storageRoot(options);
  var dir = promptDir(root, planSlug);
  if (!fs.existsSync(dir)) return [];
  var entries = fs.readdirSync(dir);
  var prompts: ClaudePrompt[] = [];
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].endsWith(".json")) continue;
    var p = readJson<ClaudePrompt>(path.join(dir, entries[i]));
    if (p) prompts.push(p);
  }
  prompts.sort(function (a, b) {
    return a.created_at.localeCompare(b.created_at);
  });
  return prompts;
}

// List a plan's saved versions, newest-first, as lightweight metadata rows.
export function listVersions(planSlug: string, options: StorageOptions = {}): PlanVersionMeta[] {
  var root = storageRoot(options);
  var nums = versionNumbers(root, planSlug);
  var metas: PlanVersionMeta[] = [];
  for (var i = 0; i < nums.length; i++) {
    var v = readJson<PlanVersion>(versionPath(root, planSlug, nums[i]));
    if (!v) continue;
    metas.push({
      version: v.version,
      saved_at: v.saved_at,
      title: v.plan.title,
      status: v.plan.status
    });
  }
  metas.sort(function (a, b) { return b.version - a.version; });
  return metas;
}

// Read a single saved version (full plan snapshot), or null if absent.
export function getVersion(
  planSlug: string,
  version: number,
  options: StorageOptions = {}
): PlanVersion | null {
  var root = storageRoot(options);
  return readJson<PlanVersion>(versionPath(root, planSlug, version));
}

// Restore a prior version: re-push its content as the new current record.
// Non-destructive — pushPlan snapshots the pre-restore current first, so the
// version you restored *from* also remains in history. Returns new current.
export function restoreVersion(
  planSlug: string,
  version: number,
  options: StorageOptions = {}
): ClaudePlan {
  var snapshot = getVersion(planSlug, version, options);
  if (!snapshot) throw new Error("version not found: " + planSlug + " v" + version);
  var p = snapshot.plan;
  return pushPlan(
    {
      slug: p.slug,
      title: p.title,
      content_md: p.content_md,
      content_html: p.content_html,
      status: p.status,
      session_id: p.session_id,
      pr_number: p.pr_number,
      pr_url: p.pr_url,
      pr_title: p.pr_title,
      linked_artifacts: p.linked_artifacts,
      categories: p.categories
    },
    options
  );
}

export interface PushArtifactInput {
  plan_slug: string;
  slug?: string;
  kind: ArtifactKind;
  title: string;
  content: string;
}

export function pushArtifact(input: PushArtifactInput, options: StorageOptions = {}): ClaudeArtifact {
  var root = storageRoot(options);
  var planExists = fs.existsSync(planPath(root, input.plan_slug));
  if (!planExists) throw new Error("plan not found: " + input.plan_slug);

  if (input.kind === "prompt-cycle") validatePromptCycleContent(input.content);

  var slug = slugify(input.slug || input.title);
  var existing = readJson<ClaudeArtifact>(artifactPath(root, input.plan_slug, slug));
  var now = nowIso();
  var artifact: ClaudeArtifact = {
    slug: slug,
    plan_slug: input.plan_slug,
    kind: input.kind,
    title: input.title,
    content: input.content,
    created_at: existing ? existing.created_at : now,
    updated_at: now
  };
  atomicWriteJson(artifactPath(root, input.plan_slug, slug), artifact);
  return artifact;
}

export interface PushPromptInput {
  plan_slug: string;
  slug?: string;
  title: string;
  content: string;
  source_draft?: string;
  score_before?: number;
  score_after?: number;
}

export function pushPrompt(input: PushPromptInput, options: StorageOptions = {}): ClaudePrompt {
  var root = storageRoot(options);
  var planExists = fs.existsSync(planPath(root, input.plan_slug));
  if (!planExists) throw new Error("plan not found: " + input.plan_slug);

  var slug = slugify(input.slug || input.title);
  var existing = readJson<ClaudePrompt>(promptPath(root, input.plan_slug, slug));
  var now = nowIso();
  var prompt: ClaudePrompt = {
    slug: slug,
    plan_slug: input.plan_slug,
    title: input.title,
    content: input.content,
    source_draft: input.source_draft,
    score_before: input.score_before,
    score_after: input.score_after,
    created_at: existing ? existing.created_at : now,
    updated_at: now
  };
  atomicWriteJson(promptPath(root, input.plan_slug, slug), prompt);
  return prompt;
}

export function parsePromptCycleContent(content: string): PromptCyclePayload {
  var raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    var msg = err instanceof Error ? err.message : String(err);
    throw new Error("prompt-cycle content is not valid JSON: " + msg);
  }
  var parsed = promptCyclePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("prompt-cycle payload failed validation: " + parsed.error.message);
  }
  return parsed.data as PromptCyclePayload;
}

function validatePromptCycleContent(content: string): void {
  parsePromptCycleContent(content);
}

export function deletePlan(slug: string, options: StorageOptions = {}): boolean {
  var root = storageRoot(options);
  var file = planPath(root, slug);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  var dir = path.join(root, slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface HandoffBundleOptions extends StorageOptions {
  follow_links?: boolean;
  include_artifact_kinds?: ArtifactKind[];
}

export interface HandoffBundleResult {
  slug: string;
  markdown: string;
  ready_to_paste_prompt: string | null;
}

export function buildHandoffBundle(slug: string, opts: HandoffBundleOptions = {}): HandoffBundleResult {
  var record = getPlan(slug, { rootDir: opts.rootDir });
  if (!record) throw new Error("plan not found: " + slug);

  var include = opts.include_artifact_kinds;
  var followLinks = opts.follow_links === true;

  var hoist: string | null = null;
  var parts: string[] = [];

  parts.push("# Handoff: " + record.plan.title);
  parts.push("");
  var headerBits: string[] = [];
  headerBits.push("**Slug:** `" + record.plan.slug + "`");
  headerBits.push("**Status:** " + record.plan.status);
  headerBits.push("**Updated:** " + record.plan.updated_at);
  headerBits.push("**PR:** " + (record.plan.pr_url || "—"));
  headerBits.push("**Prior session:** " + (record.plan.session_id || "—"));
  parts.push("> " + headerBits.join(" · "));
  parts.push("");

  parts.push("## Plan content");
  parts.push("");
  parts.push(record.plan.content_md && record.plan.content_md.length > 0
    ? record.plan.content_md
    : "_(no markdown content — see dashboard for structured layout)_");
  parts.push("");

  var links = record.plan.linked_artifacts || [];
  if (links.length > 0) {
    parts.push("## Linked plans");
    parts.push("");
    for (var li = 0; li < links.length; li++) {
      var link = links[li];
      var line = "- **" + link.relation + " →** `" + link.plan_slug + "`";
      if (link.artifact_slug) line += " (artifact: `" + link.artifact_slug + "`)";
      if (link.note) line += " — " + link.note;
      parts.push(line);
    }
    parts.push("");
  }

  var renderedArtifacts = renderArtifactsSection(record.artifacts, include);
  if (renderedArtifacts.body.length > 0) {
    parts.push("## Artifacts");
    parts.push("");
    parts.push(renderedArtifacts.body);
    parts.push("");
  }
  if (renderedArtifacts.hoist) hoist = renderedArtifacts.hoist;

  var renderedPrompts = renderPromptsSection(record.prompts);
  if (renderedPrompts.body.length > 0) {
    parts.push("## Prompts");
    parts.push("");
    parts.push(renderedPrompts.body);
    parts.push("");
  }
  if (!hoist && renderedPrompts.hoist) hoist = renderedPrompts.hoist;

  if (followLinks && links.length > 0) {
    var followable = links.filter(function (l) {
      return l.relation === "built-from" || l.relation === "improves";
    });
    for (var fi = 0; fi < followable.length; fi++) {
      var linkedSlug = followable[fi].plan_slug;
      var linked = getPlan(linkedSlug, { rootDir: opts.rootDir });
      if (!linked) {
        parts.push("## Linked plan (missing): " + linkedSlug);
        parts.push("");
        continue;
      }
      parts.push("---");
      parts.push("");
      parts.push("## Linked plan: " + linked.plan.title + " (`" + linked.plan.slug + "`)");
      parts.push("");
      parts.push("> Relation: **" + followable[fi].relation + "**" + (followable[fi].note ? " — " + followable[fi].note : ""));
      parts.push("");
      if (linked.plan.content_md && linked.plan.content_md.length > 0) {
        parts.push(linked.plan.content_md);
        parts.push("");
      }
      var nested = renderArtifactsSection(linked.artifacts, include);
      if (nested.body.length > 0) {
        parts.push("### Linked plan artifacts");
        parts.push("");
        parts.push(nested.body);
        parts.push("");
      }
      if (!hoist && nested.hoist) hoist = nested.hoist;

      var nestedPrompts = renderPromptsSection(linked.prompts);
      if (nestedPrompts.body.length > 0) {
        parts.push("### Linked plan prompts");
        parts.push("");
        parts.push(nestedPrompts.body);
        parts.push("");
      }
      if (!hoist && nestedPrompts.hoist) hoist = nestedPrompts.hoist;
    }
  }

  if (hoist) {
    parts.push("---");
    parts.push("");
    parts.push("# 🎯 READY-TO-PASTE PROMPT");
    parts.push("");
    parts.push("Copy the block below into a fresh session:");
    parts.push("");
    parts.push("```xml");
    parts.push(hoist);
    parts.push("```");
    parts.push("");
  }

  return {
    slug: record.plan.slug,
    markdown: parts.join("\n"),
    ready_to_paste_prompt: hoist
  };
}

interface ArtifactSection {
  body: string;
  hoist: string | null;
}

function renderArtifactsSection(artifacts: ClaudeArtifact[], include?: ArtifactKind[]): ArtifactSection {
  var lines: string[] = [];
  var hoist: string | null = null;
  for (var i = 0; i < artifacts.length; i++) {
    var a = artifacts[i];
    if (include && include.indexOf(a.kind) === -1) continue;
    lines.push("### " + a.title + " _(" + a.kind + ")_");
    lines.push("");
    if (a.kind === "mermaid") {
      lines.push("```mermaid");
      lines.push(a.content);
      lines.push("```");
    } else if (a.kind === "prompt-cycle") {
      var pc = safeParsePromptCycle(a.content);
      if (pc) {
        lines.push("**Lint:** " + pc.lint_before.score + " → " + pc.lint_after.score + "%");
        lines.push("");
        if (pc.source_plan_slug) {
          lines.push("**Source plan:** `" + pc.source_plan_slug + "`");
          lines.push("");
        }
        lines.push("<details><summary>Original draft</summary>");
        lines.push("");
        lines.push("```");
        lines.push(pc.original_draft);
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
        if (pc.open_questions.length > 0) {
          lines.push("<details><summary>Open questions (" + pc.open_questions.length + ")</summary>");
          lines.push("");
          for (var qi = 0; qi < pc.open_questions.length; qi++) {
            var q = pc.open_questions[qi];
            lines.push("- **Q:** " + q.question);
            lines.push("  - **A:** " + q.answer);
          }
          lines.push("");
          lines.push("</details>");
          lines.push("");
        }
        lines.push("**Rewritten prompt:**");
        lines.push("");
        lines.push("```xml");
        lines.push(pc.rewritten_prompt);
        lines.push("```");
        if (!hoist) hoist = pc.rewritten_prompt;
      } else {
        lines.push("```json");
        lines.push(a.content);
        lines.push("```");
      }
    } else {
      lines.push(a.content);
    }
    lines.push("");
  }
  return { body: lines.join("\n").replace(/\n+$/, ""), hoist: hoist };
}

function safeParsePromptCycle(content: string): PromptCyclePayload | null {
  try {
    return parsePromptCycleContent(content);
  } catch (e) {
    return null;
  }
}

// Render the Prompts section for the handoff bundle. The newest prompt by
// created_at becomes the hoist candidate; the caller decides whether a
// prompt-cycle artifact already supplied one.
function renderPromptsSection(prompts: ClaudePrompt[]): ArtifactSection {
  var lines: string[] = [];
  var hoist: string | null = null;
  var newest: ClaudePrompt | null = null;
  for (var i = 0; i < prompts.length; i++) {
    var p = prompts[i];
    lines.push("### " + p.title + " _(prompt)_");
    lines.push("");
    if (typeof p.score_before === "number" && typeof p.score_after === "number") {
      lines.push("**Lint:** " + p.score_before + " → " + p.score_after + "%");
      lines.push("");
    } else if (typeof p.score_after === "number") {
      lines.push("**Lint:** " + p.score_after + "%");
      lines.push("");
    }
    if (p.source_draft) {
      lines.push("<details><summary>Original draft</summary>");
      lines.push("");
      lines.push("```");
      lines.push(p.source_draft);
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push("**Rewritten prompt:**");
    lines.push("");
    lines.push("```xml");
    lines.push(p.content);
    lines.push("```");
    lines.push("");
    if (!newest || p.created_at.localeCompare(newest.created_at) > 0) {
      newest = p;
    }
  }
  if (newest) hoist = newest.content;
  return { body: lines.join("\n").replace(/\n+$/, ""), hoist: hoist };
}

// ---- v2: Q&A on plan records -----------------------------------------------

export interface PushQuestionInput {
  plan_slug: string;
  question: string;
  header?: string;
  options?: string[];
  stage?: string;
  asked_by?: string;
}

export interface RecordAnswerInput {
  plan_slug: string;
  question_id: string;
  answer: string;
  answered_by?: string;
}

export interface GetAnswersInput {
  plan_slug: string;
  answered?: boolean;
  stage?: string;
}

export interface GetAnswersResult {
  plan_slug: string;
  questions: PlanQuestion[];
}

// Module-private generator. Tests force id collisions via __setIdGenerator.
// Kept un-exported so external callers can't take a stale live-binding reference
// and miss updates from the setter; the setter is the only public hook.
var __idGenerator: () => string = function () {
  return "q_" + crypto.randomBytes(4).toString("hex");
};

export function __setIdGenerator(fn: () => string): () => string {
  var prev = __idGenerator;
  __idGenerator = fn;
  return prev;
}

function generateQuestionId(taken: PlanQuestion[]): string {
  for (var attempt = 0; attempt < 5; attempt++) {
    var candidate = __idGenerator();
    if (!taken.some(function (q) { return q.id === candidate; })) return candidate;
  }
  throw new Error("failed to generate unique question id after 5 attempts");
}

function loadPlan(root: string, slug: string): ClaudePlan {
  var plan = readPlan(planPath(root, slug));
  if (!plan) throw new Error("plan not found: " + slug);
  return plan;
}

// NOTE: load-mutate-write is not concurrency-safe. Two simultaneous pushQuestion
// calls on the same plan can both read the same `existing` array; the second
// atomic rename wins and silently drops the first question. Expected concurrency
// is one Claude session per plan, so this is documented rather than locked.
export function pushQuestion(input: PushQuestionInput, options: StorageOptions = {}): PlanQuestion {
  var root = storageRoot(options);
  var plan = loadPlan(root, input.plan_slug);
  var existing = plan.questions || [];
  var question: PlanQuestion = {
    id: generateQuestionId(existing),
    question: input.question,
    asked_at: nowIso()
  };
  if (input.header !== undefined) question.header = input.header;
  if (input.options !== undefined) question.options = input.options;
  if (input.stage !== undefined) question.stage = input.stage;
  if (input.asked_by !== undefined) question.asked_by = input.asked_by;

  plan.questions = existing.concat([question]);
  plan.updated_at = nowIso();
  plan.schema_version = CURRENT_SCHEMA_VERSION;
  atomicWriteJson(planPath(root, plan.slug), plan);
  return question;
}

export function recordAnswer(input: RecordAnswerInput, options: StorageOptions = {}): PlanQuestion {
  var root = storageRoot(options);
  var plan = loadPlan(root, input.plan_slug);
  var questions = plan.questions || [];
  var idx = -1;
  for (var i = 0; i < questions.length; i++) {
    if (questions[i].id === input.question_id) { idx = i; break; }
  }
  if (idx === -1) {
    throw new Error("question not found: " + input.question_id + " on plan " + input.plan_slug);
  }
  var prev = questions[idx];
  var updated: PlanQuestion = Object.assign({}, prev, {
    answer: input.answer,
    answered_at: nowIso()
  });
  if (input.answered_by !== undefined) updated.answered_by = input.answered_by;
  questions[idx] = updated;
  plan.questions = questions;
  plan.updated_at = nowIso();
  plan.schema_version = CURRENT_SCHEMA_VERSION;
  atomicWriteJson(planPath(root, plan.slug), plan);
  return updated;
}

export function getAnswers(input: GetAnswersInput, options: StorageOptions = {}): GetAnswersResult {
  var root = storageRoot(options);
  var plan = loadPlan(root, input.plan_slug);
  var questions = (plan.questions || []).slice();
  if (input.stage !== undefined) {
    questions = questions.filter(function (q) { return q.stage === input.stage; });
  }
  if (input.answered === true) {
    questions = questions.filter(function (q) { return typeof q.answer === "string"; });
  } else if (input.answered === false) {
    questions = questions.filter(function (q) { return typeof q.answer !== "string"; });
  }
  return { plan_slug: plan.slug, questions: questions };
}

// ---- Prompt lint events (global, plan-independent) -------------------------

export interface PushLintEventInput {
  score: number;
  missing?: string[];
  antipatterns?: string[];
  ceremony?: string[];
  threshold?: number;
  prompt_excerpt?: string;
  source?: string;
  session_id?: string | null;
  plan_slug?: string;
}

export function pushLintEvent(input: PushLintEventInput, options: StorageOptions = {}): PromptLintEvent {
  var root = storageRoot(options);
  var id = "le_" + crypto.randomBytes(4).toString("hex");
  var now = nowIso();
  var event: PromptLintEvent = {
    id: id,
    timestamp: now,
    score: input.score,
    missing: input.missing || [],
    created_at: now,
    updated_at: now
  };
  if (input.threshold !== undefined) event.threshold = input.threshold;
  if (input.antipatterns !== undefined) event.antipatterns = input.antipatterns;
  if (input.ceremony !== undefined) event.ceremony = input.ceremony;
  if (input.prompt_excerpt !== undefined) event.prompt_excerpt = input.prompt_excerpt;
  if (input.source !== undefined) event.source = input.source;
  if (input.session_id !== undefined) event.session_id = input.session_id;
  if (input.plan_slug !== undefined) event.plan_slug = input.plan_slug;
  atomicWriteJson(lintEventPath(root, id), event);
  return event;
}

export interface ListLintEventsInput {
  session_id?: string;
  plan_slug?: string;
  limit?: number;
}

export function listLintEvents(input: ListLintEventsInput = {}, options: StorageOptions = {}): PromptLintEvent[] {
  var root = storageRoot(options);
  var dir = lintEventsDir(root);
  if (!fs.existsSync(dir)) return [];
  var entries = fs.readdirSync(dir);
  var events: PromptLintEvent[] = [];
  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].endsWith(".json")) continue;
    var e = readJson<PromptLintEvent>(path.join(dir, entries[i]));
    if (!e) continue;
    if (input.session_id !== undefined && e.session_id !== input.session_id) continue;
    if (input.plan_slug !== undefined && e.plan_slug !== input.plan_slug) continue;
    events.push(e);
  }
  events.sort(function (a, b) {
    var c = (b.timestamp || "").localeCompare(a.timestamp || ""); // newest first
    if (c !== 0) return c;
    return (b.id || "").localeCompare(a.id || ""); // stable tiebreak on same-ms events
  });
  if (typeof input.limit === "number") events = events.slice(0, input.limit);
  return events;
}

export interface GetLintEventsResult {
  events: PromptLintEvent[];
}

export function getLintEvents(input: ListLintEventsInput = {}, options: StorageOptions = {}): GetLintEventsResult {
  return { events: listLintEvents(input, options) };
}

// ---- v2: stage + dispatch token --------------------------------------------

export interface SetStageInput {
  plan_slug: string;
  to: PipelineStage;
  by?: string;
  source?: StageTransitionSource;
}

export interface SetStageResult {
  plan_slug: string;
  stage: PipelineStage;
  token: DispatchToken;
  history_length: number;
}

function tokenTtlMs(): number {
  var env = process.env.DOVE_CLAUDE_PLANS_TOKEN_TTL_MS;
  if (env) {
    var n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 5 * 60 * 1000;
}

function issueToken(stage: PipelineStage, nowIsoStr: string): DispatchToken {
  var token = "tok_" + crypto.randomBytes(12).toString("hex");
  return {
    token: token,
    issued_for_stage: stage,
    issued_at: nowIsoStr,
    expires_at: new Date(Date.parse(nowIsoStr) + tokenTtlMs()).toISOString()
  };
}

/**
 * Move a plan to a new pipeline stage. Validates the transition against
 * state-machine.ts, applies the conflict-resolution rule, atomically
 * writes the new stage + appends to stage_history, and ISSUES a new
 * one-time dispatch token bound to the target stage (5-minute TTL, see
 * DOVE_CLAUDE_PLANS_TOKEN_TTL_MS).
 *
 * The returned token is the only way to call dispatch_stage in live
 * mode (Phase D). A subsequent setStage rotates it — the previous
 * outstanding token becomes effectively stale.
 */
export function setStage(input: SetStageInput, options: StorageOptions = {}): SetStageResult {
  var root = storageRoot(options);
  var plan = loadPlan(root, input.plan_slug);
  var source: StageTransitionSource = input.source || "code";
  var history = plan.stage_history || [];

  assertTransition(plan.stage || null, input.to);
  checkConflict(history, source);

  var now = nowIso();
  var transition: StageTransition = {
    from: plan.stage || null,
    to: input.to,
    at: now,
    by: input.by || process.env.CLAUDE_CODE_SESSION_ID || "unknown",
    source: source
  };
  var token = issueToken(input.to, now);

  var next: ClaudePlan = Object.assign({}, plan, {
    stage: input.to,
    stage_history: history.concat([transition]),
    dispatch_token: token,
    updated_at: now,
    schema_version: CURRENT_SCHEMA_VERSION
  });
  atomicWriteJson(planPath(root, plan.slug), next);

  return {
    plan_slug: plan.slug,
    stage: input.to,
    token: token,
    history_length: (next.stage_history || []).length
  };
}

export interface PullPlanResult {
  plan: ClaudePlan;
  artifacts: ClaudeArtifact[];
  prompts: ClaudePrompt[];
  questions: PlanQuestion[];
  stage: PipelineStage | null;
  stage_history: StageTransition[];
  dispatch_log: ClaudePlan["dispatch_log"];
}

/**
 * Single-read snapshot of a plan and all its v2 surface: artifacts,
 * prompts, questions, stage state, history, dispatch_log. The dashboard
 * uses this so the plan detail page renders without three round-trips.
 *
 * Returns null when the plan slug does not exist (callers in the
 * registry surface this as PlanNotFoundError).
 */
export function loadPlanFull(slug: string, options: StorageOptions = {}): PullPlanResult | null {
  var root = storageRoot(options);
  var plan = readPlan(planPath(root, slug));
  if (!plan) return null;
  return {
    plan: plan,
    artifacts: listArtifacts(slug, options),
    prompts: listPrompts(slug, options),
    questions: (plan.questions || []).slice(),
    stage: plan.stage || null,
    stage_history: (plan.stage_history || []).slice(),
    dispatch_log: (plan.dispatch_log || []).slice()
  };
}

// ---- v2: dispatch_stage (Phase D) ------------------------------------------

export interface DispatchStageInput {
  plan_slug: string;
  target_stage: PipelineStage;
  confirm?: boolean;
  token?: string;
  by?: string;
}

export interface DispatchStageResult {
  mode: "dry-run" | "live";
  plan_slug: string;
  target_stage: PipelineStage;
  command: string;
  cwd: string;
  pid?: number;
  event: DispatchEvent;
}

export interface DispatchStageOptions extends StorageOptions {
  /** Override the spawn primitive — used in tests. */
  spawn?: SpawnFn;
}

/**
 * Resolve + (optionally) spawn a Claude Code subprocess for a plan
 * stage. See dispatch.ts for the safety model.
 *
 * Default mode is dry-run: appends a "dry-run" DispatchEvent and
 * returns without spawning. Live mode (`confirm: true`) consumes the
 * plan's outstanding dispatch_token atomically BEFORE the spawn — a
 * crashed subprocess does not invalidate the single-use guarantee.
 */
export function dispatchStage(
  input: DispatchStageInput,
  options: DispatchStageOptions = {}
): DispatchStageResult {
  var root = storageRoot(options);
  var plan = loadPlan(root, input.plan_slug);
  var by = input.by || process.env.CLAUDE_CODE_SESSION_ID || "unknown";
  var spawnFn: SpawnFn = options.spawn || productionSpawn;

  // Always do the missing-agent check before any I/O state change.
  // Surfaces the gap immediately, never silently spawns.
  assertAgentAvailable(input.target_stage);

  var resolved = resolveDispatchCommand(plan, input.target_stage);
  var liveRequested = input.confirm === true;

  // ---- DRY-RUN path -------------------------------------------------------
  if (!liveRequested) {
    var nowDry = nowIso();
    var event = makeEvent({
      targetStage: input.target_stage,
      mode: "dry-run",
      by: by,
      command: resolved.command,
      cwd: resolved.cwd,
      outcome: "ok",
      nowIso: nowDry
    });
    var nextDry: ClaudePlan = Object.assign({}, plan, {
      dispatch_log: (plan.dispatch_log || []).concat([event]),
      updated_at: nowDry,
      schema_version: CURRENT_SCHEMA_VERSION
    });
    atomicWriteJson(planPath(root, plan.slug), nextDry);
    return {
      mode: "dry-run",
      plan_slug: plan.slug,
      target_stage: input.target_stage,
      command: resolved.command,
      cwd: resolved.cwd,
      event: event
    };
  }

  // ---- LIVE path: validate token --------------------------------------
  var check = validateToken(plan, input.token, input.target_stage, Date.now());
  if (!check.ok) {
    // Record the rejection in the log AND throw the typed error so the
    // caller (dashboard) can branch. We deliberately persist the log
    // entry — failed dispatches are operational signal.
    var nowFail = nowIso();
    // "no-token" covers both missing-arg and missing-stored-token. Other
    // failure modes (mismatch, consumed, expired, wrong stage) are stale-token.
    var isNoTokenCase =
      check.reason === "token argument is required" ||
      (typeof check.reason === "string" && check.reason.indexOf("no outstanding") !== -1);
    var failOutcome: DispatchEvent["outcome"] = isNoTokenCase ? "no-token" : "stale-token";
    var failEvent = makeEvent({
      targetStage: input.target_stage,
      mode: "live",
      by: by,
      command: resolved.command,
      cwd: resolved.cwd,
      outcome: failOutcome,
      error: check.reason,
      nowIso: nowFail
    });
    var nextFail: ClaudePlan = Object.assign({}, plan, {
      dispatch_log: (plan.dispatch_log || []).concat([failEvent]),
      updated_at: nowFail,
      schema_version: CURRENT_SCHEMA_VERSION
    });
    atomicWriteJson(planPath(root, plan.slug), nextFail);
    if (failOutcome === "no-token") throw new NoTokenError(check.reason || "missing");
    throw new StaleTokenError(check.reason || "invalid");
  }

  // ---- LIVE path: atomic consume BEFORE spawn -------------------------
  var nowOk = nowIso();
  var consumedToken = Object.assign({}, plan.dispatch_token, {
    consumed_at: nowOk
  });
  // Pre-spawn write: token consumed, no spawn pid yet. If spawn throws,
  // the token stays consumed (by design — we'd rather replay than risk
  // a double-spawn).
  var preSpawn: ClaudePlan = Object.assign({}, plan, {
    dispatch_token: consumedToken,
    updated_at: nowOk,
    schema_version: CURRENT_SCHEMA_VERSION
  });
  atomicWriteJson(planPath(root, plan.slug), preSpawn);

  // ---- LIVE path: spawn ------------------------------------------------
  var spawned;
  try {
    spawned = spawnFn(resolved.argv, resolved.cwd);
  } catch (e) {
    var msg = e instanceof Error ? e.message : String(e);
    var spawnFailEvent = makeEvent({
      targetStage: input.target_stage,
      mode: "live",
      by: by,
      command: resolved.command,
      cwd: resolved.cwd,
      outcome: "spawn-error",
      error: msg,
      nowIso: nowIso()
    });
    var postFail: ClaudePlan = Object.assign({}, preSpawn, {
      dispatch_log: (preSpawn.dispatch_log || []).concat([spawnFailEvent]),
      updated_at: spawnFailEvent.at
    });
    atomicWriteJson(planPath(root, plan.slug), postFail);
    throw e;
  }

  var liveEvent = makeEvent({
    targetStage: input.target_stage,
    mode: "live",
    by: by,
    command: resolved.command,
    cwd: resolved.cwd,
    outcome: "ok",
    pid: spawned.pid,
    nowIso: nowIso()
  });
  var post: ClaudePlan = Object.assign({}, preSpawn, {
    dispatch_log: (preSpawn.dispatch_log || []).concat([liveEvent]),
    updated_at: liveEvent.at
  });
  atomicWriteJson(planPath(root, plan.slug), post);

  return {
    mode: "live",
    plan_slug: plan.slug,
    target_stage: input.target_stage,
    command: resolved.command,
    cwd: resolved.cwd,
    pid: spawned.pid,
    event: liveEvent
  };
}
