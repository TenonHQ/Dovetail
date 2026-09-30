/**
 * Clone a Custom Action Type — pull the full record graph of a source
 * sys_hub_action_type_definition, mint fresh sys_ids, retarget the scope,
 * rename, write the graph through claude.createRecord pinned to the caller's
 * update set, then PUBLISH the clone headlessly (multi-step capable).
 *
 * Record graph (all reads via the Table API — sn_build_agent 401s on our
 * instances, so buildAgent is never touched):
 *
 *   sys_hub_action_type_definition            the parent
 *   ├─ sys_hub_action_input    (model_id → parent)
 *   ├─ sys_hub_action_output   (model_id → parent)
 *   └─ sys_hub_step_instance   (action   → parent)   ← NOT model_id
 *        ├─ sys_hub_step_ext_input   (model_id → step)
 *        └─ sys_hub_step_ext_output  (model_id → step)
 *
 * Plus two stores the action's IO depends on that are NOT FK children
 * (verified live on tenonworkstudio 2026-09-30):
 *
 *   sys_element_mapping   output → step-output wiring, one row per mapped output
 *                         (incl. __action_status__ / __dont_treat_as_error__):
 *                         id = action sys_id, table = var__m_sys_hub_action_output_<action>,
 *                         field = output element, value = the pill. Without these a
 *                         clone publishes with every output unmapped (runs, returns empty).
 *   sys_documentation     IO labels: name = var__m_sys_hub_action_{input,output}_<action>,
 *                         element, label, language. Without these Flow Designer shows the
 *                         element name as the label.
 *
 * Action IO rows are var_dictionary rows whose `name` IS their var__m table, so
 * the clone retargets `name` onto the new action's var__m table too.
 *
 * Publish reuses the proven snapshot path (publishActionType): the SOURCE
 * action's step graph is read from /step_instances, each step's `action` and
 * `sys_id` are remapped onto the clone (old→new sys_id map), optional StepOps
 * are applied (patchStepScripts / setStepInputs / addStepOutputs /
 * addStepInputs), and the result is grafted onto the clone's model and POSTed
 * to /snapshot. The steps are then read back and verified.
 *
 * DRY-RUN BY DEFAULT: without `confirm: true` it reads everything, builds the
 * full plan (records per table, step summary, stepOps effects) and writes
 * nothing. Idempotent: an existing (name, scope) returns "unchanged" with no
 * writes.
 *
 * Replaces the hand-rolled action-factory.cjs (single-step only, steps
 * fixture file, bespoke transport). Full write-up:
 * docs/servicenow-flow-designer-headless-authoring.md.
 */

import type { ServiceNowClient } from "../client";
import {
  generateSysId,
  stripSystemFields,
  applyScope,
  assertSysId,
} from "./shape";
import type { WriteOp, WriteOpResult } from "./writeOrder";
import { executeWritePlan } from "./writeOrder";
import { fetchActionSteps } from "./actionTypeApi";
import { publishActionType } from "./publishActionType";
import type { PublishActionTypeResult } from "./publishActionType";
import {
  applyStepOps,
  hasStepOps,
  readString,
  stepIdentity,
  summarizeSteps,
  verifySteps,
  writeField,
} from "./stepOps";
import type {
  IoEntry,
  StepOps,
  StepRecord,
  StepSummary,
  VerifyStepsResult,
} from "./stepOps";

export interface CloneActionTypeParams {
  client: ServiceNowClient;
  /** sys_id of the source sys_hub_action_type_definition. */
  sourceSysId: string;
  /** Display name of the clone. Idempotency key together with the target scope. */
  newName: string;
  /** internal_name of the clone. Default: slug of newName (lowercase, non-alphanumerics → "_"). */
  internalName?: string;
  /** Target scope — a 32-hex sys_scope sys_id OR a scope name (e.g. x_cadso_email_spok). */
  newScope: string;
  /** Update set every write (and the publish) is captured into. Required when confirm is true. */
  updateSetSysId?: string;
  /** Description for the clone. Wins over modifications.description. */
  description?: string;
  modifications?: {
    description?: string;
    /** Free-form patch applied last on top of the cloned + scoped parent. */
    fieldPatch?: Record<string, unknown>;
  };
  /** Per-step edits applied to the cloned step graph before publish. */
  stepOps?: StepOps;
  /** true executes (writes + publish). Omitted/false = dry-run: reads only, returns the plan. */
  confirm?: boolean;
  /** Forces a dry-run even with confirm. */
  dryRun?: boolean;
  /** Publish after writing (default true). buildFlowOrchestrator passes false — it publishes itself. */
  publish?: boolean;
}

