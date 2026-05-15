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
  PlanStatus,
  PlanWithArtifacts
} from "./types";
import { StructuredPlan, renderStructured } from "./renderer";

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

function planPath(root: string, slug: string): string {
  return path.join(root, slug + ".json");
}

function artifactDir(root: string, planSlug: string): string {
  return path.join(root, planSlug, "artifacts");
}

function artifactPath(root: string, planSlug: string, slug: string): string {
  return path.join(artifactDir(root, planSlug), slug + ".json");
}

export interface PushPlanInput {
  slug?: string;
  title: string;
  content_md?: string;
  content_html?: string;
  content_structured?: StructuredPlan;
  status?: PlanStatus;
  session_id?: string | null;
}

export function pushPlan(input: PushPlanInput, options: StorageOptions = {}): ClaudePlan {
  var root = storageRoot(options);
  var slug = slugify(input.slug || input.title);
  var existing = readJson<ClaudePlan>(planPath(root, slug));
  var now = nowIso();
  var contentMd = input.content_md !== undefined ? input.content_md : "";
  var resolvedHtml = input.content_html;
  if (!resolvedHtml && input.content_structured) {
    resolvedHtml = renderStructured(input.content_structured);
  }
  var hashSource = resolvedHtml !== undefined ? resolvedHtml : contentMd;

  var plan: ClaudePlan = {
    slug: slug,
    title: input.title,
    status: input.status || (existing ? existing.status : "DRAFT"),
    content_md: contentMd,
    content_html: resolvedHtml,
    content_hash: sha256(hashSource),
    created_at: existing ? existing.created_at : now,
    updated_at: now,
    session_id: input.session_id === undefined ? (existing ? existing.session_id : null) : input.session_id
  };

  atomicWriteJson(planPath(root, slug), plan);

  var focusPath = path.join(root, ".focus");
  var focusTmp = focusPath + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(focusTmp, JSON.stringify({ slug: plan.slug, ts: plan.updated_at }));
  fs.renameSync(focusTmp, focusPath);

  return plan;
}

export function updatePlanStatus(slug: string, to: PlanStatus, options: StorageOptions = {}): ClaudePlan {
  var root = storageRoot(options);
  var existing = readJson<ClaudePlan>(planPath(root, slug));
  if (!existing) throw new Error("plan not found: " + slug);

  var allowed = ALLOWED_TRANSITIONS[existing.status];
  if (allowed.indexOf(to) === -1) {
    throw new Error("invalid transition: " + existing.status + " -> " + to);
  }

  var next: ClaudePlan = Object.assign({}, existing, { status: to, updated_at: nowIso() });
  atomicWriteJson(planPath(root, slug), next);
  return next;
}

export function getPlan(slug: string, options: StorageOptions = {}): PlanWithArtifacts | null {
  var root = storageRoot(options);
  var plan = readJson<ClaudePlan>(planPath(root, slug));
  if (!plan) return null;
  return { plan: plan, artifacts: listArtifacts(slug, options) };
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
    var plan = readJson<ClaudePlan>(path.join(root, name));
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

export function deletePlan(slug: string, options: StorageOptions = {}): boolean {
  var root = storageRoot(options);
  var file = planPath(root, slug);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  var dir = path.join(root, slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
