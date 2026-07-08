/**
 * Feature-usage scoring for pushed plans.
 *
 * push_plan returns this score (0..1) to the MCP caller so a session gets
 * immediate feedback when it under-uses the surface — a thin markdown-only
 * push with no diagram, no structured layout, and no linked PR scores low and
 * lists exactly what's missing. The score is advisory: it never blocks a push.
 *
 * Weights sum to 1.0. The score reflects the features attached *at push time*;
 * artifacts are usually pushed after the plan, so a fresh plan legitimately
 * scores below 1.0 until its diagrams/docs land — that's the intended nudge.
 */

import { ClaudeArtifact, ClaudePlan } from "./types";

export interface FeatureScore {
  score: number; // 0..1, two-decimal rounded
  missing: string[]; // human-readable features not yet used
  hint: string; // one-line nudge toward the highest-value gaps
}

// Minimum body length (chars) below which content reads as a stub.
var BODY_FLOOR = 400;

interface ScoreInput {
  plan: ClaudePlan;
  artifacts: ClaudeArtifact[];
}

export function scorePlanFeatures(input: ScoreInput): FeatureScore {
  var plan = input.plan;
  var artifacts = input.artifacts || [];

  var hasStructured =
    typeof plan.content_html === "string" && plan.content_html.length > 0;
  var bodyLen =
    (plan.content_md || "").length + (plan.content_html || "").length;
  var hasBody = bodyLen >= BODY_FLOOR;
  var hasDiagram = artifacts.some(function (a) {
    return a.kind === "mermaid";
  });
  var hasDoc = artifacts.some(function (a) {
    return a.kind === "markdown";
  });
  var hasLinks =
    Array.isArray(plan.linked_artifacts) && plan.linked_artifacts.length > 0;
  var hasPr = plan.pr_url !== undefined || plan.pr_number !== undefined;
  var hasCategories =
    Array.isArray(plan.categories) && plan.categories.length > 0;

  var dims = [
    {
      ok: hasStructured,
      weight: 0.15,
      label: "structured content (content_structured / content_html)",
    },
    {
      ok: hasBody,
      weight: 0.15,
      label: "a substantial body (>= " + BODY_FLOOR + " chars)",
    },
    {
      ok: hasDiagram,
      weight: 0.2,
      label: "at least one diagram (push_diagram)",
    },
    {
      ok: hasDoc,
      weight: 0.15,
      label: "at least one markdown artifact (push_artifact)",
    },
    {
      ok: hasLinks,
      weight: 0.1,
      label: "linked related plans (linked_artifacts)",
    },
    { ok: hasPr, weight: 0.1, label: "a linked PR (pr_url / pr_number)" },
    { ok: hasCategories, weight: 0.15, label: "topic categories" },
  ];

  var raw = 0;
  var missing: string[] = [];
  for (var i = 0; i < dims.length; i++) {
    if (dims[i].ok) raw += dims[i].weight;
    else missing.push(dims[i].label);
  }

  var score = Math.round(raw * 100) / 100;
  var hint;
  if (missing.length === 0) {
    hint = "Full marks — this plan uses every claude-plans display feature.";
  } else {
    // Surface the two heaviest gaps so the nudge points at the biggest wins.
    var ranked = dims
      .filter(function (d) {
        return !d.ok;
      })
      .sort(function (a, b) {
        return b.weight - a.weight;
      })
      .slice(0, 2)
      .map(function (d) {
        return d.label;
      });
    hint =
      "Score " +
      score.toFixed(2) +
      "/1.00 — add " +
      ranked.join(" and ") +
      " to raise it.";
  }

  return { score: score, missing: missing, hint: hint };
}