export interface CloneActionTypePlan {
  /** Every record the clone writes, in plan order (parent first). */
  ops: Array<WriteOp>;
  /** Record count per table. */
  counts: Record<string, number>;
  total: number;
  /** Target scope, resolved to both identities. */
  scope: { sysId: string; name: string };
  /** Source scope sys_id — the transaction scope the source steps were read under. */
  sourceScopeSysId: string;
  /** Old → new sys_id for every cloned step instance. */
  stepIdMap: Record<string, string>;
  /**
   * The sys_documentation (label) ops inside `ops`. They are UPSERTED after the
   * graph is written (the dictionary insert may already have created the row),
   * not run through executeWritePlan.
   */
  labelOpIds: Array<string>;
}

export interface CloneActionTypeStepReport {
  /** Step summary of the cloned graph before stepOps. */
  before: Array<StepSummary>;
  /** Step summary as it will be (or was) published. */
  after: Array<StepSummary>;
  changes: Array<string>;
  warnings: Array<string>;
  /** cids of steps a stepOp actually changed. */
  touchedCids: Array<string>;
}

export interface CloneActionTypeResult {
  /** The clone's sys_id — planned (dry-run), created, or the existing one (unchanged). */
  sysId: string;
  internalName: string;
  action: "created" | "unchanged" | "planned";
  written: Array<WriteOpResult>;
  plan?: CloneActionTypePlan;
  publish?: PublishActionTypeResult;
  verify?: VerifyStepsResult;
  steps?: CloneActionTypeStepReport;
}

var ACTION_TABLE = "sys_hub_action_type_definition";
var INPUT_TABLE = "sys_hub_action_input";
var OUTPUT_TABLE = "sys_hub_action_output";
var STEP_TABLE = "sys_hub_step_instance";
var EXT_INPUT_TABLE = "sys_hub_step_ext_input";
var EXT_OUTPUT_TABLE = "sys_hub_step_ext_output";
var MAPPING_TABLE = "sys_element_mapping";
var LABEL_TABLE = "sys_documentation";

/** var_dictionary table name for a model's variables: var__m_<table>_<model sys_id>. */
export function varTableName(table: string, modelSysId: string): string {
  return "var__m_" + table + "_" + modelSysId;
}

/** The encoded query for an action's output → step-output mappings. */
export function outputMappingQuery(actionSysId: string): string {
  return "id=" + actionSysId + "^tableSTARTSWITH" + "var__m_" + OUTPUT_TABLE + "_";
}

/** Rows per child query. A full page means the read may be truncated — refuse rather than half-clone. */
var CHILD_LIMIT = 1000;

/**
 * Fields beyond shape.SYSTEM_FIELDS_TO_STRIP that must never carry over to a
 * clone: compiled-snapshot pointers (regenerated by publish), the source's
 * update-record name (would collide in sys_update_xml), compiler bookkeeping,
 * and copy lineage.
 */
var CLONE_EXTRA_STRIP = [
  "master_snapshot",
  "latest_snapshot",
  "master_snapshot_digest",
  "compiler_build",
  "authored_on_release_version",
  "copied_from",
  "copied_from_name",
  "sys_update_name",
];

var RX_SYS_ID = /^[0-9a-f]{32}$/;
var RX_SCOPE_NAME = /^[A-Za-z0-9_]+$/;
var RX_INTERNAL_NAME = /^[A-Za-z0-9_]+$/;

/** Slug for internal_name: lowercase, runs of non-alphanumerics → "_", trimmed of "_". */
export function slugInternalName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Flatten a Table API row: reference fields arrive as `{ link, value }` (no
 * sysparm_exclude_reference_link on table.query), null as null. createRecord
 * calls GlideRecord.setValue, which needs plain strings.
 */
