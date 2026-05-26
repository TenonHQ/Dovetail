/**
 * Category extraction for the dashboard's Topic Cloud.
 *
 * Two-pass extraction over title + content:
 *   1) Curated Tenon vocabulary — case-insensitive regex match against a
 *      canonical noun-phrase list (ServiceNow, Mortise, Mailgun, Journey, …).
 *      Hits return the canonical label, not the matched substring, so
 *      "sn-cert-stability" and "ServiceNow integration" both bucket under
 *      "ServiceNow".
 *   2) Frequency fallback — only fires if the curated pass returned < 3
 *      labels. Tokenizes leftover prose, drops stop + plan-noise words, and
 *      picks the top tokens with freq >= 2 to surface novel topics.
 *
 * Pure in-process — zero new dependencies.
 */

export interface ExtractInput {
  title: string;
  content_md?: string;
  content_html?: string;
}

export interface CategoryHit {
  label: string;
  count: number;
}

interface VocabEntry {
  label: string;
  patterns: RegExp[];
}

// Canonical Tenon/Dovetail vocabulary. Order is preferred-display order —
// when capping the per-plan output, earlier entries win ties.
//
// Patterns are word-bounded where it matters; sub-string slugs like "sn-" are
// caught by their own pattern. Keep patterns conservative: a false positive
// here clutters every plan, a false negative just falls through to the
// frequency pass.
export var CURATED_VOCAB: VocabEntry[] = [
  {
    label: "ServiceNow",
    patterns: [
      /\bservicenow\b/i,
      /\bsn-(?:cert|form|build|api|node|script)/i,
      /\bsys_(?:script|ux|ui|dictionary|choice|update|user|properties)\b/i,
      /\bx_cadso_/i,
      /\bscoped app\b/i,
      /\bupdate set\b/i,
      /\bnow experience\b/i
    ]
  },
  {
    label: "Mortise",
    patterns: [/\bmortise\b/i, /\bmortise\//i]
  },
  {
    label: "Sashimono",
    patterns: [/\bsashimono\b/i]
  },
  {
    label: "Journey",
    patterns: [
      /\bjourney\b/i,
      /\bjourney-/i,
      /\bcadso[_-]journey/i,
      /\bjourney builder\b/i
    ]
  },
  {
    label: "Dovetail",
    patterns: [/\bdovetail\b/i, /\bdove[_-](?:watch|push|pull|config|init)\b/i]
  },
  {
    label: "ClickUp",
    patterns: [/\bclickup\b/i]
  },
  {
    label: "Mailgun",
    patterns: [/\bmailgun\b/i]
  },
  {
    label: "Email",
    patterns: [/\bemail\b/i, /\bemail-spok\b/i, /\bemail metrics\b/i]
  },
  {
    label: "SMS",
    patterns: [
      /\bsms\b/i,
      /\btext[\s-]?spoke\b/i,
      /\btextspoke\b/i,
      /\bdlr\b/i,
      /\boptin\b/i
    ]
  },
  {
    label: "Sinch",
    patterns: [/\bsinch\b/i]
  },
  {
    label: "Sawmill",
    patterns: [/\bsawmill\b/i]
  },
  {
    label: "React",
    patterns: [/\breact\b/i, /\breact[_-]spa\b/i, /\breactapp\b/i]
  },
  {
    label: "MCP",
    patterns: [/\bmcp\b/i, /\b@modelcontextprotocol\b/i]
  },
  {
    label: "Prompting",
    patterns: [
      /\bprompting\b/i,
      /\bprompt[_-]?(?:cycle|tab|template|playbook)\b/i,
      /\bimprove[_-]prompt\b/i,
      /\bxml prompting\b/i
    ]
  },
  {
    label: "Tooling",
    patterns: [
      /\btooling\b/i,
      /\bsync[_-]tooling\b/i,
      /\bclaude[_-]plans\b/i,
      /\bskill\b/i,
      /\bworkflow\b/i,
      /\bcli\b/i
    ]
  },
  {
    label: "Dashboard",
    patterns: [/\bdashboard\b/i]
  },
  {
    label: "Docs",
    patterns: [/\bdocumentation\b/i, /\bclaude\.md\b/i, /\bonboarding\b/i, /\bdocs\b/i]
  },
  {
    label: "Retrospective",
    patterns: [/\bretrospective\b/i]
  },
  {
    label: "Voice Brief",
    patterns: [/\bvoice[_-]brief\b/i]
  },
  {
    label: "DEV ticket",
    patterns: [/\bdev[- ]?\d{2,4}\b/i, /\bclickup task\b/i]
  },
  {
    label: "Billing",
    patterns: [/\bbilling\b/i, /\binvoice\b/i, /\bsubscription\b/i, /\bpricing\b/i]
  },
  {
    label: "Testing",
    patterns: [/\b(?:jest|mocha|chai|sinon|jsdom)\b/i, /\btest suite\b/i]
  },
  {
    label: "Release",
    patterns: [/\brelease\b/i, /\bdeploy(?:ment)?\b/i, /\bpublish\b/i, /\bchangelog\b/i]
  },
  {
    label: "Cert",
    patterns: [/\bcertification\b/i, /\bcert[\s-]?stability\b/i]
  }
];

// Generic English stop words.
var STOP_WORDS = new Set<string>(
  (
    "a an and are as at be by for from has have he her his i if in is " +
    "it its of on or our she so such that the their them there these they " +
    "this to too us was we were what when where which while who whom why " +
    "will with would you your yours not no nor do does did done doing " +
    "but can could should may might must shall just been being also any " +
    "more most other some only same than then them through during about " +
    "after before above below up down out off over under again further " +
    "into onto upon between because both each few how very own"
  ).split(/\s+/)
);

// Words specific to the plan-genre that always show up and never name a topic.
var PLAN_NOISE = new Set<string>(
  (
    "plan plans planning step steps phase phases done todo task tasks " +
    "scope status note notes context source title slug content type kind " +
    "section sections row rows item items label labels file files repo " +
    "repos branch branches change changes pr prs commit commits update " +
    "updates create created delete deleted feat fix chore test tests " +
    "data field fields true false null new old check checked checklist " +
    "before after value values key keys link links links option options " +
    "active draft pending approved exited success warning danger info " +
    "default error icon msg message title-bar header footer body main " +
    "click code call calls payload result resolved current next prior " +
    "table tables column columns row cards card render rendered apply " +
    "applies use uses used uses using using using using using using " +
    "via path paths name names href src html json string text date " +
    "time today now run runs running build builds added needs needs " +
    "follow followed wrapper-bg badge badges callout callouts callout " +
    "structured strong em br div span class meta header subtitle " +
    "input output input output input output mode modes single multi " +
    "full review completion approve approval implementation progress " +
    "see see deployed lint pan exit existing tail follow followed open " +
    "discovery api env collection committed template handoff capture " +
    "feature event approach removed save"
  ).split(/\s+/)
);

// Strip wrapped HTML to plain text — naive but adequate for our content_html
// which is generated by renderStructured() (well-formed, no script content).
function stripHtml(s: string): string {
  return s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/&#(?:x[0-9a-f]+|\d+);/gi, " ");
}

function buildHaystack(input: ExtractInput): string {
  var parts: string[] = [input.title];
  if (input.content_md) parts.push(input.content_md);
  if (input.content_html) parts.push(stripHtml(input.content_html));
  return parts.join("\n");
}

function curatedMatches(text: string): CategoryHit[] {
  var hits: CategoryHit[] = [];
  for (var i = 0; i < CURATED_VOCAB.length; i++) {
    var entry = CURATED_VOCAB[i];
    var total = 0;
    for (var p = 0; p < entry.patterns.length; p++) {
      var matches = text.match(new RegExp(entry.patterns[p].source, entry.patterns[p].flags + "g"));
      if (matches) total += matches.length;
    }
    if (total > 0) hits.push({ label: entry.label, count: total });
  }
  return hits;
}

function frequencyFallback(text: string, exclude: Set<string>, limit: number): CategoryHit[] {
  var tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,15}/g) || [];
  var counts = new Map<string, number>();
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    if (STOP_WORDS.has(tok)) continue;
    if (PLAN_NOISE.has(tok)) continue;
    if (exclude.has(tok)) continue;
    counts.set(tok, (counts.get(tok) || 0) + 1);
  }
  var out: CategoryHit[] = [];
  counts.forEach(function (count, label) {
    if (count >= 2) out.push({ label: label, count: count });
  });
  out.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
  return out.slice(0, limit);
}

