/**
 * Define a Custom Action Type's body — action inputs, outputs and steps (script
 * and REST steps, wired with data pills) — headlessly, the way the Flow
 * Designer's **Save** button does, then optionally publish.
 *
 * The Designer's save is ONE call carrying the FULL action model (not a delta):
 *
 *   GET /api/now/processflow/action/action_types/{id}?sysparm_transaction_scope={scope}
 *         -> the model (43 keys; `steps` comes back null)
 *   GET /api/now/processflow/action/action_types/{id}/step_instances?sysparm_transaction_scope={scope}
 *         -> { steps: [...] }  the real step graph
 *   PUT /api/now/processflow/action/action_types/{id}?sysparm_transaction_scope={scope}
 *         body = the model with inputs[] / outputs[] / steps[] as the Designer holds them
 *         -> 200 { result: <saved model, steps included> }   (state becomes "draft")
 *
 * Established from two captured Designer saves (see
 * tests/fixtures/actionDefine.save1.json / save2.json):
 *
 *  - Each PUT step carries exactly 11 keys: DB_TYPE, cid, step_type_id, section,
 *    label, action, order, inputs, extended_inputs, extended_outputs,
 *    error_handling_type. A script step's `script` input is sent as bare
 *    { name, value }.
 *  - Pills: `{{action.<input>}}` reads an action input; `{{step[<cid>].<output>}}`
 *    reads an earlier step's output. A script step's own input variables are its
 *    `extended_inputs` (the pill goes in `value`); its outputs are
 *    `extended_outputs`.
 *  - An ACTION OUTPUT is wired by putting the pill in the output entry's own
 *    `value` AND `display_value` (e.g. status_code ->
 *    `{{step[<rest cid>].status_code}}`). There is no separate mapping structure;
 *    `label_cache` only caches the pills' display labels for the Designer UI.
 *  - REST step headers are `{"type":"ADV_NV","value":[{name,value,attributes}]}`
 *    serialized into the `headers` input's value.
 *  - Changing an action input's type (string -> choice) makes the server mint a
 *    new variable record (new `id`).
 *
 * New steps are built from Designer-shaped templates (actionDefineTemplates.ts,
 * generated from the same captures), with fresh cids. Existing steps keep their
 * cid. Creating the empty action SHELL is out of scope: make it with
 * `dove-sn clone-action` or the Designer, then define its body here.
 *
 * DRY-RUN BY DEFAULT: without `confirm` it reads and returns the planned diff —
 * zero PUTs, zero publishes. Idempotent: a spec that is already in effect yields
 * an empty diff and no PUT.
 */

import { randomUUID } from "crypto";
import type { ServiceNowClient } from "../client";
import { actionTypePath, fetchActionSteps, unwrapProcessflow } from "./actionTypeApi";
import { resolveScope } from "./cloneActionType";
import { publishActionType } from "./publishActionType";
import type { PublishActionTypeResult } from "./publishActionType";
import { hashScript, readString } from "./stepOps";
import type { StepRecord } from "./stepOps";
import {
  ACTION_INPUT_TEMPLATE,
  ACTION_OUTPUT_TEMPLATE,
  STEP_EXT_INPUT_TEMPLATE,
  STEP_EXT_OUTPUT_TEMPLATE,
  STEP_TYPE_TEMPLATES,
} from "./actionDefineTemplates";
import type { StepTypeTemplate } from "./actionDefineTemplates";

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

/** Variable types a spec may declare. Anything else is refused until a Designer capture shows its shape. */
export type DefineVarType = "string" | "choice" | "boolean" | "integer";

/** `access` values of sys_hub_action_type_definition. */
export type DefineAccess = "public" | "package_private";

/** Step error handling as the Designer stores it (both observed in captures). */
export type DefineErrorHandling = "EVAL_ERRORS" | "NEXT_STEP";

export type DefineStepKind = "script" | "rest";

export interface DefineChoice {
  value: string;
  label?: string;
}

export interface DefineActionInputSpec {
  name: string;
  label?: string;
  /** Default "string" for a new input; omit on an existing one to keep its type. */
  type?: DefineVarType;
  mandatory?: boolean;
  /** Required (non-empty) when type is "choice". */
  choices?: Array<DefineChoice>;
  /** Default value (`defaultValue`). */
  default?: string;
  order?: number;
  /** Max length (`maxsize`). */
  maxLength?: number;
  /** Delete this input. */
  remove?: boolean;
}

export interface DefineActionOutputSpec {
  name: string;
  label?: string;
  type?: DefineVarType;
  /** Data pill the output is wired to, e.g. "{{steps.call.status_code}}". */
  value?: string;
  remove?: boolean;
}

export interface DefineStepVarSpec {
  value?: string;
  type?: DefineVarType;
  label?: string;
  mandatory?: boolean;
  remove?: boolean;
}

export interface DefineStepOutputSpec {
  name: string;
  label?: string;
  type?: DefineVarType;
  remove?: boolean;
}

export interface DefineHeader {
  name: string;
  value: string;
}

export interface DefineReferenceValue {
  value: string;
  display?: string;
}

/** A value for a step-type input (`values`). Arrays are name/value lists (headers, query_params). */
export type DefineStepValue = string | number | boolean | Array<DefineHeader> | DefineReferenceValue;

export interface DefineStepSpec {
  /** Local handle for `{{steps.<ref>.<output>}}` pills. */
  ref: string;
  type: DefineStepKind;
  /** Step label. Also the match key against existing steps. */
  label?: string;
  /** Existing step to target (its cid or current label) — use to rename a step. */
  match?: string;
  remove?: boolean;
  errorHandling?: DefineErrorHandling;
  /** Script steps: the script body. */
  script?: string;
  /** Script steps: step input variables (extended_inputs), name -> value/pill or full spec. */
  inputs?: Record<string, string | DefineStepVarSpec>;
  /** Script steps: step output variables (extended_outputs). */
  outputs?: Array<DefineStepOutputSpec>;
  /** Step-type inputs by name (a REST step's base_url, http_method, headers, ...). */
  values?: Record<string, DefineStepValue>;
}

export interface DefineActionSpec {
  action?: { name?: string; description?: string; access?: DefineAccess };
  inputs?: Array<DefineActionInputSpec>;
  outputs?: Array<DefineActionOutputSpec>;
  steps?: Array<DefineStepSpec>;
}

// ---------------------------------------------------------------------------
// Result / view types
// ---------------------------------------------------------------------------

export interface ActionInputView {
  name: string;
  type: string;
  label: string;
  mandatory: boolean;
  order: number;
  default: string;
  choices: string;
  /** `maxsize`, as a string ("" when unset). */
  maxLength: string;
}

export interface ActionOutputView {
  name: string;
  type: string;
  label: string;
  value: string;
}

export interface StepVarView {
  name: string;
  type: string;
  value: string;
  mandatory: boolean;
}

export interface StepView {
  cid: string;
  label: string;
  type: string;
  order: number;
  errorHandling: string;
  scriptHash: string | null;
  scriptChars: number | null;
  /** Step-type input values, canonicalized (booleans as "true"/"false", references as sys_id). */
  values: Record<string, string>;
  extInputs: Array<StepVarView>;
  extOutputs: Array<{ name: string; type: string; label: string }>;
}