function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  var out: Record<string, unknown> = {};
  var keys = Object.keys(row);
  for (var i = 0; i < keys.length; i++) {
    var v = row[keys[i]];
    if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "value")) {
      var inner = (v as Record<string, unknown>).value;
      out[keys[i]] = inner === null || inner === undefined ? "" : String(inner);
    } else if (v === null || v === undefined) {
      out[keys[i]] = "";
    } else {
      out[keys[i]] = v;
    }
  }
  return out;
}

/** Strip system + clone-only fields, retarget scope, and set a fresh sys_id. */
function cloneFields(row: Record<string, unknown>, scopeSysId: string, newSysId: string): Record<string, unknown> {
  var fields = stripSystemFields(flattenRow(row)) as Record<string, unknown>;
  for (var i = 0; i < CLONE_EXTRA_STRIP.length; i++) {
    delete fields[CLONE_EXTRA_STRIP[i]];
  }
  fields = applyScope(fields, scopeSysId);
  fields.sys_scope = scopeSysId;
  // A scoped app's sys_package IS its sys_scope row (sys_scope extends sys_package).
  if (Object.prototype.hasOwnProperty.call(fields, "sys_package")) {
    fields.sys_package = scopeSysId;
  }
  fields.sys_id = newSysId;
  return fields;
}

async function queryChildren(
  client: ServiceNowClient,
  table: string,
  query: string,
): Promise<Array<Record<string, unknown>>> {
  var rows = await client.table.query<Record<string, unknown>>(table, query, CHILD_LIMIT);
  if (rows.length >= CHILD_LIMIT) {
    throw new Error(
      "cloneActionType: " + table + " returned " + rows.length + " rows for '" + query
        + "' — the read may be truncated; refusing to write a partial clone.",
    );
  }
  return rows;
}

/**
 * Resolve a scope reference (32-hex sys_id or scope name) to both identities
 * via a sys_scope Table API read. Throws when it does not exist.
 */
export async function resolveScope(
  client: ServiceNowClient,
  ref: string,
): Promise<{ sysId: string; name: string }> {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("cloneActionType: a target scope (sys_id or scope name) is required.");
  }
  var isSysId = RX_SYS_ID.test(ref);
  if (!isSysId && !RX_SCOPE_NAME.test(ref)) {
    throw new Error(
      "cloneActionType: scope must be a 32-char sys_id or a scope name like x_cadso_core, got: "
        + JSON.stringify(ref),
    );
  }
  var rows = await client.table.query<Record<string, unknown>>(
    "sys_scope",
    (isSysId ? "sys_id=" : "scope=") + ref,
    { limit: 1, fields: ["sys_id", "scope"] },
  );
  if (!rows.length) {
    throw new Error("cloneActionType: sys_scope not found: " + ref);
  }
  var row = flattenRow(rows[0]);
  var sysId = String(row.sys_id || "");
  var name = String(row.scope || "");
  if (!RX_SYS_ID.test(sysId) || !name) {
    throw new Error("cloneActionType: sys_scope row for '" + ref + "' is missing sys_id/scope.");
  }
  return { sysId: sysId, name: name };
}

/**
 * The step's record id in the /step_instances payload. The live processflow
 * payload carries it as `step_id` (verified on tenonworkstudio 2026-09-30 — no
 * `sys_id` key at all); `sys_id` / `id` are kept as fallbacks for other shapes.
 */
function stepRecordId(step: StepRecord): { key: string; id: string } {
  var keys = ["step_id", "sys_id", "id"];
  for (var i = 0; i < keys.length; i++) {
    var id = readString(step[keys[i]]);
    if (id) {
      return { key: keys[i], id: id };
    }
  }
  return { key: "step_id", id: "" };
}

/**
 * Remap the SOURCE step graph onto the clone: each step's `action` → the new
 * parent and its `sys_id` → the new step (matched by source sys_id), plus any
 * extended IO entry id / model_id that points at a cloned record. Returns a
 * deep copy; throws when a step has no counterpart in the cloned records.
 */
