/**
 * Server-side renderer for content_structured plans.
 * Converts a StructuredPlan (JSON) into sanitizable HTML using .cp-c-* classes
 * defined in the dashboard's claude-plans.css.
 *
 * Claude Code sends content_structured; the renderer emits content_html so the
 * dashboard renders it with no extra code. Claude needs no HTML or CSS knowledge —
 * just compose sections from the types below.
 */

export type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info";
export type CalloutVariant = "info" | "warning" | "danger" | "success";
export type StepStatus = "done" | "active" | "pending" | "error";
export type TagColor =
  | "green"
  | "blue"
  | "cyan"
  | "sage"
  | "warm"
  | "yellow"
  | "purple"
  | "orange"
  | "red"
  | "teal";
export type AvatarColor =
  | "blue"
  | "emerald"
  | "deep-emerald"
  | "neon"
  | "orange"
  | "purple"
  | "pink"
  | "earthy";

export interface HeaderSection {
  type: "header";
  title: string;
  subtitle?: string;
}

export interface MetaRow {
  label: string;
  value: string;
  badge?: BadgeVariant;
}

export interface MetaSection {
  type: "meta";
  title?: string;
  rows: MetaRow[];
}

export interface CalloutSection {
  type: "callout";
  variant?: CalloutVariant;
  title?: string;
  message: string;
}

export interface ChecklistItem {
  label: string;
  done: boolean;
  note?: string;
}

export interface ChecklistSection {
  type: "checklist";
  title?: string;
  items: ChecklistItem[];
}

export interface PipelineStep {
  label: string;
  status: StepStatus;
  note?: string;
}

export interface StepsSection {
  type: "steps";
  title?: string;
  steps: PipelineStep[];
}

export interface MetricItem {
  label: string;
  value: string;
  sub?: string;
  variant?: BadgeVariant;
}

export interface MetricsSection {
  type: "metrics";
  items: MetricItem[];
}

export interface SectionDivider {
  type: "section";
  title: string;
}

export interface TableSection {
  type: "table";
  title?: string;
  headers: string[];
  rows: string[][];
}

export interface TextSection {
  type: "text";
  content: string;
}

export interface CodeSection {
  type: "code";
  title?: string;
  lang?: string;
  content: string;
}

export interface TagItem {
  label: string;
  color?: TagColor;
}

export interface TagsSection {
  type: "tags";
  title?: string;
  items: TagItem[];
}

export interface TimelineEvent {
  label: string;
  time?: string;
  note?: string;
  status?: StepStatus;
}

export interface TimelineSection {
  type: "timeline";
  title?: string;
  events: TimelineEvent[];
}

export interface ProgressItem {
  label: string;
  value: number;
  max?: number;
  variant?: BadgeVariant;
}

export interface ProgressSection {
  type: "progress";
  title?: string;
  items: ProgressItem[];
}

export interface PersonItem {
  name: string;
  sublabel?: string;
  color?: AvatarColor;
}

export interface PeopleSection {
  type: "people";
  title?: string;
  items: PersonItem[];
}

export interface QuoteSection {
  type: "quote";
  text: string;
  cite?: string;
}

export type StructuredSection =
  | HeaderSection
  | MetaSection
  | CalloutSection
  | ChecklistSection
  | StepsSection
  | MetricsSection
  | SectionDivider
  | TableSection
  | TextSection
  | CodeSection
  | TagsSection
  | TimelineSection
  | ProgressSection
  | PeopleSection
  | QuoteSection;

export interface StructuredPlan {
  sections: StructuredSection[];
}

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

var CALLOUT_ICONS: Record<string, string> = {
  info: "&#x2139;",
  warning: "&#x26A0;",
  danger: "&#x2715;",
  success: "&#x2713;",
};

function renderHeader(s: HeaderSection): string {
  var out = '<div class="cp-c-header">';
  out += '<div class="cp-c-header-title">' + esc(s.title) + "</div>";
  if (s.subtitle)
    out += '<div class="cp-c-header-sub">' + esc(s.subtitle) + "</div>";
  out += "</div>";
  return out;
}

