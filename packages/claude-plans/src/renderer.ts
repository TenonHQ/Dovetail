/**
 * Server-side renderer for content_structured plans.
 * Converts a StructuredPlan (JSON) into sanitizable HTML using .cp-c-* classes
 * defined in the dashboard's claude-plans.css.
 *
 * Claude Code sends content_structured; the renderer emits content_html so the
 * dashboard renders it with no extra code. Claude needs no HTML or CSS knowledge —
 * just compose sections from the types below.
 */

export type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";
export type CalloutVariant = "info" | "warning" | "danger" | "success";
export type StepStatus = "done" | "active" | "pending" | "error";

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
  | CodeSection;

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
  success: "&#x2713;"
};

function renderHeader(s: HeaderSection): string {
  var out = '<div class="cp-c-header">';
  out += '<div class="cp-c-header-title">' + esc(s.title) + "</div>";
  if (s.subtitle) out += '<div class="cp-c-header-sub">' + esc(s.subtitle) + "</div>";
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
        '<span class="cp-c-badge cp-c-badge-' + esc(row.badge) + '">' + esc(row.value) + "</span>";
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
  if (s.title) out += '<div class="cp-c-callout-title">' + esc(s.title) + "</div>";
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
    out += '<span class="cp-c-check-box">' + (item.done ? "&#x2713;" : "") + "</span>";
    out += '<span class="cp-c-check-label">' + esc(item.label) + "</span>";
    if (item.note) out += '<span class="cp-c-check-note">' + esc(item.note) + "</span>";
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
    if (step.note) out += '<div class="cp-c-step-note">' + esc(step.note) + "</div>";
    out += "</div>";
    if (i < s.steps.length - 1) {
      var lineFilled = step.status === "done" && s.steps[i + 1].status !== "pending";
      out +=
        '<div class="cp-c-step-line' + (lineFilled ? " cp-c-step-line-filled" : "") + '"></div>';
    }
  }
  out += "</div></div>";
  return out;
}

function renderMetrics(s: MetricsSection): string {
  var out = '<div class="cp-c-metrics">';
  for (var i = 0; i < s.items.length; i++) {
    var item = s.items[i];
    var cardCls = "cp-c-metric" + (item.variant ? " cp-c-metric-" + esc(item.variant) : "");
    out += '<div class="' + cardCls + '">';
    out += '<div class="cp-c-metric-val">' + esc(item.value) + "</div>";
    out += '<div class="cp-c-metric-label">' + esc(item.label) + "</div>";
    if (item.sub) out += '<div class="cp-c-metric-sub">' + esc(item.sub) + "</div>";
    out += "</div>";
  }
  out += "</div>";
  return out;
}

function renderSectionDivider(s: SectionDivider): string {
  return '<div class="cp-c-section-divider"><span>' + esc(s.title) + "</span></div>";
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
    if (s.title) out += '<span class="cp-c-code-title">' + esc(s.title) + "</span>";
    if (s.lang) out += '<span class="cp-c-code-lang">' + esc(s.lang) + "</span>";
    out += "</div>";
  }
  out += '<pre class="cp-c-code"><code>' + esc(s.content) + "</code></pre>";
  out += "</div>";
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
      default:
        break;
    }
    if (html) parts.push(html);
  }
  parts.push("</div>");
  return parts.join("\n");
}