export interface ActionView {
  action: { name: string; description: string; access: string };
  inputs: Array<ActionInputView>;
  /** User outputs only — the system `__action_status__` / `__dont_treat_as_error__` are omitted. */
  outputs: Array<ActionOutputView>;
  steps: Array<StepView>;
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface NamedChange {
  name: string;
  changes: Array<FieldChange>;
}

export interface StepDiffEntry {
  cid: string;
  label: string;
  type: string;
  order: number;
  /** Spec ref when the step came from the spec. */
  ref?: string;
  /** How an existing step was matched: "cid" | "label" | "order". */
  matchedBy?: string;
  /** Per-input summary: "name: 'before' -> 'after'" for changes, "name = 'value'" for a new step. */
  changes: Array<string>;
}

export interface DefineActionDiff {
  action: Array<FieldChange>;
  inputs: { added: Array<string>; changed: Array<NamedChange>; removed: Array<string> };
  outputs: { added: Array<string>; changed: Array<NamedChange>; removed: Array<string> };
  steps: { added: Array<StepDiffEntry>; changed: Array<StepDiffEntry>; removed: Array<StepDiffEntry> };
  empty: boolean;
}

export interface DefineActionPlan {
  /** The full model to PUT (Designer-shaped steps grafted in). */
  body: Record<string, unknown>;
  before: ActionView;
  after: ActionView;
  diff: DefineActionDiff;
  /** Spec step ref -> cid (fresh for new steps). */
  stepRefs: Record<string, string>;
  warnings: Array<string>;
}

export interface DefineActionTypeParams {
  client: ServiceNowClient;
  /** sys_id of the sys_hub_action_type_definition (the shell must already exist). */
  sysId: string;
  /** Scope name (x_cadso_email_spok) or 32-hex sys_scope sys_id — the action's own scope. */
  scope: string;
  spec: DefineActionSpec;
  /** true performs the PUT. Omitted/false = dry-run. */
  confirm?: boolean;
  /** Forces a dry-run even with confirm. */
  dryRun?: boolean;
  /** With confirm: also publish (snapshot) after the save. */
  publish?: boolean;
  /** Update set to pin the REST session to before the save/publish. */
  updateSetSysId?: string;
}

export interface DefineActionVerify {
  ok: boolean;
  notes: Array<string>;
}

export interface DefineActionTypeResult {
  /** planned = dry-run; saved = PUT done; unchanged = spec already in effect (no PUT). */
  status: "planned" | "saved" | "unchanged";
  sysId: string;
  scope: { sysId: string; name: string };
  diff: DefineActionDiff;
  stepRefs: Record<string, string>;
  warnings: Array<string>;
  before: ActionView;
  after: ActionView;
  /** HTTP-level result of the PUT: only set when saved. */
  saved?: { state: string };
  publish?: PublishActionTypeResult;
  verify?: DefineActionVerify;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

var SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var RX_SYS_ID = /^[0-9a-f]{32}$/;
var VAR_TYPES: Array<DefineVarType> = ["string", "choice", "boolean", "integer"];
var TYPE_LABELS: Record<string, string> = {
  string: "String",
  choice: "Choice",
  boolean: "True/False",
  integer: "Integer",
};
var ACCESS_VALUES: Array<DefineAccess> = ["public", "package_private"];
var ERROR_HANDLING_VALUES: Array<DefineErrorHandling> = ["EVAL_ERRORS", "NEXT_STEP"];
var STEP_KINDS: Array<DefineStepKind> = ["script", "rest"];

/** The PUT step key set — exactly what the Designer sends. */
var DESIGNER_STEP_KEYS = [
  "DB_TYPE",
  "cid",
  "step_type_id",
  "section",
  "label",
  "action",
  "order",
  "inputs",
  "extended_inputs",
  "extended_outputs",
  "error_handling_type",
];

var SPEC_KEYS = ["action", "inputs", "outputs", "steps"];
var ACTION_KEYS = ["name", "description", "access"];
var INPUT_KEYS = ["name", "label", "type", "mandatory", "choices", "default", "order", "maxLength", "remove"];
var OUTPUT_KEYS = ["name", "label", "type", "value", "remove"];
var STEP_KEYS = ["ref", "type", "label", "match", "remove", "errorHandling", "script", "inputs", "outputs", "values"];
var STEP_VAR_KEYS = ["value", "type", "label", "mandatory", "remove"];
var STEP_OUTPUT_KEYS = ["name", "label", "type", "remove"];
var CHOICE_KEYS = ["value", "label"];
var HEADER_KEYS = ["name", "value"];
var REFERENCE_KEYS = ["value", "display"];

function fail(msg: string): never {
  throw new Error("defineActionType: " + msg);
}

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function recList(v: unknown): Array<Rec> {
  if (!Array.isArray(v)) {
    return [];
  }
  return v.filter(isRec);
}

function num(v: unknown, fallback: number): number {
  var n = typeof v === "number" ? v : parseInt(readString(v), 10);
  return isNaN(n) ? fallback : n;
}

function assertKeys(obj: unknown, allowed: Array<string>, where: string): Rec {
  if (!isRec(obj)) {
    fail(where + " must be an object.");
  }
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i += 1) {
    if (allowed.indexOf(keys[i]) === -1) {
      fail("unknown key '" + keys[i] + "' in " + where + " (allowed: " + allowed.join(", ") + ").");
    }
  }
  return obj;
}

function assertName(v: unknown, where: string): string {
  if (typeof v !== "string" || !SAFE_NAME.test(v)) {
    fail(where + " '" + String(v) + "' is invalid — names must match " + String(SAFE_NAME)
      + " (no '^', path separators, spaces or dots).");
  }
  return v;
}

function optString(v: unknown, where: string): void {
  if (v !== undefined && typeof v !== "string") {
    fail(where + " must be a string.");
  }
}

function optBool(v: unknown, where: string): void {
  if (v !== undefined && typeof v !== "boolean") {
    fail(where + " must be a boolean.");
  }
}

function optType(v: unknown, where: string): void {
  if (v !== undefined && VAR_TYPES.indexOf(v as DefineVarType) === -1) {
    fail(where + " '" + String(v) + "' is not supported (supported: " + VAR_TYPES.join(", ")
      + "). Other types need a Designer capture of their shape first.");
  }
}

function newUuid(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Spec validation — shape, names, unknown keys. Reference checks happen in the
// planner (they need the model), still before any write.
// ---------------------------------------------------------------------------

export function validateDefineSpec(spec: unknown): DefineActionSpec {
  var s = assertKeys(spec, SPEC_KEYS, "spec");

  if (s.action !== undefined) {
    var a = assertKeys(s.action, ACTION_KEYS, "spec.action");
    optString(a.name, "spec.action.name");
    optString(a.description, "spec.action.description");
    if (a.name !== undefined && String(a.name).trim().length === 0) {
      fail("spec.action.name must not be empty.");
    }
    if (a.access !== undefined && ACCESS_VALUES.indexOf(a.access as DefineAccess) === -1) {
      fail("spec.action.access must be one of " + ACCESS_VALUES.join(", ") + ".");
    }
  }

  var seen: Record<string, boolean> = {};
  if (s.inputs !== undefined) {
    if (!Array.isArray(s.inputs)) {
      fail("spec.inputs must be an array.");
    }
    (s.inputs as Array<unknown>).forEach(function (raw, i) {
      var where = "spec.inputs[" + i + "]";
      var inp = assertKeys(raw, INPUT_KEYS, where);
      var name = assertName(inp.name, where + ".name");
      if (seen[name]) {
        fail("duplicate action input '" + name + "' in spec.inputs.");
      }
      seen[name] = true;
      optString(inp.label, where + ".label");
      optType(inp.type, where + ".type");
      optBool(inp.mandatory, where + ".mandatory");
      optBool(inp.remove, where + ".remove");
      optString(inp.default, where + ".default");
      if (inp.order !== undefined && (typeof inp.order !== "number" || !isFinite(inp.order))) {
        fail(where + ".order must be a number.");
      }
      if (inp.maxLength !== undefined && (typeof inp.maxLength !== "number" || inp.maxLength <= 0)) {
        fail(where + ".maxLength must be a positive number.");
      }
      if (inp.choices !== undefined) {
        if (!Array.isArray(inp.choices) || inp.choices.length === 0) {
          fail(where + ".choices must be a non-empty array of {value, label}.");
        }
        (inp.choices as Array<unknown>).forEach(function (c, ci) {
          var ch = assertKeys(c, CHOICE_KEYS, where + ".choices[" + ci + "]");
          if (typeof ch.value !== "string" || ch.value.length === 0) {
            fail(where + ".choices[" + ci + "].value must be a non-empty string.");
          }
          optString(ch.label, where + ".choices[" + ci + "].label");
        });
        if (inp.type !== undefined && inp.type !== "choice") {
          fail(where + ": choices are only valid with type 'choice'.");
        }
      }
      if (inp.type === "choice" && inp.choices === undefined) {
        fail(where + ": type 'choice' requires choices.");
      }
    });
  }

  var seenOut: Record<string, boolean> = {};
  if (s.outputs !== undefined) {
    if (!Array.isArray(s.outputs)) {
      fail("spec.outputs must be an array.");
    }
    (s.outputs as Array<unknown>).forEach(function (raw, i) {
      var where = "spec.outputs[" + i + "]";
      var out = assertKeys(raw, OUTPUT_KEYS, where);
      var name = assertName(out.name, where + ".name");
      if (name.indexOf("__") === 0) {
        fail(where + ": '" + name + "' is a reserved system output.");
      }
      if (seenOut[name]) {
        fail("duplicate action output '" + name + "' in spec.outputs.");
      }
      seenOut[name] = true;
      optString(out.label, where + ".label");
      optType(out.type, where + ".type");
      optString(out.value, where + ".value");
      optBool(out.remove, where + ".remove");
    });
  }

  var refs: Record<string, boolean> = {};
  if (s.steps !== undefined) {
    if (!Array.isArray(s.steps)) {
      fail("spec.steps must be an array.");
    }
    (s.steps as Array<unknown>).forEach(function (raw, i) {
      var where = "spec.steps[" + i + "]";
      var st = assertKeys(raw, STEP_KEYS, where);
      var ref = assertName(st.ref, where + ".ref");
      if (refs[ref]) {
        fail("duplicate step ref '" + ref + "'.");
      }
      refs[ref] = true;
      if (STEP_KINDS.indexOf(st.type as DefineStepKind) === -1) {
        fail(where + ".type '" + String(st.type) + "' is not a supported step type (supported: "
          + STEP_KINDS.join(", ") + ").");
      }
      optString(st.label, where + ".label");
      optString(st.match, where + ".match");
      optBool(st.remove, where + ".remove");
      if (typeof st.label === "string" && st.label.trim().length === 0) {
        fail(where + ".label must not be empty.");
      }
      if (st.errorHandling !== undefined && ERROR_HANDLING_VALUES.indexOf(st.errorHandling as DefineErrorHandling) === -1) {
        fail(where + ".errorHandling must be one of " + ERROR_HANDLING_VALUES.join(", ") + ".");
      }
      if (st.type !== "script") {
        if (st.script !== undefined || st.inputs !== undefined || st.outputs !== undefined) {
          fail(where + ": script / inputs / outputs are only valid on a script step — use values for a "
            + String(st.type) + " step.");
        }
      }
      optString(st.script, where + ".script");
      if (st.inputs !== undefined) {
        if (!isRec(st.inputs)) {
          fail(where + ".inputs must be an object of name -> value | {value, type, label, mandatory, remove}.");
        }
        var inputs = st.inputs as Rec;
        Object.keys(inputs).forEach(function (k) {
          assertName(k, where + ".inputs key");
          var v = inputs[k];
          if (typeof v === "string") {
            return;
          }
          var vs = assertKeys(v, STEP_VAR_KEYS, where + ".inputs." + k);
          optString(vs.value, where + ".inputs." + k + ".value");
          optType(vs.type, where + ".inputs." + k + ".type");
          optString(vs.label, where + ".inputs." + k + ".label");
          optBool(vs.mandatory, where + ".inputs." + k + ".mandatory");
          optBool(vs.remove, where + ".inputs." + k + ".remove");
        });
      }
      if (st.outputs !== undefined) {
        if (!Array.isArray(st.outputs)) {
          fail(where + ".outputs must be an array.");
        }
        (st.outputs as Array<unknown>).forEach(function (o, oi) {
          var ow = where + ".outputs[" + oi + "]";
          var out = assertKeys(o, STEP_OUTPUT_KEYS, ow);
          assertName(out.name, ow + ".name");
          optString(out.label, ow + ".label");
          optType(out.type, ow + ".type");
          optBool(out.remove, ow + ".remove");
        });
      }
      if (st.values !== undefined) {
        if (!isRec(st.values)) {
          fail(where + ".values must be an object of step input name -> value.");
        }
        var values = st.values as Rec;
        Object.keys(values).forEach(function (k) {
          assertName(k, where + ".values key");
          if (k === "script") {
            fail(where + ".values.script: set the script with the step's `script` field.");
          }
          var v = values[k];
          if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && isFinite(v))) {
            return;
          }
          if (Array.isArray(v)) {
            v.forEach(function (h, hi) {
              var hw = where + ".values." + k + "[" + hi + "]";
              var hdr = assertKeys(h, HEADER_KEYS, hw);
              if (typeof hdr.name !== "string" || hdr.name.length === 0) {
                fail(hw + ".name must be a non-empty string.");
              }
              if (typeof hdr.value !== "string") {
                fail(hw + ".value must be a string.");
              }
            });
            return;
          }
          var ref = assertKeys(v, REFERENCE_KEYS, where + ".values." + k);
          if (typeof ref.value !== "string") {
            fail(where + ".values." + k + ".value must be a string (a sys_id).");
          }
          optString(ref.display, where + ".values." + k + ".display");
        });
      }
    });
  }
  return s as DefineActionSpec;
}