function renderMeta(s: MetaSection): string {
  var out = '<div class="cp-c-meta">';
  if (s.title) out += '<div class="cp-c-label">' + esc(s.title) + "</div>";
  out += '<table class="cp-c-meta-table">';
  for (var i = 0; i < s.rows.length; i++) {
    var row = s.rows[i];
    out += "<tr>";
    out += '<td class="cp-c-meta-key">' + esc(row.label) + "</td>";
    out += '<td class="cp-c-meta-val">';
    if (row.badge) {
      out +=
        '<span class="cp-c-badge cp-c-badge-' +
        esc(row.badge) +
        '">' +
        esc(row.value) +
        "</span>";
    } else {
      out += esc(row.value);
    }
    out += "</td>";
    out += "</tr>";
  }
  out += "</table></div>";
  return out;
}

function renderCallout(s: CalloutSection): string {
  var variant = s.variant || "info";
  var icon = CALLOUT_ICONS[variant] || CALLOUT_ICONS["info"];
  var out = '<div class="cp-c-callout cp-c-callout-' + esc(variant) + '">';
  out += '<span class="cp-c-callout-icon">' + icon + "</span>";
  out += '<div class="cp-c-callout-body">';
  if (s.title)
    out += '<div class="cp-c-callout-title">' + esc(s.title) + "</div>";
  out += '<div class="cp-c-callout-msg">' + esc(s.message) + "</div>";
  out += "</div></div>";
  return out;
}

function renderChecklist(s: ChecklistSection): string {
  var out = '<div class="cp-c-checklist">';
  if (s.title) out += '<div class="cp-c-label">' + esc(s.title) + "</div>";
  out += '<ul class="cp-c-check-list">';
  for (var i = 0; i < s.items.length; i++) {
    var item = s.items[i];
    var cls = "cp-c-check-item" + (item.done ? " cp-c-check-done" : "");
    out += '<li class="' + cls + '">';
    out +=
      '<span class="cp-c-check-box">' +
      (item.done ? "&#x2713;" : "") +
      "</span>";
    out += '<span class="cp-c-check-label">' + esc(item.label) + "</span>";
    if (item.note)
      out += '<span class="cp-c-check-note">' + esc(item.note) + "</span>";
    out += "</li>";
  }
  out += "</ul></div>";
  return out;
}

function renderSteps(s: StepsSection): string {
  var out = '<div class="cp-c-steps">';
  if (s.title) out += '<div class="cp-c-label">' + esc(s.title) + "</div>";
  out += '<div class="cp-c-step-track">';
  for (var i = 0; i < s.steps.length; i++) {
    var step = s.steps[i];
    var cls = "cp-c-step cp-c-step-" + esc(step.status);
    out += '<div class="' + cls + '">';
    out += '<div class="cp-c-step-dot"></div>';
    out += '<div class="cp-c-step-label">' + esc(step.label) + "</div>";
    if (step.note)
      out += '<div class="cp-c-step-note">' + esc(step.note) + "</div>";
    out += "</div>";
    if (i < s.steps.length - 1) {
      var lineFilled =
        step.status === "done" && s.steps[i + 1].status !== "pending";
      out +=
        '<div class="cp-c-step-line' +
        (lineFilled ? " cp-c-step-line-filled" : "") +
        '"></div>';
    }
  }
  out += "</div></div>";
  return out;
}

function renderMetrics(s: MetricsSection): string {
  var out = '<div class="cp-c-metrics">';
  for (var i = 0; i < s.items.length; i++) {
    var item = s.items[i];
    var cardCls =
      "cp-c-metric" + (item.variant ? " cp-c-metric-" + esc(item.variant) : "");
    out += '<div class="' + cardCls + '">';
    out += '<div class="cp-c-metric-val">' + esc(item.value) + "</div>";
    out += '<div class="cp-c-metric-label">' + esc(item.label) + "</div>";
    if (item.sub)
      out += '<div class="cp-c-metric-sub">' + esc(item.sub) + "</div>";
    out += "</div>";
  }
  out += "</div>";
  return out;
}