export interface ExtractOptions {
  maxCategories?: number;
  fallbackThreshold?: number;
}

export function extractCategories(input: ExtractInput, opts: ExtractOptions = {}): string[] {
  var maxOut = opts.maxCategories || 8;
  var fallbackBelow = opts.fallbackThreshold === undefined ? 3 : opts.fallbackThreshold;

  var text = buildHaystack(input);
  var curated = curatedMatches(text);

  // Vocab-first ordering: curated hits first (in CURATED_VOCAB order),
  // then frequency fallback fills remaining slots.
  curated.sort(function (a, b) {
    var ai = -1, bi = -1;
    for (var i = 0; i < CURATED_VOCAB.length; i++) {
      if (CURATED_VOCAB[i].label === a.label) ai = i;
      if (CURATED_VOCAB[i].label === b.label) bi = i;
    }
    return ai - bi;
  });

  var labels: string[] = [];
  var seen = new Set<string>();
  for (var c = 0; c < curated.length && labels.length < maxOut; c++) {
    if (seen.has(curated[c].label)) continue;
    seen.add(curated[c].label);
    labels.push(curated[c].label);
  }

  if (labels.length < fallbackBelow) {
    // Exclude lowercased vocab labels so fallback doesn't redundantly emit them.
    var excludeLower = new Set<string>();
    for (var v = 0; v < CURATED_VOCAB.length; v++) {
      excludeLower.add(CURATED_VOCAB[v].label.toLowerCase());
    }
    var remaining = maxOut - labels.length;
    var fallback = frequencyFallback(text, excludeLower, remaining);
    for (var f = 0; f < fallback.length; f++) {
      if (seen.has(fallback[f].label)) continue;
      seen.add(fallback[f].label);
      labels.push(fallback[f].label);
    }
  }

  return labels;
}

/**
 * Reduce a list of plans into a topic-count list, sorted by count desc.
 * Each plan's `categories` array contributes 1 per label.
 */
export function aggregateCategories(plans: { categories?: string[] }[]): CategoryHit[] {
  var counts = new Map<string, number>();
  for (var i = 0; i < plans.length; i++) {
    var cats = plans[i].categories || [];
    for (var j = 0; j < cats.length; j++) {
      var label = cats[j];
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  var out: CategoryHit[] = [];
  counts.forEach(function (count, label) {
    out.push({ label: label, count: count });
  });
  out.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
  return out;
}