export function remapClonedSteps(
  steps: Array<StepRecord>,
  newParentSysId: string,
  stepIdMap: Record<string, string>,
  idMap: Record<string, string>,
): Array<StepRecord> {
  var copy = JSON.parse(JSON.stringify(steps)) as Array<StepRecord>;
  var remapIfKnown = function (holder: Record<string, unknown>, key: string): void {
    if (!Object.prototype.hasOwnProperty.call(holder, key)) {
      return;
    }
    var current = readString(holder[key]);
    if (current && Object.prototype.hasOwnProperty.call(idMap, current)) {
      writeField(holder, key, idMap[current]);
    }
  };
  for (var i = 0; i < copy.length; i++) {
    var step = copy[i];
    var ref = stepRecordId(step);
    if (!ref.id || !Object.prototype.hasOwnProperty.call(stepIdMap, ref.id)) {
      throw new Error(
        "cloneActionType: step '" + stepIdentity(step).label + "' (" + (ref.id || "<no sys_id>")
          + ") from /step_instances has no cloned sys_hub_step_instance counterpart — cannot remap. "
          + "Cloned steps: " + (Object.keys(stepIdMap).join(", ") || "<none>"),
      );
    }
    writeField(step, ref.key, stepIdMap[ref.id]);
    if (Object.prototype.hasOwnProperty.call(step, "action")) {
      writeField(step, "action", newParentSysId);
    } else {
      step.action = newParentSysId;
    }
    var lists = ["extended_inputs", "extended_outputs"];
    for (var l = 0; l < lists.length; l++) {
      var list = step[lists[l]];
      if (!Array.isArray(list)) {
        continue;
      }
      for (var e = 0; e < list.length; e++) {
        var entry = list[e] as IoEntry;
        if (!entry || typeof entry !== "object") {
          continue;
        }
        remapIfKnown(entry, "sys_id");
        remapIfKnown(entry, "id");
        remapIfKnown(entry, "model_id");
      }
    }
  }
  return copy;
}

function countByTable(ops: Array<WriteOp>): Record<string, number> {
  var counts: Record<string, number> = {};
  for (var i = 0; i < ops.length; i++) {
    counts[ops[i].table] = (counts[ops[i].table] || 0) + 1;
  }
  return counts;
}

function allCids(steps: Array<StepRecord>): Array<string> {
  var out: Array<string> = [];
  for (var i = 0; i < steps.length; i++) {
    var cid = stepIdentity(steps[i]).cid;
    if (cid && out.indexOf(cid) === -1) {
      out.push(cid);
    }
  }
  return out;
}