function renderSectionDivider(s: SectionDivider): string {
  return (
    '<div class="cp-c-section-divider"><span>' + esc(s.title) + "</span></div>"
  );
}

function renderTable(s: TableSection): string {
  var out = '<div class="cp-c-table-wrap">';
  if (s.title) out += '<div class="cp-c-label">' + esc(s.title) + "</div>";
  out += '<table class="cp-c-table">';
  if (s.headers && s.headers.length) {
    out += "<thead><tr>";
    for (var i = 0; i < s.headers.length; i++) {
      out += "<th>" + esc(s.headers[i]) + "</th>";
    }
    out += "</tr></thead>";
  }
  out += "<tbody>";
  for (var j = 0; j < s.rows.length; j++) {
    out += "<tr>";
    for (var k = 0; k < s.rows[j].length; k++) {
      out += "<td>" + esc(s.rows[j][k]) + "</td>";
    }
    out += "</tr>";
  }
  out += "</tbody></table></div>";
  return out;
}

function renderText(s: TextSection): string {
  return (
    '<div class="cp-c-text">' + esc(s.content).replace(/\n/g, "<br>") + "</div>"
  );
}

function renderCode(s: CodeSection): string {
  var out = '<div class="cp-c-code-wrap">';
  if (s.title || s.lang) {
    out += '<div class="cp-c-code-header">';
    if (s.title)
      out += '<span class="cp-c-code-title">' + esc(s.title) + "</span>";
    if (s.lang)
      out += '<span class="cp-c-code-lang">' + esc(s.lang) + "</span>";
    out += "</div>";
  }
  out += '<pre class="cp-c-code"><code>' + esc(s.content) + "</code></pre>";
  out += "</div>";
  return out;
}

var TAG_COLORS: Record<string, boolean> = {
  green: true,
  blue: true,
  cyan: true,
  sage: true,
  warm: true,
  yellow: true,
  purple: true,
  orange: true,
  red: true,
  teal: true,
};

var AVATAR_COLORS: Record<string, boolean> = {
  blue: true,
  emerald: true,
  "deep-emerald": true,
  neon: true,
  orange: true,
  purple: true,
  pink: true,
  earthy: true,
};

function initials(name: string): string {
  var parts = String(name).trim().split(/\s+/);
  var first = parts[0] ? parts[0].charAt(0) : "";
  var second = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + second).toUpperCase() || "?";
}

function renderTags(s: TagsSection): string {
  var out = '<div class="cp-c-tags">';
  if (s.title) out += '<div class="cp-c-label">' + esc(s.title) + "</div>";
  out += '<div class="cp-c-tag-list">';
  for (var i = 0; i < s.items.length; i++) {
    var item = s.items[i];
    var color = item.color && TAG_COLORS[item.color] ? item.color : "sage";
    out +=
      '<span class="cp-c-tag cp-c-tag-' +
      color +
      '">' +
      esc(item.label) +
      "</span>";
  }
  out += "</div></div>";
  return out;
}

function renderTimeline(s: TimelineSection): string {
  var out = '<div class="cp-c-timeline-wrap">';
  if (s.title) out += '<div class="cp-c-label">' + esc(s.title) + "</div>";
  out += '<div class="cp-c-timeline">';
  for (var i = 0; i < s.events.length; i++) {
    var ev = s.events[i];
    var status = ev.status || "pending";
    out += '<div class="cp-c-tl-item cp-c-tl-' + esc(status) + '">';
    out +=
      '<div class="cp-c-tl-rail"><div class="cp-c-tl-dot"></div><div class="cp-c-tl-line"></div></div>';
    out += '<div class="cp-c-tl-body">';
    out +=
      '<div class="cp-c-tl-head"><span class="cp-c-tl-label">' +
      esc(ev.label) +
      "</span>";
    if (ev.time)
      out += '<span class="cp-c-tl-time">' + esc(ev.time) + "</span>";
    out += "</div>";
    if (ev.note) out += '<div class="cp-c-tl-note">' + esc(ev.note) + "</div>";
    out += "</div></div>";
  }
  out += "</div></div>";
  return out;
}