// ---------------------------------------------------------------------------
// Step shape — GET (/step_instances) form <-> Designer (PUT) form
// ---------------------------------------------------------------------------

function kindForTypeId(id: string): DefineStepKind | null {
  if (id === STEP_TYPE_TEMPLATES.script.stepTypeId) {
    return "script";
  }
  if (id === STEP_TYPE_TEMPLATES.rest.stepTypeId) {
    return "rest";
  }
  return null;
}

function stepKind(step: Rec): DefineStepKind | null {
  return kindForTypeId(readString(step.step_type_id));
}

function dbTypeOf(step: Rec): string {
  if (typeof step.DB_TYPE === "string" && step.DB_TYPE) {
    return step.DB_TYPE;
  }
  var t = readString(step.step_type);
  if (t) {
    return t;
  }
  var kind = stepKind(step);
  if (kind) {
    return STEP_TYPE_TEMPLATES[kind].dbType;
  }
  return "";
}

/** Add the Designer's UI bookkeeping keys to an input entry that lacks them. */
function designerInput(entry: Rec, index: number, isScriptStep: boolean): Rec {
  if (isScriptStep && readString(entry.name) === "script") {
    return { name: "script", value: entry.value === undefined ? "" : entry.value };
  }
  var out = clone(entry);
  delete out.children;
  var ui: Rec = {
    field_name: readString(entry.name),
    data_format: "",
    default_value: entry.defaultValue === undefined ? "" : entry.defaultValue,
    canDrop: true,
    nameToBeEdited: false,
    parent: "",
    depth: 1,
    arrayPosition: index,
    uiUniqueId: "",
    sourceUiUniqueId: "",
    sourceType: "",
    sourceId: "",
  };
  Object.keys(ui).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) {
      out[k] = ui[k];
    }
  });
  if (!readString(out.uiUniqueId)) {
    var attrs = isRec(out.attributes) ? out.attributes : null;
    out.uiUniqueId = attrs && readString(attrs.uiUniqueId) ? readString(attrs.uiUniqueId) : newUuid();
  }
  out.arrayPosition = index;
  return out;
}

/** Reshape a step (GET or PUT form) into the Designer's 11-key PUT form. */
export function toDesignerStep(step: Rec, actionSysId: string): Rec {
  var dbType = dbTypeOf(step);
  if (!dbType) {
    fail("cannot determine DB_TYPE for step '" + readString(step.label) + "' (" + readString(step.cid)
      + ") — neither DB_TYPE nor step_type is present.");
  }
  var isScript = stepKind(step) === "script" || dbType === "SCRIPT";
  var out: Rec = {};
  out.DB_TYPE = dbType;
  out.cid = readString(step.cid);
  out.step_type_id = readString(step.step_type_id);
  out.section = step.section === undefined || step.section === null ? "" : step.section;
  out.label = readString(step.label);
  out.action = actionSysId;
  out.order = num(step.order, 0);
  out.inputs = recList(step.inputs).map(function (inp, i) {
    return designerInput(inp, i, isScript);
  });
  out.extended_inputs = clone(recList(step.extended_inputs));
  out.extended_outputs = clone(recList(step.extended_outputs));
  out.error_handling_type = readString(step.error_handling_type) || "EVAL_ERRORS";
  if (!out.cid) {
    fail("step '" + out.label + "' has no cid.");
  }
  return out;
}

function buildNewStep(kind: DefineStepKind, cid: string, label: string, actionSysId: string): Rec {
  var tpl: StepTypeTemplate = STEP_TYPE_TEMPLATES[kind];
  var step = clone(tpl.template);
  step.cid = cid;
  step.label = label;
  step.action = actionSysId;
  step.inputs = recList(step.inputs).map(function (inp) {
    if (Object.prototype.hasOwnProperty.call(inp, "uiUniqueId")) {
      inp.uiUniqueId = newUuid();
    }
    if (isRec(inp.attributes) && Object.prototype.hasOwnProperty.call(inp.attributes, "uiUniqueId")) {
      inp.attributes.uiUniqueId = inp.uiUniqueId;
    }
    return inp;
  });
  step.extended_outputs = recList(step.extended_outputs).map(function (o) {
    o.cid = cid;
    o.step_name = label;
    return o;
  });
  return step;
}

function templateDefaults(kind: DefineStepKind): Record<string, string> {
  var map: Record<string, string> = {};
  recList(STEP_TYPE_TEMPLATES[kind].template.inputs).forEach(function (inp) {
    map[readString(inp.name)] = canonValue(inp.value);
  });
  return map;
}

// ---------------------------------------------------------------------------
// Canonical views (what the diff and verify compare)
// ---------------------------------------------------------------------------

/** Canonical string for a step input value: references -> sys_id, ADV_NV -> name=value list. */
export function canonValue(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  if (typeof v === "boolean" || typeof v === "number") {
    return String(v);
  }
  if (isRec(v)) {
    if (Object.prototype.hasOwnProperty.call(v, "value") && Object.keys(v).length <= 4 && !("type" in v)) {
      return canonValue(v.value);
    }
    return JSON.stringify(v);
  }
  var s = String(v);
  var trimmed = s.trim();
  if (trimmed.charAt(0) === "{") {
    try {
      var parsed: unknown = JSON.parse(trimmed);
      if (isRec(parsed)) {
        if (parsed.type === "ADV_NV" && Array.isArray(parsed.value)) {
          return "ADV_NV:" + JSON.stringify(recList(parsed.value).map(function (h) {
            return [readString(h.name), readString(h.value)];
          }));
        }
        if (typeof parsed.value === "string" && !("type" in parsed)) {
          return parsed.value;
        }
      }
    } catch (e) {
      // Not JSON — a literal that happens to start with "{". Fall through.
    }
  }
  return s;
}