export async function cloneActionType(opts: CloneActionTypeParams): Promise<CloneActionTypeResult> {
  if (!opts || !opts.client) {
    throw new Error("cloneActionType: client is required");
  }
  var client = opts.client;
  assertSysId(opts.sourceSysId, "sourceSysId");
  if (typeof opts.newName !== "string" || opts.newName.trim().length === 0) {
    throw new Error("cloneActionType: newName is required");
  }
  var newName = opts.newName.trim();
  // The name is interpolated into an encoded query — refuse the query operators.
  if (/[\^\r\n]/.test(newName)) {
    throw new Error("cloneActionType: newName must not contain '^' or line breaks.");
  }
  var internalName = opts.internalName !== undefined && opts.internalName !== null && opts.internalName !== ""
    ? String(opts.internalName)
    : slugInternalName(newName);
  if (!RX_INTERNAL_NAME.test(internalName)) {
    throw new Error(
      "cloneActionType: internalName must be letters, digits and underscores, got: " + JSON.stringify(internalName),
    );
  }
  var execute = opts.confirm === true && opts.dryRun !== true;
  if (execute) {
    assertSysId(opts.updateSetSysId, "updateSetSysId");
  }
  var shouldPublish = opts.publish !== false;
  var stepOps: StepOps = opts.stepOps || {};
  var stepOpsSupplied = hasStepOps(stepOps);

  var scope = await resolveScope(client, opts.newScope);

  // 1. Idempotency: an existing (name, scope) short-circuits with no writes.
  var existing = await client.table.query<Record<string, unknown>>(
    ACTION_TABLE,
    "name=" + newName + "^sys_scope=" + scope.sysId,
    { limit: 1, fields: ["sys_id", "internal_name"] },
  );
  if (existing.length > 0) {
    var hit = flattenRow(existing[0]);
    return {
      sysId: String(hit.sys_id || ""),
      internalName: String(hit.internal_name || internalName),
      action: "unchanged",
      written: [],
    };
  }

  // 2. Read the source graph (Table API only).
  var parents = await client.table.query<Record<string, unknown>>(ACTION_TABLE, "sys_id=" + opts.sourceSysId, 1);
  if (!parents.length) {
    throw new Error("cloneActionType: source " + ACTION_TABLE + " not found: " + opts.sourceSysId);
  }
  var sourceParent = flattenRow(parents[0]);
  var sourceScopeSysId = String(sourceParent.sys_scope || "");
  assertSysId(sourceScopeSysId, "source action sys_scope");

  var inputs = await queryChildren(client, INPUT_TABLE, "model_id=" + opts.sourceSysId);
  var outputs = await queryChildren(client, OUTPUT_TABLE, "model_id=" + opts.sourceSysId);
  var stepRows = await queryChildren(client, STEP_TABLE, "action=" + opts.sourceSysId);

  // 3. Build the write plan with fresh sys_ids and an old→new map.
  var newParentSysId = generateSysId();
  var idMap: Record<string, string> = {};
  var stepIdMap: Record<string, string> = {};
  idMap[opts.sourceSysId] = newParentSysId;

  var parentFields = cloneFields(sourceParent, scope.sysId, newParentSysId);
  parentFields.name = newName;
  parentFields.internal_name = internalName;
  parentFields.state = "draft";
  var description = opts.description !== undefined
    ? opts.description
    : (opts.modifications ? opts.modifications.description : undefined);
  if (description !== undefined && description !== null) {
    parentFields.description = description;
  }
  if (opts.modifications && opts.modifications.fieldPatch) {
    parentFields = Object.assign({}, parentFields, opts.modifications.fieldPatch);
  }

  var ops: Array<WriteOp> = [
    {
      id: "parent",
      logicalName: ACTION_TABLE + ":" + newName,
      table: ACTION_TABLE,
      fields: parentFields,
      dependsOn: [],
      scope: scope.name,
    },
  ];

  // element → plan op id, per IO table, so label/mapping ops can depend on their row.
  var ioOpByElement: Record<string, Record<string, string>> = {};
  ioOpByElement[INPUT_TABLE] = {};
  ioOpByElement[OUTPUT_TABLE] = {};

  var pushModelChildren = function (table: string, prefix: string, rows: Array<Record<string, unknown>>): void {
    for (var r = 0; r < rows.length; r++) {
      var src = flattenRow(rows[r]);
      var childSysId = generateSysId();
      idMap[String(src.sys_id || "")] = childSysId;
      var fields = cloneFields(src, scope.sysId, childSysId);
      fields.model_id = newParentSysId;
      retargetVarName(fields, table, opts.sourceSysId, newParentSysId);
      var element = String(src.element || "");
      if (element) {
        ioOpByElement[table][element] = prefix + ":" + r;
      }
      ops.push({
        id: prefix + ":" + r,
        logicalName: table + ":" + String(src.element || src.name || src.sys_id),
        table: table,
        fields: fields,
        dependsOn: ["parent"],
        scope: scope.name,
      });
    }
  };
  pushModelChildren(INPUT_TABLE, "input", inputs);
  pushModelChildren(OUTPUT_TABLE, "output", outputs);

  for (var s = 0; s < stepRows.length; s++) {
    var srcStep = flattenRow(stepRows[s]);
    var oldStepSysId = String(srcStep.sys_id || "");
    assertSysId(oldStepSysId, "source step sys_id");
    var newStepSysId = generateSysId();
    stepIdMap[oldStepSysId] = newStepSysId;
    idMap[oldStepSysId] = newStepSysId;
    var stepFields = cloneFields(srcStep, scope.sysId, newStepSysId);
    stepFields.action = newParentSysId;
    var stepOpId = "step:" + s;
    ops.push({
      id: stepOpId,
      logicalName: STEP_TABLE + ":" + String(srcStep.label || srcStep.name || oldStepSysId),
      table: STEP_TABLE,
      fields: stepFields,
      dependsOn: ["parent"],
      scope: scope.name,
    });

    var extSpecs = [
      { table: EXT_INPUT_TABLE, prefix: "ext_input" },
      { table: EXT_OUTPUT_TABLE, prefix: "ext_output" },
    ];
    for (var x = 0; x < extSpecs.length; x++) {
      var extRows = await queryChildren(client, extSpecs[x].table, "model_id=" + oldStepSysId);
      for (var e = 0; e < extRows.length; e++) {
        var srcExt = flattenRow(extRows[e]);
        var newExtSysId = generateSysId();
        idMap[String(srcExt.sys_id || "")] = newExtSysId;
        var extFields = cloneFields(srcExt, scope.sysId, newExtSysId);
        extFields.model_id = newStepSysId;
        retargetVarName(extFields, extSpecs[x].table, oldStepSysId, newStepSysId);
        ops.push({
          id: stepOpId + ":" + extSpecs[x].prefix + ":" + e,
          logicalName: extSpecs[x].table + ":" + String(srcExt.element || srcExt.name || srcExt.sys_id),
          table: extSpecs[x].table,
          fields: extFields,
          dependsOn: [stepOpId],
          scope: scope.name,
        });
      }
    }
  }

  // 3b. Output → step-output wiring (sys_element_mapping). Step cids survive the
  // clone, so field and value (the pill) carry over unchanged.
  var newOutputVarTable = varTableName(OUTPUT_TABLE, newParentSysId);
  var sourceMappings = await queryChildren(client, MAPPING_TABLE, outputMappingQuery(opts.sourceSysId));
  for (var mi = 0; mi < sourceMappings.length; mi++) {
    var srcMap = flattenRow(sourceMappings[mi]);
    var mapField = String(srcMap.field || "");
    var mapFields = cloneFields(srcMap, scope.sysId, generateSysId());
    mapFields.id = newParentSysId;
    mapFields.table = newOutputVarTable;
    // After the parent and its outputs (the matching output first), so a mapping never precedes the row it wires.
    var mapDeps = ["parent"];
    if (mapField && Object.prototype.hasOwnProperty.call(ioOpByElement[OUTPUT_TABLE], mapField)) {
      mapDeps.push(ioOpByElement[OUTPUT_TABLE][mapField]);
    }
    var outputOpIds = Object.keys(ioOpByElement[OUTPUT_TABLE]).map(function (el) { return ioOpByElement[OUTPUT_TABLE][el]; });
    for (var oi = 0; oi < outputOpIds.length; oi++) {
      if (mapDeps.indexOf(outputOpIds[oi]) === -1) {
        mapDeps.push(outputOpIds[oi]);
      }
    }
    ops.push({
      id: "mapping:" + mi,
      logicalName: MAPPING_TABLE + ":" + (mapField || String(srcMap.sys_id || mi)),
      table: MAPPING_TABLE,
      fields: mapFields,
      dependsOn: mapDeps,
      scope: scope.name,
    });
  }

  // 3c. IO labels (sys_documentation keyed on the var__m table), retargeted.
  var labelOps: Array<WriteOp> = [];
  var labelSpecs = [
    { table: INPUT_TABLE, prefix: "label:input" },
    { table: OUTPUT_TABLE, prefix: "label:output" },
  ];
  for (var li = 0; li < labelSpecs.length; li++) {
    var spec = labelSpecs[li];
    var srcVarTable = varTableName(spec.table, opts.sourceSysId);
    var newVarTable = varTableName(spec.table, newParentSysId);
    var labelRows = await queryChildren(client, LABEL_TABLE, "name=" + srcVarTable);
    for (var lr = 0; lr < labelRows.length; lr++) {
      var srcLabel = flattenRow(labelRows[lr]);
      var labelElement = String(srcLabel.element || "");
      if (!labelElement) {
        continue;
      }
      var labelFields = cloneFields(srcLabel, scope.sysId, generateSysId());
      labelFields.name = newVarTable;
      var labelDeps = ["parent"];
      if (Object.prototype.hasOwnProperty.call(ioOpByElement[spec.table], labelElement)) {
        labelDeps.push(ioOpByElement[spec.table][labelElement]);
      }
      labelOps.push({
        id: spec.prefix + ":" + lr,
        logicalName: LABEL_TABLE + ":" + newVarTable + "." + labelElement,
        table: LABEL_TABLE,
        fields: labelFields,
        dependsOn: labelDeps,
        scope: scope.name,
      });
    }
  }
  var allOps = ops.concat(labelOps);

  var plan: CloneActionTypePlan = {
    ops: allOps,
    counts: countByTable(allOps),
    total: allOps.length,
    scope: scope,
    sourceScopeSysId: sourceScopeSysId,
    stepIdMap: stepIdMap,
    labelOpIds: labelOps.map(function (o) { return o.id; }),
  };

  // 4. The publishable step graph: the SOURCE's /step_instances, remapped.
  var sourceSteps = await fetchActionSteps(client, opts.sourceSysId, sourceScopeSysId);
  if (sourceSteps.length === 0) {
    throw new Error(
      "cloneActionType: /step_instances returned no steps for source " + opts.sourceSysId
        + " — nothing to publish.",
    );
  }
  var remapped = remapClonedSteps(sourceSteps, newParentSysId, stepIdMap, idMap);
  var before = summarizeSteps(remapped);
  var finalSteps = remapped;
  var stepReport: CloneActionTypeStepReport = {
    before: before,
    after: before,
    changes: [],
    warnings: [],
    touchedCids: [],
  };
  if (stepOpsSupplied) {
    var applied = applyStepOps(remapped, stepOps);
    finalSteps = applied.steps;
    stepReport.after = summarizeSteps(finalSteps);
    stepReport.changes = applied.changes;
    stepReport.warnings = applied.warnings;
    stepReport.touchedCids = applied.touchedCids;
  }

  if (!execute) {
    return {
      sysId: newParentSysId,
      internalName: internalName,
      action: "planned",
      written: [],
      plan: plan,
      steps: stepReport,
    };
  }

  // 5. Write the graph, pinned to the update set.
  var updateSetSysId = opts.updateSetSysId as string;
  var written = await executeWritePlan(client, ops, updateSetSysId);
  // Labels last: the IO dictionary inserts above may already have created a
  // sys_documentation row for the new var__m table, so upsert rather than duplicate.
  for (var lw = 0; lw < labelOps.length; lw++) {
    written.push(await upsertLabel(client, labelOps[lw], updateSetSysId));
  }

  var result: CloneActionTypeResult = {
    sysId: newParentSysId,
    internalName: internalName,
    action: "created",
    written: written,
    plan: plan,
    steps: stepReport,
  };
  if (!shouldPublish) {
    return result;
  }

  // 6. Publish: pin the update set so the snapshot is captured, then POST /snapshot.
  try {
    await client.claude.changeUpdateSet({ sysId: updateSetSysId });
    result.publish = await publishActionType({
      client: client,
      sysId: newParentSysId,
      scopeSysId: scope.sysId,
      steps: finalSteps,
    });
  } catch (err: unknown) {
    var msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      "cloneActionType: " + written.length + " record(s) written (parent " + newParentSysId
        + ", update set " + updateSetSysId + ") but publish failed: " + msg,
    );
  }

  // 7. Verify — a 201 means "compiled", not "landed as sent". Read the clone's steps back.
  var fresh = await fetchActionSteps(client, newParentSysId, scope.sysId);
  var verify: VerifyStepsResult;
  if (fresh.length === 0) {
    verify = { ok: false, notes: ["read-back returned no steps — could not verify the publish"] };
  } else {
    var expected = stepReport.after;
    verify = verifySteps(expected, summarizeSteps(fresh), allCids(finalSteps));
    if (fresh.length !== finalSteps.length) {
      verify.ok = false;
      verify.notes.push(
        "step count on the instance is " + fresh.length + ", expected " + finalSteps.length,
      );
    }
  }

  // Output mappings: every source mapping must exist on the clone, or its outputs come back empty.
  var cloneMappings = await queryChildren(client, MAPPING_TABLE, outputMappingQuery(newParentSysId));
  var mappingCheck = verifyOutputMappings(sourceMappings, cloneMappings);
  if (!mappingCheck.ok) {
    verify.ok = false;
  }
  for (var vn = 0; vn < mappingCheck.notes.length; vn++) {
    verify.notes.push(mappingCheck.notes[vn]);
  }
  result.verify = verify;
  return result;
}