function renderProgress(s: ProgressSection): string {
  var out = '<div class="cp-c-progress-wrap">';
  if (s.title) out += '<div class="cp-c-label">' + esc(s.title) + "</div>";
  for (var i = 0; i < s.items.length; i++) {
    var item = s.items[i];
    var max = typeof item.max === "number" && item.max > 0 ? item.max : 100;
    var pct = Math.max(
      0,
      Math.min(100, Math.round((Number(item.value) / max) * 100)),
    );
    var variantCls = item.variant ? " cp-c-progress-" + esc(item.variant) : "";
    out += '<div class="cp-c-progress' + variantCls + '">';
    out += '<div class="cp-c-progress-head">';
    out += '<span class="cp-c-progress-label">' + esc(item.label) + "</span>";
    out += '<span class="cp-c-progress-value">' + pct + "%</span>";
    out += "</div>";
    out +=
      '<div class="cp-c-progress-track"><div class="cp-c-progress-fill" style="width:' +
      pct +
      '%"></div></div>';
    out += "</div>";
  }
  out += "</div>";
  return out;
}

function renderPeople(s: PeopleSection): string {
  var out = '<div class="cp-c-people-wrap">';
  if (s.title) out += '<div class="cp-c-label">' + esc(s.title) + "</div>";
  out += '<div class="cp-c-people">';
  for (var i = 0; i < s.items.length; i++) {
    var person = s.items[i];
    var color =
      person.color && AVATAR_COLORS[person.color] ? person.color : "earthy";
    out += '<div class="cp-c-person">';
    out +=
      '<span class="cp-c-avatar cp-c-avatar-' +
      color +
      '">' +
      esc(initials(person.name)) +
      "</span>";
    out += '<span class="cp-c-person-text">';
    out += '<span class="cp-c-person-name">' + esc(person.name) + "</span>";
    if (person.sublabel)
      out +=
        '<span class="cp-c-person-sub">' + esc(person.sublabel) + "</span>";
    out += "</span></div>";
  }
  out += "</div></div>";
  return out;
}

function renderQuote(s: QuoteSection): string {
  var out = '<blockquote class="cp-c-quote">';
  out +=
    '<div class="cp-c-quote-text">' +
    esc(s.text).replace(/\n/g, "<br>") +
    "</div>";
  if (s.cite) out += '<cite class="cp-c-quote-cite">' + esc(s.cite) + "</cite>";
  out += "</blockquote>";
  return out;
}

export function renderStructured(plan: StructuredPlan): string {
  if (!plan || !Array.isArray(plan.sections)) return "";
  var parts: string[] = ['<div class="cp-structured">'];
  for (var i = 0; i < plan.sections.length; i++) {
    var s = plan.sections[i] as any;
    var html = "";
    switch (s.type) {
      case "header":
        html = renderHeader(s);
        break;
      case "meta":
        html = renderMeta(s);
        break;
      case "callout":
        html = renderCallout(s);
        break;
      case "checklist":
        html = renderChecklist(s);
        break;
      case "steps":
        html = renderSteps(s);
        break;
      case "metrics":
        html = renderMetrics(s);
        break;
      case "section":
        html = renderSectionDivider(s);
        break;
      case "table":
        html = renderTable(s);
        break;
      case "text":
        html = renderText(s);
        break;
      case "code":
        html = renderCode(s);
        break;
      case "tags":
        html = renderTags(s);
        break;
      case "timeline":
        html = renderTimeline(s);
        break;
      case "progress":
        html = renderProgress(s);
        break;
      case "people":
        html = renderPeople(s);
        break;
      case "quote":
        html = renderQuote(s);
        break;
      default:
        break;
    }
    if (html) parts.push(html);
  }
  parts.push("</div>");
  return parts.join("\n");
}