function choicesCanon(v: unknown): string {
  return recList(v).map(function (c) {
    return readString(c.value) + "=" + readString(c.label);
  }).join("|");
}

function isSystemOutput(name: string): boolean {
  return name.indexOf("__") === 0;
}

function scriptInput(step: Rec): Rec | null {
  var list = recList(step.inputs);
  for (var i = 0; i < list.length; i += 1) {
    if (readString(list[i].name) === "script") {
      return list[i];
    }
  }
  return null;
}

export function viewAction(model: Rec, steps: Array<Rec>): ActionView {
  var inputs = recList(model.inputs).map(function (inp): ActionInputView {
    return {
      name: readString(inp.name),
      type: readString(inp.type),
      label: readString(inp.label),
      mandatory: inp.mandatory === true || inp.mandatory === "true",
      order: num(inp.order, 0),
      default: readString(inp.defaultValue),
      choices: readString(inp.type) === "choice" ? choicesCanon(inp.choices) : "",
      maxLength: readString(inp.maxsize),
    };
  });
  var outputs = recList(model.outputs).filter(function (o) {
    return !isSystemOutput(readString(o.name));
  }).map(function (o): ActionOutputView {
    return {
      name: readString(o.name),
      type: readString(o.type),
      label: readString(o.label),
      value: readString(o.value),
    };
  });
  var stepViews = steps.map(function (step): StepView {
    var values: Record<string, string> = {};
    recList(step.inputs).forEach(function (inp) {
      var n = readString(inp.name);
      if (n && n !== "script") {
        values[n] = canonValue(inp.value);
      }
    });
    var si = scriptInput(step);
    var script = si ? readString(si.value) : null;
    return {
      cid: readString(step.cid),
      label: readString(step.label),
      type: dbTypeOf(step),
      order: num(step.order, 0),
      errorHandling: readString(step.error_handling_type),
      scriptHash: script === null ? null : hashScript(script),
      scriptChars: script === null ? null : script.length,
      values: values,
      extInputs: recList(step.extended_inputs).map(function (e) {
        return {
          name: readString(e.name) || readString(e.element),
          type: readString(e.type) || readString(e.internal_type),
          value: canonValue(e.value),
          mandatory: e.mandatory === true || e.mandatory === "true",
        };
      }),
      extOutputs: recList(step.extended_outputs).map(function (e) {
        return {
          name: readString(e.name) || readString(e.element),
          type: readString(e.type) || readString(e.internal_type),
          label: readString(e.label),
        };
      }),
    };
  }).sort(function (a, b) {
    return a.order - b.order;
  });
  return {
    action: {
      name: readString(model.name),
      description: readString(model.description),
      access: readString(model.access),
    },
    inputs: inputs,
    outputs: outputs,
    steps: stepViews,
  };
}

function fieldChanges(before: Rec, after: Rec, fields: Array<string>): Array<FieldChange> {
  var out: Array<FieldChange> = [];
  fields.forEach(function (f) {
    var b = before[f] === undefined ? "" : String(before[f]);
    var a = after[f] === undefined ? "" : String(after[f]);
    if (a !== b) {
      out.push({ field: f, before: b, after: a });
    }
  });
  return out;
}

function diffNamed<T extends { name: string }>(
  before: Array<T>,
  after: Array<T>,
  fields: Array<string>,
): { added: Array<string>; changed: Array<NamedChange>; removed: Array<string> } {
  var byName = function (list: Array<T>, name: string): T | null {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].name === name) {
        return list[i];
      }
    }
    return null;
  };
  var added: Array<string> = [];
  var changed: Array<NamedChange> = [];
  var removed: Array<string> = [];
  after.forEach(function (a) {
    var b = byName(before, a.name);
    if (!b) {
      added.push(a.name);
      return;
    }
    var ch = fieldChanges(b as unknown as Rec, a as unknown as Rec, fields);
    if (ch.length) {
      changed.push({ name: a.name, changes: ch });
    }
  });
  before.forEach(function (b) {
    if (!byName(after, b.name)) {
      removed.push(b.name);
    }
  });
  return { added: added, changed: changed, removed: removed };
}

function ioCanon(list: Array<{ name: string }>): Record<string, string> {
  var m: Record<string, string> = {};
  list.forEach(function (e) {
    m[e.name] = JSON.stringify(e);
  });
  return m;
}

export function diffViews(
  before: ActionView,
  after: ActionView,
  meta: Record<string, { ref: string; matchedBy?: string }>,
): DefineActionDiff {
  var action = fieldChanges(before.action as unknown as Rec, after.action as unknown as Rec, ["name", "description", "access"]);
  var inputs = diffNamed(before.inputs, after.inputs, ["type", "label", "mandatory", "order", "default", "choices", "maxLength"]);
  var outputs = diffNamed(before.outputs, after.outputs, ["type", "label", "value"]);

  var beforeByCid: Record<string, StepView> = {};
  before.steps.forEach(function (s) {
    beforeByCid[s.cid] = s;
  });
  var afterCids: Record<string, boolean> = {};
  var added: Array<StepDiffEntry> = [];
  var changed: Array<StepDiffEntry> = [];

  after.steps.forEach(function (s) {
    afterCids[s.cid] = true;
    var m = meta[s.cid];
    var entry: StepDiffEntry = { cid: s.cid, label: s.label, type: s.type, order: s.order, changes: [] };
    if (m) {
      entry.ref = m.ref;
      if (m.matchedBy) {
        entry.matchedBy = m.matchedBy;
      }
    }
    var b = beforeByCid[s.cid];
    if (!b) {
      var kind: DefineStepKind | null = s.type === STEP_TYPE_TEMPLATES.script.dbType
        ? "script"
        : (s.type === STEP_TYPE_TEMPLATES.rest.dbType ? "rest" : null);
      var defaults = kind ? templateDefaults(kind) : {};
      Object.keys(s.values).forEach(function (k) {
        if (s.values[k] !== defaults[k]) {
          entry.changes.push(k + " = '" + s.values[k] + "'");
        }
      });
      if (s.scriptChars !== null) {
        entry.changes.push("script = " + s.scriptChars + " chars (" + s.scriptHash + ")");
      }
      s.extInputs.forEach(function (e) {
        entry.changes.push("+input " + e.name + " (" + e.type + ") = '" + e.value + "'");
      });
      s.extOutputs.forEach(function (e) {
        entry.changes.push("+output " + e.name + " (" + e.type + ")");
      });
      entry.changes.push("errorHandling = " + s.errorHandling);
      added.push(entry);
      return;
    }
    if (b.label !== s.label) {
      entry.changes.push("label: '" + b.label + "' -> '" + s.label + "'");
    }
    if (b.order !== s.order) {
      entry.changes.push("order: " + b.order + " -> " + s.order);
    }
    if (b.errorHandling !== s.errorHandling) {
      entry.changes.push("errorHandling: " + b.errorHandling + " -> " + s.errorHandling);
    }
    if (b.scriptHash !== s.scriptHash) {
      entry.changes.push("script: " + String(b.scriptChars) + " -> " + String(s.scriptChars) + " chars");
    }
    var keys: Record<string, boolean> = {};
    Object.keys(b.values).concat(Object.keys(s.values)).forEach(function (k) {
      keys[k] = true;
    });
    Object.keys(keys).forEach(function (k) {
      var bv = b.values[k] === undefined ? "" : b.values[k];
      var av = s.values[k] === undefined ? "" : s.values[k];
      if (bv !== av) {
        entry.changes.push(k + ": '" + bv + "' -> '" + av + "'");
      }
    });
    var bi = ioCanon(b.extInputs);
    var ai = ioCanon(s.extInputs);
    s.extInputs.forEach(function (e) {
      if (!bi[e.name]) {
        entry.changes.push("+input " + e.name + " (" + e.type + ") = '" + e.value + "'");
      } else if (bi[e.name] !== ai[e.name]) {
        entry.changes.push("~input " + e.name + " -> (" + e.type + ") = '" + e.value + "'" + (e.mandatory ? " mandatory" : ""));
      }
    });
    b.extInputs.forEach(function (e) {
      if (!ai[e.name]) {
        entry.changes.push("-input " + e.name);
      }
    });
    var bo = ioCanon(b.extOutputs);
    var ao = ioCanon(s.extOutputs);
    s.extOutputs.forEach(function (e) {
      if (!bo[e.name]) {
        entry.changes.push("+output " + e.name + " (" + e.type + ")");
      } else if (bo[e.name] !== ao[e.name]) {
        entry.changes.push("~output " + e.name + " -> (" + e.type + ") '" + e.label + "'");
      }
    });
    b.extOutputs.forEach(function (e) {
      if (!ao[e.name]) {
        entry.changes.push("-output " + e.name);
      }
    });
    if (entry.changes.length) {
      changed.push(entry);
    }
  });
  var removed: Array<StepDiffEntry> = before.steps.filter(function (s) {
    return !afterCids[s.cid];
  }).map(function (s) {
    return { cid: s.cid, label: s.label, type: s.type, order: s.order, changes: [] };
  });

  var empty = action.length === 0
    && inputs.added.length === 0 && inputs.changed.length === 0 && inputs.removed.length === 0
    && outputs.added.length === 0 && outputs.changed.length === 0 && outputs.removed.length === 0
    && added.length === 0 && changed.length === 0 && removed.length === 0;

  return {
    action: action,
    inputs: inputs,
    outputs: outputs,
    steps: { added: added, changed: changed, removed: removed },
    empty: empty,
  };
}

