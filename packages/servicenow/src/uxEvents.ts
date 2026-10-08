/**
 * dove-sn ux-events sync — register a UI Component's dispatched events.
 *
 * A Next Experience component declares the events it dispatches in
 * now-ui.json (`components.<tag>.actions[]`). UI Builder can only map an event
 * that exists as a `sys_ux_event` record AND is listed in the component
 * macroponent's `dispatched_events` (a comma-separated glide_list of
 * sys_ux_event sys_ids). A component deploy does not reliably create either,
 * so new actions used to need a manual Studio step.
 *
 * This module diffs each component's declared actions against the instance
 * and (only when asked to apply) creates the missing sys_ux_event records via
 * the scope- and update-set-aware createRecord op, then APPENDS their sys_ids
 * to the macroponent's dispatched_events via set-field. It never deletes an
 * event, never drops or reorders an existing dispatched_events entry, and never
 * overwrites a label/description that drifted — drift and orphans are reported.
 *
 * Macroponent resolution: sys_ux_lib_component (tag = <component tag>) →
 * sys_ux_macroponent (root_component = that lib component, category = component).
 */

import { z } from "zod";
import { createClient } from "./client";
import type { ServiceNowClient } from "./client";
import { createRecord } from "./createRecord";
import { setField, fieldToString } from "./setField";

// ---------------------------------------------------------------------------
// Input validation. now-ui.json is file content we do not control: every value
// that later reaches an encoded query is constrained to a charset that cannot
// carry the encoded-query metacharacters (^ , =) or whitespace.
// ---------------------------------------------------------------------------

var EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
var TAG_RE = /^[a-z][a-z0-9-]{0,99}$/;
var SYS_ID_RE = /^[0-9a-f]{32}$/;
var SCOPE_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

var actionSchema = z
  .object({
    name: z.string().regex(EVENT_NAME_RE, "action name must match " + EVENT_NAME_RE.toString()),
    label: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
  })
  .passthrough();

var componentSchema = z
  .object({
    actions: z.array(actionSchema).optional(),
  })
  .passthrough();

var nowUiSchema = z
  .object({
    components: z.record(componentSchema),
  })
  .passthrough();

export interface UxAction {
  name: string;
  label: string;
  description: string;
}

export interface ComponentActions {
  tag: string;
  actions: Array<UxAction>;
}

/**
 * Parse now-ui.json content (already JSON-decoded) into per-component action
 * lists. Throws on a malformed shape, an invalid tag/event name, or a duplicate
 * action name within one component. Components with no actions are omitted.
 */