/**
 * Set `name` on a cloned var_dictionary row (action IO / step ext IO) to the
 * clone's var__m table — but only when it named the SOURCE model's var__m table
 * exactly; anything else is left as it was.
 */
export function retargetVarName(
  fields: Record<string, unknown>,
  table: string,
  oldModelSysId: string,
  newModelSysId: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(fields, "name")) {
    return;
  }
  if (String(fields.name) === varTableName(table, oldModelSysId)) {
    fields.name = varTableName(table, newModelSysId);
  }
}

/**
 * Compare the source action's output mappings with the clone's, by `field`.
 * A source field absent on the clone fails; a differing value is noted but does
 * not fail (publish may legitimately normalise a pill).
 */
export function verifyOutputMappings(
  sourceRows: Array<Record<string, unknown>>,
  cloneRows: Array<Record<string, unknown>>,
): { ok: boolean; notes: Array<string> } {
  var cloneByField: Record<string, string> = {};
  for (var c = 0; c < cloneRows.length; c++) {
    var cr = flattenRow(cloneRows[c]);
    var cf = String(cr.field || "");
    if (cf) {
      cloneByField[cf] = String(cr.value === undefined || cr.value === null ? "" : cr.value);
    }
  }
  var missing: Array<string> = [];
  var notes: Array<string> = [];
  for (var s = 0; s < sourceRows.length; s++) {
    var sr = flattenRow(sourceRows[s]);
    var sf = String(sr.field || "");
    if (!sf) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cloneByField, sf)) {
      missing.push(sf);
      continue;
    }
    var sv = String(sr.value === undefined || sr.value === null ? "" : sr.value);
    if (cloneByField[sf] !== sv) {
      notes.push("output mapping '" + sf + "' differs on the clone: '" + cloneByField[sf] + "' (source '" + sv + "')");
    }
  }
  if (missing.length > 0) {
    notes.unshift(
      missing.length + " output mapping(s) missing on the clone (" + MAPPING_TABLE + "): " + missing.join(", "),
    );
  } else if (sourceRows.length > 0) {
    notes.unshift("all " + sourceRows.length + " output mapping(s) present on the clone");
  }
  return { ok: missing.length === 0, notes: notes };
}