// ---------------------------------------------------------------------------
// Pills
// ---------------------------------------------------------------------------

var PILL = /\{\{([^{}]*)\}\}/g;
var ACTION_PILL = /^action\.([A-Za-z_][A-Za-z0-9_]*)$/;
var FRIENDLY_STEP_PILL = /^steps\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;
var RAW_STEP_PILL = /^step\[([^\]]+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/;

interface PillContext {
  inputNames: Record<string, boolean>;
  refToCid: Record<string, string>;
  stepsByCid: Record<string, Rec>;
  /** Order of the step the value lives in; step pills must point strictly before it. null = no constraint. */
  ownOrder: number | null;
  where: string;
}

function stepOutputNames(step: Rec): Array<string> {
  var names: Array<string> = [];
  var kind = stepKind(step);
  if (kind) {
    STEP_TYPE_TEMPLATES[kind].builtinOutputs.forEach(function (o) {
      names.push(o.name);
    });
  } else {
    recList(step.outputs).forEach(function (o) {
      names.push(readString(o.name));
    });
  }
  recList(step.extended_outputs).forEach(function (o) {
    names.push(readString(o.name) || readString(o.element));
  });
  return names;
}

function checkStepOutput(step: Rec, output: string, ctx: PillContext, pill: string): void {
  var names = stepOutputNames(step);
  var known = stepKind(step) !== null || recList(step.outputs).length > 0;
  if (known && names.indexOf(output) === -1) {
    fail(ctx.where + ": pill " + pill + " — step '" + readString(step.label) + "' has no output '" + output
      + "' (outputs: " + names.join(", ") + ").");
  }
  if (ctx.ownOrder !== null && num(step.order, 0) >= ctx.ownOrder) {
    fail(ctx.where + ": pill " + pill + " reads step '" + readString(step.label)
      + "', which does not run before this step.");
  }
}

/** Resolve friendly pills and validate every pill in `text`. Throws on any unknown reference. */
function resolvePills(text: string, ctx: PillContext): string {
  return text.replace(PILL, function (whole: string, inner: string): string {
    var body = inner.trim();
    var m = ACTION_PILL.exec(body);
    if (m) {
      if (!ctx.inputNames[m[1]]) {
        fail(ctx.where + ": pill " + whole + " references unknown action input '" + m[1] + "'.");
      }
      return "{{action." + m[1] + "}}";
    }
    m = FRIENDLY_STEP_PILL.exec(body);
    if (m) {
      var cid = ctx.refToCid[m[1]];
      if (!cid) {
        fail(ctx.where + ": pill " + whole + " references unknown step ref '" + m[1] + "'.");
      }
      checkStepOutput(ctx.stepsByCid[cid], m[2], ctx, whole);
      return "{{step[" + cid + "]." + m[2] + "}}";
    }
    m = RAW_STEP_PILL.exec(body);
    if (m) {
      var step = ctx.stepsByCid[m[1]];
      if (!step) {
        fail(ctx.where + ": pill " + whole + " references unknown step cid '" + m[1] + "'.");
      }
      checkStepOutput(step, m[2], ctx, whole);
      return whole;
    }
    return fail(ctx.where + ": unsupported pill " + whole
      + " — use {{action.<input>}}, {{steps.<ref>.<output>}} or {{step[<cid>].<output>}}.");
  });
}

/** Every pill in the saved model that no longer resolves (unknown input / cid). */
function danglingPills(model: Rec, steps: Array<Rec>): Array<string> {
  var inputNames: Record<string, boolean> = {};
  recList(model.inputs).forEach(function (i) {
    inputNames[readString(i.name)] = true;
  });
  var cids: Record<string, boolean> = {};
  steps.forEach(function (s) {
    cids[readString(s.cid)] = true;
  });
  var found: Array<string> = [];
  var scan = function (text: string, where: string): void {
    var re = new RegExp(PILL.source, "g");
    var m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      var body = m[1].trim();
      var a = /^action\.([A-Za-z0-9_]+)/.exec(body);
      if (a && !inputNames[a[1]]) {
        found.push(where + ": " + m[0]);
      }
      var s = /^step\[([^\]]+)\]/.exec(body);
      if (s && !cids[s[1]]) {
        found.push(where + ": " + m[0]);
      }
    }
  };
  steps.forEach(function (step) {
    var label = readString(step.label);
    recList(step.inputs).forEach(function (inp) {
      if (readString(inp.name) !== "script") {
        scan(typeof inp.value === "string" ? inp.value : "", "step '" + label + "' input " + readString(inp.name));
      }
    });
    recList(step.extended_inputs).forEach(function (inp) {
      scan(readString(inp.value), "step '" + label + "' variable " + readString(inp.name));
    });
  });
  recList(model.outputs).forEach(function (o) {
    if (!isSystemOutput(readString(o.name))) {
      scan(readString(o.value), "output " + readString(o.name));
    }
  });
  scan(JSON.stringify(model.action_status_metadata || {}), "action_status_metadata");
  return found;
}

// ---------------------------------------------------------------------------
// The planner (pure)
// ---------------------------------------------------------------------------

export interface PlanActionDefinitionParams {
  /** The GET model (unwrapped). Not mutated. */
  model: Record<string, unknown>;
  /** The current steps (/step_instances or a PUT response). Not mutated. */
  steps: Array<StepRecord>;
  spec: DefineActionSpec;
  sysId: string;
  /** sys_id -> display for reference values given as a bare sys_id (e.g. connection_alias). */
  referenceDisplays?: Record<string, string>;
  /** cid factory (tests inject a deterministic one). Default: crypto.randomUUID. */
  newCid?: () => string;
}

function sortByOrder(list: Array<Rec>): Array<Rec> {
  return list.map(function (e, i) {
    return { e: e, i: i };
  }).sort(function (a, b) {
    var d = num(a.e.order, 0) - num(b.e.order, 0);
    return d !== 0 ? d : a.i - b.i;
  }).map(function (x) {
    return x.e;
  });
}

function findByName(list: Array<Rec>, name: string): Rec | null {
  for (var i = 0; i < list.length; i += 1) {
    if (readString(list[i].name) === name || readString(list[i].element) === name) {
      return list[i];
    }
  }
  return null;
}

function maxOrder(list: Array<Rec>): number {
  var m = 0;
  list.forEach(function (e) {
    var o = num(e.order, 0);
    if (o > m) {
      m = o;
    }
  });
  return m;
}

function applyActionInput(inputs: Array<Rec>, spec: DefineActionInputSpec): Array<Rec> {
  var existing = findByName(inputs, spec.name);
  if (spec.remove) {
    return inputs.filter(function (e) {
      return e !== existing;
    });
  }
  var entry: Rec;
  if (existing) {
    entry = existing;
  } else {
    entry = clone(ACTION_INPUT_TEMPLATE);
    var uid = newUuid();
    entry.name = spec.name;
    entry.label = spec.name;
    entry.pillName = spec.name;
    entry.pillLabel = spec.name;
    entry.type = "string";
    entry.type_label = TYPE_LABELS.string;
    entry.mandatory = false;
    entry.order = maxOrder(inputs) + 1;
    entry.uiUniqueId = uid;
    entry.attributes = { uiUniqueId: uid };
    inputs = inputs.concat([entry]);
  }
  if (spec.label !== undefined) {
    entry.label = spec.label;
    if (Object.prototype.hasOwnProperty.call(entry, "pillLabel")) {
      entry.pillLabel = spec.label;
    }
  }
  if (spec.type !== undefined && readString(entry.type) !== spec.type) {
    entry.type = spec.type;
    entry.type_label = TYPE_LABELS[spec.type];
    if (spec.type !== "choice") {
      delete entry.choices;
      delete entry.choiceType;
    }
  }
  if (spec.choices !== undefined) {
    entry.choices = spec.choices.map(function (c, i) {
      return { label: c.label === undefined ? c.value : c.label, value: c.value, order: i + 1 };
    });
    entry.choiceType = "1";
  }
  if (spec.mandatory !== undefined) {
    entry.mandatory = spec.mandatory;
  }
  if (spec.default !== undefined) {
    entry.defaultValue = spec.default;
  }
  if (spec.order !== undefined) {
    entry.order = spec.order;
  }
  if (spec.maxLength !== undefined) {
    entry.maxsize = spec.maxLength;
  }
  if (readString(entry.type) === "choice") {
    var values = recList(entry.choices).map(function (c) {
      return readString(c.value);
    });
    if (values.length === 0) {
      fail("action input '" + spec.name + "' is a choice but has no choices.");
    }
    var def = readString(entry.defaultValue);
    if (def && values.indexOf(def) === -1) {
      fail("action input '" + spec.name + "' default '" + def + "' is not one of its choices (" + values.join(", ") + ").");
    }
  }
  return inputs;
}