export function parseNowUiActions(json: unknown): Array<ComponentActions> {
  var parsed = nowUiSchema.safeParse(json);
  if (!parsed.success) {
    var first = parsed.error.issues[0];
    throw new Error(
      "now-ui.json is not a valid component manifest: " +
        (first ? first.path.join(".") + ": " + first.message : parsed.error.message),
    );
  }
  var out: Array<ComponentActions> = [];
  var tags = Object.keys(parsed.data.components);
  for (var i = 0; i < tags.length; i += 1) {
    var tag = tags[i];
    if (!TAG_RE.test(tag)) {
      throw new Error("now-ui.json: invalid component tag '" + tag + "'");
    }
    var raw = parsed.data.components[tag].actions || [];
    if (raw.length === 0) continue;
    var seen: Record<string, boolean> = {};
    var actions: Array<UxAction> = [];
    for (var j = 0; j < raw.length; j += 1) {
      var name = raw[j].name;
      if (seen[name]) {
        throw new Error("now-ui.json: component '" + tag + "' declares action '" + name + "' twice");
      }
      seen[name] = true;
      actions.push({
        name: name,
        label: raw[j].label || name,
        description: raw[j].description || "",
      });
    }
    out.push({ tag: tag, actions: actions });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure planning helpers.
// ---------------------------------------------------------------------------

export interface ExistingEvent {
  sysId: string;
  eventName: string;
  label: string;
  description: string;
  scopeSysId: string;
}

export type ActionStatus = "ok" | "create" | "link" | "drift" | "ambiguous";

export interface ActionPlan {
  name: string;
  status: ActionStatus;
  /** sys_ux_event sys_id when the record already exists. */
  eventSysId: string;
  /** True when the event is (or will be, after apply) missing from dispatched_events. */
  needsLink: boolean;
  /** Human-readable detail — drift fields, ambiguity candidates. */
  detail: string;
  action: UxAction;
}

/** Split a glide_list value into sys_ids, dropping blanks and whitespace. */
export function splitGlideList(value: string): Array<string> {
  if (!value) return [];
  return value
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
}

/** Append ids to a glide_list, keeping existing order and skipping duplicates. */
export function appendToGlideList(existing: Array<string>, add: Array<string>): Array<string> {
  var out = existing.slice();
  var have: Record<string, boolean> = {};
  for (var i = 0; i < out.length; i += 1) have[out[i]] = true;
  for (var j = 0; j < add.length; j += 1) {
    if (!add[j] || have[add[j]]) continue;
    have[add[j]] = true;
    out.push(add[j]);
  }
  return out;
}

/**
 * Classify one declared action against the events that carry its name.
 * Candidate preference: one already linked on the macroponent, then one in the
 * component's scope, then any. More than one candidate at the winning tier is
 * ambiguous and never written.
 */
export function classifyAction(
  action: UxAction,
  candidates: Array<ExistingEvent>,
  linkedIds: Array<string>,
  scopeSysId: string,
): ActionPlan {
  var linked = candidates.filter(function (c) {
    return linkedIds.indexOf(c.sysId) !== -1;
  });
  var inScope = candidates.filter(function (c) {
    return c.scopeSysId === scopeSysId;
  });
  var tier = linked.length > 0 ? linked : inScope.length > 0 ? inScope : candidates;

  if (tier.length === 0) {
    return { name: action.name, status: "create", eventSysId: "", needsLink: true, detail: "", action: action };
  }
  if (tier.length > 1) {
    return {
      name: action.name,
      status: "ambiguous",
      eventSysId: "",
      needsLink: false,
      detail:
        tier.length + " sys_ux_event records named " + action.name + ": " +
        tier.map(function (c) { return c.sysId; }).join(", "),
      action: action,
    };
  }
  var ev = tier[0];
  var needsLink = linkedIds.indexOf(ev.sysId) === -1;
  var drift: Array<string> = [];
  if (ev.label !== action.label) drift.push("label '" + ev.label + "' ≠ '" + action.label + "'");
  if (action.description && ev.description !== action.description) drift.push("description differs");
  var status: ActionStatus = needsLink ? "link" : drift.length > 0 ? "drift" : "ok";
  return {
    name: action.name,
    status: status,
    eventSysId: ev.sysId,
    needsLink: needsLink,
    detail: drift.join("; "),
    action: action,
  };
}

// ---------------------------------------------------------------------------
// Instance reads + orchestration.
// ---------------------------------------------------------------------------

export interface ComponentSyncPlan {
  tag: string;
  status: "planned" | "no-macroponent" | "ambiguous-macroponent";
  macroponentSysId: string;
  macroponentName: string;
  scopeSysId: string;
  scopeName: string;
  dispatchedEvents: Array<string>;
  actions: Array<ActionPlan>;
  /** dispatched_events entries whose event is not declared in now-ui.json (report-only). */
  orphans: Array<{ sysId: string; eventName: string }>;
  note: string;
}

export interface UxEventSyncParams {
  client?: ServiceNowClient;
  /** Decoded now-ui.json content. */
  nowUi: unknown;
  /** Limit to one component tag. */
  component?: string;
  /** Update set (sys_id) the creates and the macroponent edit are captured into. Required to apply. */
  updateSetSysId?: string;
  /** Write. Without it the call is a read-only plan. */
  apply?: boolean;
}

export interface ComponentSyncResult extends ComponentSyncPlan {
  created: Array<{ name: string; sysId: string; verified: boolean }>;
  linked: Array<string>;
  verified: boolean;
}

export interface UxEventSyncResult {
  mode: "dry-run" | "applied";
  components: Array<ComponentSyncResult>;
  /** False when any component is unresolved, ambiguous, or failed verification. */
  ok: boolean;
  /** Count of creates + links still pending (dry-run) or not verified (apply). */
  pending: number;
}

type Row = Record<string, unknown>;

async function resolveComponent(client: ServiceNowClient, comp: ComponentActions): Promise<ComponentSyncPlan> {
  var base: ComponentSyncPlan = {
    tag: comp.tag,
    status: "planned",
    macroponentSysId: "",
    macroponentName: "",
    scopeSysId: "",
    scopeName: "",
    dispatchedEvents: [],
    actions: [],
    orphans: [],
    note: "",
  };

  var libs = await client.table.query<Row>("sys_ux_lib_component", "tag=" + comp.tag, {
    limit: 5,
    fields: ["sys_id"],
  });
  if (libs.length === 0) {
    base.status = "no-macroponent";
    base.note = "no sys_ux_lib_component with tag " + comp.tag + " — deploy the component first.";
    return base;
  }
  var libIds = libs.map(function (r) { return fieldToString(r.sys_id); });
  var macros = await client.table.query<Row>(
    "sys_ux_macroponent",
    "root_componentIN" + libIds.join(",") + "^category=component",
    { limit: 5, fields: ["sys_id", "name", "sys_scope", "dispatched_events"] },
  );
  if (macros.length === 0) {
    base.status = "no-macroponent";
    base.note = "no component macroponent has root_component " + libIds.join("/") + ".";
    return base;
  }
  if (macros.length > 1) {
    base.status = "ambiguous-macroponent";
    base.note = macros.length + " macroponents share root component " + comp.tag + ": " +
      macros.map(function (m) { return fieldToString(m.sys_id); }).join(", ");
    return base;
  }

  var mac = macros[0];
  base.macroponentSysId = fieldToString(mac.sys_id);
  base.macroponentName = fieldToString(mac.name);
  base.scopeSysId = fieldToString(mac.sys_scope);
  base.dispatchedEvents = splitGlideList(fieldToString(mac.dispatched_events));

  if (SYS_ID_RE.test(base.scopeSysId)) {
    var scopes = await client.table.query<Row>("sys_scope", "sys_id=" + base.scopeSysId, {
      limit: 1,
      fields: ["scope"],
    });
    base.scopeName = scopes.length > 0 ? fieldToString(scopes[0].scope) : "";
  }

  // Every event named by an action, in any scope.
  var names = comp.actions.map(function (a) { return a.name; });
  var byName = await client.table.query<Row>("sys_ux_event", "event_nameIN" + names.join(","), {
    limit: 1000,
    fields: ["sys_id", "event_name", "label", "description", "sys_scope"],
  });
  var events: Array<ExistingEvent> = byName.map(function (r) {
    return {
      sysId: fieldToString(r.sys_id),
      eventName: fieldToString(r.event_name),
      label: fieldToString(r.label),
      description: fieldToString(r.description),
      scopeSysId: fieldToString(r.sys_scope),
    };
  });

  base.actions = comp.actions.map(function (a) {
    var candidates = events.filter(function (e) { return e.eventName === a.name; });
    return classifyAction(a, candidates, base.dispatchedEvents, base.scopeSysId);
  });

  // Orphans: linked events that the manifest no longer declares.
  var linkedValid = base.dispatchedEvents.filter(function (id) { return SYS_ID_RE.test(id); });
  if (linkedValid.length > 0) {
    var linkedRows = await client.table.query<Row>("sys_ux_event", "sys_idIN" + linkedValid.join(","), {
      limit: 1000,
      fields: ["sys_id", "event_name"],
    });
    for (var i = 0; i < linkedRows.length; i += 1) {
      var en = fieldToString(linkedRows[i].event_name);
      if (names.indexOf(en) === -1) {
        base.orphans.push({ sysId: fieldToString(linkedRows[i].sys_id), eventName: en });
      }
    }
  }
  return base;
}

function countPending(plan: ComponentSyncPlan): number {
  var n = 0;
  for (var i = 0; i < plan.actions.length; i += 1) {
    if (plan.actions[i].status === "create" || plan.actions[i].needsLink) n += 1;
  }
  return n;
}

async function applyComponent(
  client: ServiceNowClient,
  plan: ComponentSyncPlan,
  updateSetSysId: string,
): Promise<ComponentSyncResult> {
  var result: ComponentSyncResult = Object.assign({}, plan, { created: [], linked: [], verified: false });
  if (plan.status !== "planned") return result;
  if (!plan.scopeName) {
    result.note = "could not resolve the macroponent's scope name — refusing to create events in an unknown scope.";
    return result;
  }

  var toLink: Array<string> = [];
  var failures: Array<string> = [];
  for (var i = 0; i < plan.actions.length; i += 1) {
    var ap = plan.actions[i];
    if (ap.status === "create") {
      var cr = await createRecord({
        client: client,
        table: "sys_ux_event",
        fields: {
          event_name: ap.action.name,
          label: ap.action.label,
          description: ap.action.description,
          props: "[]",
          schema_version: "1.0.0",
        },
        scope: plan.scopeName,
        updateSetSysId: updateSetSysId,
        ifAbsentQuery: "event_name=" + ap.action.name + "^sys_scope=" + plan.scopeSysId,
      });
      result.created.push({ name: ap.name, sysId: cr.sysId, verified: cr.verified });
      if (cr.sysId && (cr.status === "created" || cr.status === "skipped")) {
        toLink.push(cr.sysId);
      } else {
        failures.push(ap.name + ": " + cr.note);
      }
    } else if (ap.needsLink && ap.eventSysId) {
      toLink.push(ap.eventSysId);
    }
  }

  if (toLink.length > 0) {
    var merged = appendToGlideList(plan.dispatchedEvents, toLink);
    var sf = await setField({
      client: client,
      table: "sys_ux_macroponent",
      sysId: plan.macroponentSysId,
      fields: { dispatched_events: merged.join(",") },
      updateSetSysId: updateSetSysId,
    });
    if (sf.status === "failed") failures.push("dispatched_events: " + sf.note);
  }

  // Independent verification: re-read the macroponent and confirm every
  // declared (non-ambiguous) action resolves to a linked event.
  var after = await client.table.query<Row>("sys_ux_macroponent", "sys_id=" + plan.macroponentSysId, {
    limit: 1,
    fields: ["dispatched_events"],
  });
  var afterIds = splitGlideList(after.length > 0 ? fieldToString(after[0].dispatched_events) : "");
  var lost = plan.dispatchedEvents.filter(function (id) { return afterIds.indexOf(id) === -1; });
  var missing = toLink.filter(function (id) { return afterIds.indexOf(id) === -1; });
  result.linked = toLink.filter(function (id) { return afterIds.indexOf(id) !== -1; });
  result.dispatchedEvents = afterIds;
  if (lost.length > 0) failures.push("previously-linked events missing after write: " + lost.join(", "));
  if (missing.length > 0) failures.push("not linked after write: " + missing.join(", "));

  result.verified = failures.length === 0;
  result.note = failures.length === 0
    ? "created " + result.created.length + ", linked " + result.linked.length + " — verified via read-back."
    : failures.join(" | ");
  return result;
}

/** Plan (default) or apply the sync for every component in the manifest that declares actions. */
export async function syncUxEvents(params: UxEventSyncParams): Promise<UxEventSyncResult> {
  var client = params.client || createClient({});
  var comps = parseNowUiActions(params.nowUi);
  if (params.component) {
    if (!TAG_RE.test(params.component)) {
      throw new Error("ux-events: invalid --component tag '" + params.component + "'");
    }
    comps = comps.filter(function (c) { return c.tag === params.component; });
    if (comps.length === 0) {
      throw new Error("ux-events: component '" + params.component + "' declares no actions in now-ui.json");
    }
  }
  if (params.apply) {
    if (!params.updateSetSysId || !SYS_ID_RE.test(params.updateSetSysId)) {
      throw new Error("ux-events: --update-set <32-hex sys_id> is required to apply.");
    }
  }

  var results: Array<ComponentSyncResult> = [];
  for (var i = 0; i < comps.length; i += 1) {
    var plan = await resolveComponent(client, comps[i]);
    if (params.apply && countPending(plan) > 0) {
      results.push(await applyComponent(client, plan, params.updateSetSysId as string));
    } else {
      var inSync = plan.status === "planned" && countPending(plan) === 0;
      results.push(Object.assign({}, plan, { created: [], linked: [], verified: inSync }));
    }
  }

  var ok = true;
  var pending = 0;
  for (var k = 0; k < results.length; k += 1) {
    var r = results[k];
    var ambiguous = r.actions.some(function (a) { return a.status === "ambiguous"; });
    if (r.status !== "planned" || ambiguous) ok = false;
    if (params.apply && countPending(r) > 0 && !r.verified) {
      ok = false;
      pending += countPending(r);
    }
    if (!params.apply) pending += countPending(r);
  }
  return { mode: params.apply ? "applied" : "dry-run", components: results, ok: ok, pending: pending };
}

/** Render a result as a terse plain-text table for the CLI. */
export function formatUxEventSync(result: UxEventSyncResult): string {
  var lines: Array<string> = [];
  lines.push("ux-events sync (" + result.mode + ")");
  for (var i = 0; i < result.components.length; i += 1) {
    var c = result.components[i];
    lines.push("");
    lines.push(
      c.tag + " → " + (c.macroponentSysId ? c.macroponentName + " (" + c.macroponentSysId + ", " + (c.scopeName || c.scopeSysId) + ")" : c.status),
    );
    if (c.status !== "planned") {
      lines.push("  " + c.note);
      continue;
    }
    for (var j = 0; j < c.actions.length; j += 1) {
      var a = c.actions[j];
      if (a.status === "ok") continue;
      lines.push("  [" + a.status + "] " + a.name + (a.detail ? " — " + a.detail : ""));
    }
    for (var k = 0; k < c.orphans.length; k += 1) {
      lines.push("  [orphan] " + c.orphans[k].eventName + " (" + c.orphans[k].sysId + ") — linked but not declared; left as-is");
    }
    var okCount = c.actions.filter(function (x) { return x.status === "ok"; }).length;
    lines.push("  " + okCount + "/" + c.actions.length + " in sync" + (c.note ? " — " + c.note : ""));
  }
  lines.push("");
  lines.push(
    result.mode === "dry-run"
      ? result.pending + " event(s) to create/link. Re-run with --apply --update-set <sys_id> to write."
      : result.ok ? "Done — all components verified." : "Incomplete — see notes above.",
  );
  return lines.join("\n");
}