/**
 * Write one cloned sys_documentation row: update the existing (name, element,
 * language) row on the target if the platform already made one, else create it.
 */
async function upsertLabel(
  client: ServiceNowClient,
  op: WriteOp,
  updateSetSysId: string,
): Promise<WriteOpResult> {
  var f = op.fields;
  var keyParts = [String(f.name), String(f.element || ""), String(f.language || "")];
  for (var k = 0; k < keyParts.length; k++) {
    if (/[\^\r\n]/.test(keyParts[k])) {
      throw new Error("cloneActionType: label key " + JSON.stringify(keyParts[k]) + " contains '^' or a line break.");
    }
  }
  var query = "name=" + keyParts[0] + "^element=" + keyParts[1];
  if (keyParts[2] !== "") {
    query += "^language=" + keyParts[2];
  }
  try {
    var hits = await client.table.query<Record<string, unknown>>(LABEL_TABLE, query, { limit: 1, fields: ["sys_id"] });
    var existingSysId = hits.length > 0 ? String(flattenRow(hits[0]).sys_id || "") : "";
    if (RX_SYS_ID.test(existingSysId)) {
      var update: Record<string, unknown> = Object.assign({}, f);
      delete update.sys_id;
      await client.claude.pushWithUpdateSet({
        update_set_sys_id: updateSetSysId,
        table: LABEL_TABLE,
        record_sys_id: existingSysId,
        fields: update,
      });
      return { id: op.id, logicalName: op.logicalName, table: op.table, sysId: existingSysId, action: "updated" };
    }
    var created = await client.claude.createRecord({
      table: op.table,
      fields: f,
      scope: op.scope,
      update_set_sys_id: updateSetSysId,
      sys_id: String(f.sys_id),
    });
    return {
      id: op.id,
      logicalName: op.logicalName,
      table: op.table,
      sysId: created.sys_id ? String(created.sys_id) : String(f.sys_id),
      action: "created",
    };
  } catch (err: unknown) {
    var msg = err instanceof Error ? err.message : String(err);
    throw new Error("cloneActionType: label write failed at op '" + op.id + "' (" + op.table + "): " + msg);
  }
}