function renumberCompact(list: Array<Rec>): void {
  list.forEach(function (e, i) {
    if (Object.prototype.hasOwnProperty.call(e, "arrayPosition")) {
      e.arrayPosition = i;
    }
    if (Object.prototype.hasOwnProperty.call(e, "path") && typeof e.path === "number") {
      e.path = i;
    }
  });
}

/** Encode a spec value for a step-type input, per the input's declared type. */
function encodeStepValue(
  input: Rec,
  value: DefineStepValue,
  resolve: (s: string) => string,
  displays: Record<string, string>,
  where: string,
): unknown {
  var type = readString(input.type);
  if (Array.isArray(value)) {
    if (type !== "name_values") {
      fail(where + ": a name/value list is only valid for a name_values input (this one is '" + type + "').");
    }
    return JSON.stringify({
      type: "ADV_NV",
      value: value.map(function (h) {
        return { name: h.name, value: resolve(h.value), attributes: { omit_if_empty: false, mandatory: false } };
      }),
    });
  }
  if (isRec(value)) {
    if (type !== "reference") {
      fail(where + ": a {value, display} reference is only valid for a reference input (this one is '" + type + "').");
    }
    var ref = value as DefineReferenceValue;
    return JSON.stringify({ display: ref.display !== undefined ? ref.display : (displays[ref.value] || ""), value: ref.value });
  }
  if (type === "boolean") {
    if (value === true || value === "true") {
      return true;
    }
    if (value === false || value === "false") {
      return false;
    }
    fail(where + ": boolean input needs true/false, got " + JSON.stringify(value) + ".");
  }
  if (type === "reference" && typeof value === "string" && RX_SYS_ID.test(value)) {
    return JSON.stringify({ display: displays[value] || "", value: value });
  }
  if (typeof value === "string") {
    return resolve(value);
  }
  return String(value);
}

function upsertLabelCache(model: Rec, steps: Array<Rec>): void {
  var cache = recList(model.label_cache);
  var inputs = recList(model.inputs);
  var byCid: Record<string, Rec> = {};
  steps.forEach(function (s) {
    byCid[readString(s.cid)] = s;
  });
  var wanted: Record<string, Rec> = {};
  var add = function (text: string): void {
    var re = new RegExp(PILL.source, "g");
    var m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      var body = m[1].trim();
      var a = ACTION_PILL.exec(body);
      if (a) {
        var inp = findByName(inputs, a[1]);
        if (inp) {
          wanted[m[0]] = {
            name: m[0], parent_table_name: "", column_name: "", reference: "", reference_display: "",
            label: "action➛" + a[1],
            base_type: readString(inp.type),
            choices: readString(inp.type) === "choice" ? clone(inp.choices) : null,
            attributes: isRec(inp.attributes) ? clone(inp.attributes) : {},
            type: "action", ref: "",
          };
        }
        continue;
      }
      var s = RAW_STEP_PILL.exec(body);
      if (s && byCid[s[1]]) {
        var step = byCid[s[1]];
        var outName = s[2];
        var outLabel = outName;
        var outType = "string";
        var kind = stepKind(step);
        var pool: Array<{ name: string; label: string; type: string }> = kind ? STEP_TYPE_TEMPLATES[kind].builtinOutputs.slice() : [];
        recList(step.extended_outputs).forEach(function (o) {
          pool.push({ name: readString(o.name), label: readString(o.label), type: readString(o.type) });
        });
        pool.forEach(function (o) {
          if (o.name === outName) {
            outLabel = o.label || o.name;
            outType = o.type || "string";
          }
        });
        wanted[m[0]] = {
          name: m[0], parent_table_name: "", column_name: "",
          label: "step➛" + readString(step.label) + "➛" + outLabel,
          reference: "", reference_display: "", type: "step", base_type: outType, choices: null,
          attributes: {}, ref: "",
        };
      }
    }
  };
  steps.forEach(function (step) {
    recList(step.inputs).forEach(function (inp) {
      if (readString(inp.name) !== "script" && typeof inp.value === "string") {
        add(inp.value);
      }
    });
    recList(step.extended_inputs).forEach(function (inp) {
      add(readString(inp.value));
    });
  });
  recList(model.outputs).forEach(function (o) {
    add(readString(o.value));
  });
  add(JSON.stringify(model.action_status_metadata || {}));
  // Every action input is listed in the Designer's cache whether or not a pill uses it.
  inputs.forEach(function (inp) {
    add("{{action." + readString(inp.name) + "}}");
  });
  Object.keys(wanted).forEach(function (name) {
    var hit = false;
    for (var i = 0; i < cache.length; i += 1) {
      if (readString(cache[i].name) === name) {
        cache[i] = wanted[name];
        hit = true;
        break;
      }
    }
    if (!hit) {
      cache.push(wanted[name]);
    }
  });
  model.label_cache = cache;
}

/**
 * Merge a spec into the model + steps. Pure: returns the PUT body and the
 * before/after views; throws on any invalid or dangling reference.
 */
export function planActionDefinition(params: PlanActionDefinitionParams): DefineActionPlan {
  var spec = validateDefineSpec(params.spec);
  var sysId = params.sysId;
  var displays = params.referenceDisplays || {};
  var mintCid = params.newCid || newUuid;
  var warnings: Array<string> = [];

  if (!isRec(params.model)) {
    fail("model must be an object.");
  }
  var model = clone(params.model) as Rec;
  var originalSteps = sortByOrder(recList(clone(params.steps)));
  var before = viewAction(model, originalSteps);
  var danglingBefore = danglingPills(model, originalSteps);

  // 1. Action-level fields.
  if (spec.action) {
    if (spec.action.name !== undefined) {
      model.name = spec.action.name;
      model.displayName = spec.action.name;
    }
    if (spec.action.description !== undefined) {
      model.description = spec.action.description;
    }
    if (spec.action.access !== undefined) {
      model.access = spec.action.access;
    }
  }

  // 2. Action inputs.
  var inputs = recList(model.inputs);
  (spec.inputs || []).forEach(function (inSpec) {
    inputs = applyActionInput(inputs, inSpec);
  });
  inputs = sortByOrder(inputs);
  renumberCompact(inputs);
  model.inputs = inputs;
  var inputNames: Record<string, boolean> = {};
  inputs.forEach(function (i) {
    inputNames[readString(i.name)] = true;
  });

  // 3. Steps — match, create, remove, order.
  var existing = originalSteps.map(function (s) {
    return toDesignerStep(s, sysId);
  });
  var specSteps = spec.steps || [];
  var claimed: Record<string, string> = {}; // cid -> ref
  var matchOf: Record<string, { step: Rec; by: string } | null> = {};

  var byCidOrLabel = function (key: string): Rec | null {
    for (var i = 0; i < existing.length; i += 1) {
      if (readString(existing[i].cid) === key) {
        return existing[i];
      }
    }
    for (var j = 0; j < existing.length; j += 1) {
      if (readString(existing[j].label) === key) {
        return existing[j];
      }
    }
    return null;
  };
  var claim = function (st: DefineStepSpec, step: Rec, by: string): void {
    var cid = readString(step.cid);
    if (claimed[cid] && claimed[cid] !== st.ref) {
      fail("steps '" + claimed[cid] + "' and '" + st.ref + "' both match existing step '"
        + readString(step.label) + "' (" + cid + ").");
    }
    var kind = stepKind(step);
    if (kind && kind !== st.type) {
      fail("step '" + st.ref + "' is type '" + st.type + "' but matched existing step '"
        + readString(step.label) + "', which is a " + kind + " step.");
    }
    if (!kind && readString(step.DB_TYPE) !== STEP_TYPE_TEMPLATES[st.type].dbType) {
      fail("step '" + st.ref + "' matched existing step '" + readString(step.label) + "' of a different type ("
        + readString(step.DB_TYPE) + ").");
    }
    claimed[cid] = st.ref;
    matchOf[st.ref] = { step: step, by: by };
  };

  // 3a. Explicit match, then label.
  specSteps.forEach(function (st) {
    var hit: Rec | null = null;
    var by = "";
    if (st.match) {
      hit = byCidOrLabel(st.match);
      by = hit && readString(hit.cid) === st.match ? "cid" : "label";
      if (!hit && st.label) {
        // A rename already applied on a previous run: the old label is gone.
        hit = byCidOrLabel(st.label);
        by = "label";
      }
      if (!hit && !st.remove) {
        fail("step '" + st.ref + "': match '" + st.match + "' found no existing step.");
      }
    } else if (st.label) {
      var sameLabel = existing.filter(function (e) {
        return readString(e.label) === st.label;
      });
      if (sameLabel.length > 1) {
        fail("step '" + st.ref + "': label '" + st.label + "' matches " + sameLabel.length
          + " existing steps — disambiguate with match: <cid>.");
      }
      hit = sameLabel.length === 1 ? sameLabel[0] : null;
      by = "label";
    }
    if (hit) {
      claim(st, hit, by);
    } else {
      matchOf[st.ref] = null;
    }
  });
  // 3b. Order fallback: the spec position lines up with an unclaimed existing step of the same type.
  specSteps.forEach(function (st, idx) {
    if (matchOf[st.ref] || st.remove || st.match) {
      return;
    }
    var candidate = existing[idx];
    if (!candidate || claimed[readString(candidate.cid)]) {
      return;
    }
    var candLabel = readString(candidate.label);
    var labelWantedElsewhere = specSteps.some(function (o) {
      return o.ref !== st.ref && (o.label === candLabel || o.match === candLabel);
    });
    if (labelWantedElsewhere || readString(candidate.DB_TYPE) !== STEP_TYPE_TEMPLATES[st.type].dbType) {
      return;
    }
    claim(st, candidate, "order");
    warnings.push("step '" + st.ref + "' matched existing step '" + candLabel + "' by position — "
      + "set label/match to target it explicitly.");
  });

  // 3c. Removals.
  var removedCids: Record<string, boolean> = {};
  specSteps.forEach(function (st) {
    if (!st.remove) {
      return;
    }
    var m = matchOf[st.ref];
    if (!m) {
      warnings.push("step '" + st.ref + "' marked remove but no such step exists — nothing to remove.");
      return;
    }
    removedCids[readString(m.step.cid)] = true;
  });

  // 3d. New steps + final order. Existing steps keep their relative order; a new
  //     step is placed before the next existing step the spec lists after it.
  var refToCid: Record<string, string> = {};
  var created: Record<string, Rec> = {};
  specSteps.forEach(function (st) {
    if (st.remove) {
      return;
    }
    var m = matchOf[st.ref];
    if (m) {
      refToCid[st.ref] = readString(m.step.cid);
      return;
    }
    if (!st.label) {
      fail("new step '" + st.ref + "' needs a label.");
    }
    var cid = mintCid();
    created[st.ref] = buildNewStep(st.type, cid, st.label, sysId);
    refToCid[st.ref] = cid;
  });

  var kept = existing.filter(function (s) {
    return !removedCids[readString(s.cid)];
  });
  // Reordering existing steps is refused — the spec must list them in their current order.
  var listedExisting = specSteps.filter(function (st) {
    return !st.remove && matchOf[st.ref];
  }).map(function (st) {
    return kept.indexOf((matchOf[st.ref] as { step: Rec }).step);
  });
  for (var li = 1; li < listedExisting.length; li += 1) {
    if (listedExisting[li] < listedExisting[li - 1]) {
      fail("spec lists existing steps in a different order than the action has them — "
        + "reordering existing steps is not supported.");
    }
  }
  var finalSteps: Array<Rec> = kept.slice();
  specSteps.forEach(function (st, idx) {
    var fresh = created[st.ref];
    if (!fresh) {
      return;
    }
    var anchor: Rec | null = null;
    for (var k = idx + 1; k < specSteps.length; k += 1) {
      var later = matchOf[specSteps[k].ref];
      if (later && !specSteps[k].remove) {
        anchor = later.step;
        break;
      }
    }
    var at = anchor ? finalSteps.indexOf(anchor) : -1;
    if (at === -1) {
      finalSteps.push(fresh);
    } else {
      finalSteps.splice(at, 0, fresh);
    }
  });
  finalSteps.forEach(function (s, i) {
    s.order = i + 1;
  });
  var stepsByCid: Record<string, Rec> = {};
  finalSteps.forEach(function (s) {
    stepsByCid[readString(s.cid)] = s;
  });

  // 4. Per-step content. Step outputs first (a later step's pill may read one).
  specSteps.forEach(function (st) {
    if (st.remove) {
      return;
    }
    var step = stepsByCid[refToCid[st.ref]];
    if (st.label !== undefined) {
      step.label = st.label;
    }
    recList(step.extended_outputs).forEach(function (o) {
      if (Object.prototype.hasOwnProperty.call(o, "step_name")) {
        o.step_name = readString(step.label);
      }
    });
    if (st.errorHandling !== undefined) {
      step.error_handling_type = st.errorHandling;
    }
    if (st.type !== "script" || !st.outputs) {
      return;
    }
    var outs = recList(step.extended_outputs);
    st.outputs.forEach(function (o) {
      var hit = findByName(outs, o.name);
      if (o.remove) {
        outs = outs.filter(function (e) {
          return e !== hit;
        });
        return;
      }
      var type = o.type || (hit ? readString(hit.type) : "string") || "string";
      if (!hit) {
        hit = clone(STEP_EXT_OUTPUT_TEMPLATE);
        var uid = newUuid();
        hit.name = o.name;
        hit.pillName = o.name;
        hit.order = maxOrder(outs) + 1;
        hit.uiUniqueId = uid;
        if (isRec(hit.attributes)) {
          hit.attributes.uiUniqueId = uid;
        }
        hit.cid = readString(step.cid);
        hit.step_name = readString(step.label);
        hit.label = o.label || o.name;
        hit.pillLabel = hit.label;
        outs.push(hit);
      }
      if (o.label !== undefined) {
        hit.label = o.label;
        if (Object.prototype.hasOwnProperty.call(hit, "pillLabel")) {
          hit.pillLabel = o.label;
        }
      }
      hit.type = type;
      hit.type_label = TYPE_LABELS[type] || readString(hit.type_label);
    });
    renumberCompact(outs);
    step.extended_outputs = outs;
  });

  specSteps.forEach(function (st) {
    if (st.remove) {
      return;
    }
    var step = stepsByCid[refToCid[st.ref]];
    var label = readString(step.label);
    var own = num(step.order, 0);
    var ctxFor = function (where: string): PillContext {
      return { inputNames: inputNames, refToCid: refToCid, stepsByCid: stepsByCid, ownOrder: own, where: where };
    };

    if (st.script !== undefined) {
      var si = scriptInput(step);
      if (!si) {
        fail("step '" + label + "' has no script input.");
      }
      si.value = st.script;
    }

    if (st.values) {
      var vals = st.values;
      Object.keys(vals).forEach(function (name) {
        var where = "step '" + st.ref + "' value '" + name + "'";
        var target = findByName(recList(step.inputs), name);
        if (!target) {
          fail(where + ": the " + st.type + " step has no input '" + name + "' (inputs: "
            + recList(step.inputs).map(function (i) {
              return readString(i.name);
            }).filter(function (n) {
              return n !== "script";
            }).join(", ") + ").");
        }
        var ctx = ctxFor(where);
        target.value = encodeStepValue(target, vals[name], function (s) {
          return resolvePills(s, ctx);
        }, displays, where);
      });
    }

    if (st.type === "script" && st.inputs) {
      var ins = recList(step.extended_inputs);
      var specInputs = st.inputs;
      Object.keys(specInputs).forEach(function (name) {
        var raw = specInputs[name];
        var vs: DefineStepVarSpec = typeof raw === "string" ? { value: raw } : raw;
        var hit = findByName(ins, name);
        if (vs.remove) {
          ins = ins.filter(function (e) {
            return e !== hit;
          });
          return;
        }
        if (!hit) {
          hit = clone(STEP_EXT_INPUT_TEMPLATE);
          hit.name = name;
          hit.label = vs.label || name;
          hit.type = "string";
          hit.type_label = TYPE_LABELS.string;
          hit.mandatory = false;
          hit.order = ins.length === 0 ? 0 : maxOrder(ins) + 100;
          hit.value = "";
          ins.push(hit);
        }
        if (vs.label !== undefined) {
          hit.label = vs.label;
        }
        if (vs.type !== undefined) {
          hit.type = vs.type;
          hit.type_label = TYPE_LABELS[vs.type];
        }
        if (vs.mandatory !== undefined) {
          hit.mandatory = vs.mandatory;
        }
        if (vs.value !== undefined) {
          hit.value = resolvePills(vs.value, ctxFor("step '" + st.ref + "' input '" + name + "'"));
        }
      });
      step.extended_inputs = ins;
    }
  });

  // 5. Action outputs (may read any step).
  var outputs = recList(model.outputs);
  (spec.outputs || []).forEach(function (o) {
    var hit = findByName(outputs, o.name);
    if (o.remove) {
      outputs = outputs.filter(function (e) {
        return e !== hit;
      });
      return;
    }
    if (!hit) {
      hit = clone(ACTION_OUTPUT_TEMPLATE);
      var uid = newUuid();
      hit.name = o.name;
      hit.pillName = o.name;
      hit.label = o.label || o.name;
      hit.pillLabel = hit.label;
      hit.type = "string";
      hit.type_label = TYPE_LABELS.string;
      hit.order = maxOrder(outputs) + 1;
      hit.uiUniqueId = uid;
      if (isRec(hit.attributes)) {
        hit.attributes.uiUniqueId = uid;
      }
      outputs.push(hit);
    }
    if (o.label !== undefined) {
      hit.label = o.label;
      if (Object.prototype.hasOwnProperty.call(hit, "pillLabel")) {
        hit.pillLabel = o.label;
      }
    }
    if (o.type !== undefined) {
      hit.type = o.type;
      hit.type_label = TYPE_LABELS[o.type];
    }
    if (o.value !== undefined) {
      var resolved = resolvePills(o.value, {
        inputNames: inputNames, refToCid: refToCid, stepsByCid: stepsByCid, ownOrder: null,
        where: "output '" + o.name + "'",
      });
      hit.value = resolved;
      hit.display_value = resolved;
    }
  });
  model.outputs = outputs;

  // 6. Nothing may be left pointing at a removed input or step.
  var danglingAfter = danglingPills(model, finalSteps).filter(function (d) {
    return danglingBefore.indexOf(d) === -1;
  });
  if (danglingAfter.length) {
    fail("the spec leaves dangling data pills: " + danglingAfter.join("; ")
      + ". Rewire or remove them in the same spec.");
  }
  danglingBefore.forEach(function (d) {
    warnings.push("pre-existing dangling pill (left as is): " + d);
  });

  upsertLabelCache(model, finalSteps);
  model.steps = finalSteps;

  var after = viewAction(model, finalSteps);
  var meta: Record<string, { ref: string; matchedBy?: string }> = {};
  specSteps.forEach(function (st) {
    var cid = refToCid[st.ref];
    if (cid) {
      var m = matchOf[st.ref];
      meta[cid] = { ref: st.ref, matchedBy: m ? m.by : undefined };
    }
  });
  var diff = diffViews(before, after, meta);
  return { body: model, before: before, after: after, diff: diff, stepRefs: refToCid, warnings: warnings };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Bare sys_ids given for a REST step's connection_alias — resolved to a display via sys_alias. */
function aliasSysIds(spec: DefineActionSpec): Array<string> {
  var ids: Array<string> = [];
  (spec.steps || []).forEach(function (st) {
    if (!st.values) {
      return;
    }
    var v = st.values.connection_alias;
    if (typeof v === "string" && RX_SYS_ID.test(v) && ids.indexOf(v) === -1) {
      ids.push(v);
    }
  });
  return ids;
}

async function resolveAliasDisplays(client: ServiceNowClient, ids: Array<string>): Promise<Record<string, string>> {
  var out: Record<string, string> = {};
  for (var i = 0; i < ids.length; i += 1) {
    var rows = await client.table.query<Record<string, unknown>>("sys_alias", "sys_id=" + ids[i], {
      limit: 1,
      fields: ["sys_id", "id", "name"],
    });
    if (!rows.length) {
      fail("connection_alias '" + ids[i] + "' — no sys_alias record with that sys_id.");
    }
    out[ids[i]] = readString(rows[0].id) || readString(rows[0].name);
  }
  return out;
}

function compareForVerify(expected: ActionView, actual: ActionView): DefineActionVerify {
  var notes: Array<string> = [];
  var d = diffViews(expected, actual, {});
  // Expected -> actual: any difference means the save did not land as planned.
  d.action.forEach(function (c) {
    notes.push("action." + c.field + " is '" + c.after + "', expected '" + c.before + "'");
  });
  d.inputs.added.forEach(function (n) {
    notes.push("unexpected input '" + n + "'");
  });
  d.inputs.removed.forEach(function (n) {
    notes.push("input '" + n + "' missing");
  });
  d.inputs.changed.forEach(function (c) {
    notes.push("input '" + c.name + "': " + c.changes.map(function (f) {
      return f.field + " '" + f.after + "' (expected '" + f.before + "')";
    }).join(", "));
  });
  d.outputs.added.forEach(function (n) {
    notes.push("unexpected output '" + n + "'");
  });
  d.outputs.removed.forEach(function (n) {
    notes.push("output '" + n + "' missing");
  });
  d.outputs.changed.forEach(function (c) {
    notes.push("output '" + c.name + "': " + c.changes.map(function (f) {
      return f.field + " '" + f.after + "' (expected '" + f.before + "')";
    }).join(", "));
  });
  d.steps.added.forEach(function (s) {
    notes.push("unexpected step '" + s.label + "' (" + s.cid + ")");
  });
  d.steps.removed.forEach(function (s) {
    notes.push("step '" + s.label + "' (" + s.cid + ") missing");
  });
  d.steps.changed.forEach(function (s) {
    notes.push("step '" + s.label + "': " + s.changes.join("; "));
  });
  if (notes.length === 0) {
    notes.push("read-back matches the planned definition");
  }
  return { ok: d.empty, notes: notes };
}

export async function defineActionType(params: DefineActionTypeParams): Promise<DefineActionTypeResult> {
  var client = params.client;
  var sysId = params.sysId;
  if (typeof sysId !== "string" || !RX_SYS_ID.test(sysId)) {
    fail("sysId must be a 32-char sys_id, got " + JSON.stringify(sysId) + ".");
  }
  var spec = validateDefineSpec(params.spec);
  var dry = params.confirm !== true || params.dryRun === true;

  var scope = await resolveScope(client, params.scope);
  var model = unwrapProcessflow(await client.now.get<unknown>(actionTypePath(sysId, scope.sysId, "")));
  if (!isRec(model)) {
    fail("unexpected GET model response for action type " + sysId + ".");
  }
  var modelScope = readString(model.scope);
  if (modelScope && modelScope !== scope.sysId) {
    fail("action " + sysId + " lives in scope " + modelScope + " ("
      + readString(model.scopename) + "), not " + scope.name + " (" + scope.sysId + ").");
  }
  var steps = await fetchActionSteps(client, sysId, scope.sysId);
  var displays = await resolveAliasDisplays(client, aliasSysIds(spec));

  var plan = planActionDefinition({
    model: model,
    steps: steps,
    spec: spec,
    sysId: sysId,
    referenceDisplays: displays,
  });

  var result: DefineActionTypeResult = {
    status: "planned",
    sysId: sysId,
    scope: scope,
    diff: plan.diff,
    stepRefs: plan.stepRefs,
    warnings: plan.warnings,
    before: plan.before,
    after: plan.after,
  };
  if (dry) {
    return result;
  }

  var publishSteps: Array<Record<string, unknown>> = steps as Array<Record<string, unknown>>;
  if (plan.diff.empty) {
    result.status = "unchanged";
  } else {
    if (params.updateSetSysId) {
      await client.claude.changeUpdateSet({ sysId: params.updateSetSysId });
    }
    var saved = unwrapProcessflow(await client.now.put<unknown>(actionTypePath(sysId, scope.sysId, ""), plan.body));
    result.status = "saved";
    result.saved = { state: isRec(saved) ? readString(saved.state) : "" };

    // Verify: read the definition back and compare with the plan.
    var freshModel = unwrapProcessflow(await client.now.get<unknown>(actionTypePath(sysId, scope.sysId, "")));
    var freshSteps = await fetchActionSteps(client, sysId, scope.sysId);
    if (!isRec(freshModel)) {
      result.verify = { ok: false, notes: ["read-back of the model failed — could not verify the save"] };
    } else {
      result.verify = compareForVerify(plan.after, viewAction(freshModel, recList(freshSteps)));
    }
    publishSteps = freshSteps.length > 0
      ? (freshSteps as Array<Record<string, unknown>>)
      : (isRec(saved) && Array.isArray(saved.steps) ? recList(saved.steps) : recList(plan.body.steps));
  }

  if (params.publish === true) {
    if (result.status === "unchanged" && readString(model.state) === "published") {
      result.warnings.push("publish skipped — nothing changed and the action is already published");
    } else {
      if (params.updateSetSysId && result.status === "unchanged") {
        await client.claude.changeUpdateSet({ sysId: params.updateSetSysId });
      }
      result.publish = await publishActionType({
        client: client,
        sysId: sysId,
        scopeSysId: scope.sysId,
        steps: publishSteps,
      });
    }
  }
  return result;
}
