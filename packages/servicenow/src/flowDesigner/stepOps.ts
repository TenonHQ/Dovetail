/**
 * Step-graph operations for a Custom Action Type — the pure half of `editActionType`.
 *
 * Everything here operates on the `steps` array returned by
 * `GET /api/now/processflow/action/action_types/{id}/step_instances`. No client,
 * no network: the step graph goes in, a patched copy comes out, and the caller
 * grafts it onto the model and POSTs `/snapshot`.
 *
 * Two facts about that payload were established against a live instance and are
 * enforced here, because getting either wrong corrupts the action type in a way
 * the publish POST happily accepts:
 *
 * 1. STEP-TO-STEP DATA PILL FORMAT — `{{step[<source_cid>].<output_name>}}`.
 *    NOT `{{<cid>.<name>}}`, which is what the flow-variable pill syntax suggests.
 *    A wrong pill does not fail the publish; it compiles a snapshot with a dead
 *    reference, and the action silently reads `undefined` at runtime.
 *
 * 2. NEW IO ENTRIES MUST MIRROR AN EXISTING SIBLING — an `extended_inputs` /
 *    `extended_outputs` entry carries more keys than the four you care about, and
 *    some are wrapped as `{value: x}` while others are bare, inconsistently by key.
 *    So a new entry is a deep copy of an existing entry from the SAME list with
 *    only our keys overwritten, preserving each key's wrapped-vs-bare shape.
 *    When the list is empty there is no shape to mirror and we refuse rather than
 *    guess — a clear error beats a corrupted action type.
 *
 * Full write-up: docs/servicenow-flow-designer-headless-authoring.md.
 */

/** A step's field value: either bare, or wrapped by the Designer as `{ value: x }`. */
export type StepScalar = string | number | boolean | null;

/** One entry in a step's `inputs` / `extended_inputs` / `extended_outputs` list. */
export interface IoEntry {
  [key: string]: unknown;
}

/** One step from `/step_instances`. */
export interface StepRecord {
  [key: string]: unknown;
}

export interface PatchStepScriptOp {
  /** Step to patch — its `cid`, or its `label`/`name`. */
  step: string;
  /** Replace the script outright (wins over patchScript). */
  setScript?: string;
  /** Replace every occurrence of `find` with `replace` inside the script. */
  patchScript?: { find: string; replace: string };
  /** Input name holding the script. Default: auto-detect (`script`, else by signature). */
  scriptInputName?: string;
}

export interface AddStepOutputOp {
  /** Step to add the output to — its `cid`, or its `label`/`name`. */
  step: string;
  name: string;
  label?: string;
  /** ServiceNow variable type. Default: "boolean". */
  type?: string;
}

export interface AddStepInputOp {
  /** Step to add the input to — its `cid`, or its `label`/`name`. */
  step: string;
  name: string;
  label?: string;
  /** ServiceNow variable type. Default: "boolean". */
  type?: string;
  /** Wire the input's value to another step's output via a data pill. */
  pillFrom: { step: string; output: string };
}

export interface StepOps {
  patchStepScripts?: Array<PatchStepScriptOp>;
  addStepOutputs?: Array<AddStepOutputOp>;
  addStepInputs?: Array<AddStepInputOp>;
}

export interface StepIoSummary {
  name: string;
  type: string;
  value: string;
}

export interface StepSummary {
  label: string;
  cid: string;
  scriptChars: number | null;
  extendedInputs: Array<StepIoSummary>;
  extendedOutputs: Array<StepIoSummary>;
}

export interface ApplyStepOpsResult {
  /** A patched deep copy — the input graph is never mutated. */
  steps: Array<StepRecord>;
  changes: Array<string>;
  warnings: Array<string>;
  /** cids of the steps an op actually changed — what the verify pass re-reads. */
  touchedCids: Array<string>;
}

export interface VerifyStepsResult {
  ok: boolean;
  notes: Array<string>;
}

/** Names we write into a pill or an entry key — anything else breaks the payload. */
var SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var SCRIPT_SIGNATURE = /function execute|inputs\.|outputs\./;

/** Keys that hold an entry's identifier, across the shapes the Designer emits. */
var NAME_KEYS = ["name", "element"];
var TYPE_KEYS = ["type", "internal_type"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Unwrap the Designer's `{ value: x }` envelope; pass anything else through. */
export function unwrapValue(v: unknown): unknown {
  if (isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, "value")) {
    return v.value;
  }
  return v;
}

/** Coerce an unwrapped field to a string ("" for null/undefined/objects). */
export function readString(v: unknown): string {
  var raw = unwrapValue(v);
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  return "";
}

/**
 * Write `next` into a field, preserving its wrapped-vs-bare shape. Handles the
 * doubly-wrapped `{ value: { value: x } }` an input's `value` sometimes carries.
 */
function writeField(holder: Record<string, unknown>, key: string, next: StepScalar): void {
  var current = holder[key];
  if (isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, "value")) {
    var inner = current.value;
    if (isPlainObject(inner) && Object.prototype.hasOwnProperty.call(inner, "value")) {
      inner.value = next;
      return;
    }
    current.value = next;
    return;
  }
  holder[key] = next;
}

/** A step's addressable identity: its `cid` and its human label. */
export function stepIdentity(step: StepRecord): { cid: string; label: string } {
  var label = readString(step.label);
  if (!label) {
    label = readString(step.name);
  }
  return { cid: readString(step.cid), label: label };
}

/** Find a step by `cid` or by `label`/`name`. Throws listing what IS there. */
export function findStep(steps: Array<StepRecord>, ref: string): StepRecord {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("stepOps: step reference must be a non-empty cid or label.");
  }
  for (var i = 0; i < steps.length; i += 1) {
    var id = stepIdentity(steps[i]);
    if (id.cid === ref || id.label === ref) {
      return steps[i];
    }
  }
  var have = steps.map(function (s) {
    var id = stepIdentity(s);
    return id.label + " (" + id.cid + ")";
  }).join(" | ");
  throw new Error("stepOps: step not found: '" + ref + "'. Steps on this action: " + (have || "<none>"));
}

/** Locate the input holding a step's script — by name, else by script signature. */
export function findScriptInput(step: StepRecord, inputName?: string): IoEntry | null {
  var inputs = Array.isArray(step.inputs) ? (step.inputs as Array<IoEntry>) : [];
  for (var i = 0; i < inputs.length; i += 1) {
    var input = inputs[i];
    if (!isPlainObject(input)) {
      continue;
    }
    if (inputName) {
      if (readString(input.name) === inputName) {
        return input;
      }
      continue;
    }
    if (readString(input.name) === "script") {
      return input;
    }
  }
  if (inputName) {
    return null;
  }
  // No input literally named `script` — fall back to the one that reads like one.
  for (var s = 0; s < inputs.length; s += 1) {
    var candidate = inputs[s];
    if (!isPlainObject(candidate)) {
      continue;
    }
    var value = readString(candidate.value);
    if (value.length > 30 && SCRIPT_SIGNATURE.test(value)) {
      return candidate;
    }
  }
  return null;
}

/** Format a step-to-step data pill. THE format — see the header note. */
export function formatStepPill(sourceCid: string, outputName: string): string {
  return "{{step[" + sourceCid + "]." + outputName + "}}";
}

function typeLabelFor(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function nextOrder(list: Array<IoEntry>): number {
  var max = 0;
  for (var i = 0; i < list.length; i += 1) {
    var parsed = parseInt(readString(list[i].order), 10);
    if (!isNaN(parsed) && parsed > max) {
      max = parsed;
    }
  }
  return max + 1;
}

function entryNamed(list: Array<IoEntry>, name: string): IoEntry | null {
  for (var i = 0; i < list.length; i += 1) {
    for (var k = 0; k < NAME_KEYS.length; k += 1) {
      if (readString(list[i][NAME_KEYS[k]]) === name) {
        return list[i];
      }
    }
  }
  return null;
}

/** Read/create a step's `extended_inputs` / `extended_outputs` list in place. */
function ioList(step: StepRecord, key: "extended_inputs" | "extended_outputs"): Array<IoEntry> {
  if (!Array.isArray(step[key])) {
    step[key] = [];
  }
  return step[key] as Array<IoEntry>;
}

/**
 * Build a new IO entry by mirroring an existing sibling's key shape (invariant 2).
 * `value` is the pill for an input, "" for an output.
 */
function mirrorIoEntry(
  list: Array<IoEntry>,
  spec: { name: string; label?: string; type?: string; value: string },
  stepLabel: string,
  listKey: string
): IoEntry {
  if (list.length === 0) {
    throw new Error(
      "stepOps: cannot add '" + spec.name + "' — step '" + stepLabel + "' has no existing "
        + listKey + " entry to mirror, and the entry shape must not be guessed. "
        + "Author one entry in the Designer first, then re-run."
    );
  }

  var type = spec.type || "boolean";
  var template = JSON.parse(JSON.stringify(list[0])) as IoEntry;
  var order = nextOrder(list);
  var keys = Object.keys(template);

  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (NAME_KEYS.indexOf(key) !== -1) {
      writeField(template, key, spec.name);
    } else if (key === "label") {
      writeField(template, key, spec.label || spec.name);
    } else if (TYPE_KEYS.indexOf(key) !== -1) {
      writeField(template, key, type);
    } else if (key === "type_label") {
      writeField(template, key, typeLabelFor(type));
    } else if (key === "order") {
      writeField(template, key, order);
    } else if (key === "mandatory") {
      writeField(template, key, false);
    } else if (key === "sys_id" || key === "id") {
      // A fresh entry must not inherit the sibling's record identity.
      writeField(template, key, "");
    } else if (key === "value" || key === "default_value") {
      writeField(template, key, spec.value);
    }
    // Every other key keeps the sibling's value — that is the point of mirroring.
  }
  return template;
}

/** Reject names that would break a pill or an entry key. Ops are untrusted input. */
function assertSafeName(name: unknown, what: string): string {
  if (typeof name !== "string" || !SAFE_NAME.test(name)) {
    throw new Error(
      "stepOps: invalid " + what + " '" + String(name) + "' — must match " + String(SAFE_NAME) + "."
    );
  }
  return name;
}

/** A compact, loggable view of a step's scripts and step-level IO. */
export function summarizeSteps(steps: Array<StepRecord>): Array<StepSummary> {
  return steps.map(function (step) {
    var id = stepIdentity(step);
    var scriptInput = findScriptInput(step);
    var summarize = function (key: "extended_inputs" | "extended_outputs"): Array<StepIoSummary> {
      var list = Array.isArray(step[key]) ? (step[key] as Array<IoEntry>) : [];
      return list.map(function (entry) {
        return {
          name: readString(entry.name) || readString(entry.element),
          type: readString(entry.type) || readString(entry.internal_type),
          value: readString(entry.value)
        };
      });
    };
    return {
      label: id.label,
      cid: id.cid,
      scriptChars: scriptInput ? readString(scriptInput.value).length : null,
      extendedInputs: summarize("extended_inputs"),
      extendedOutputs: summarize("extended_outputs")
    };
  });
}

/**
 * Apply per-step ops to a DEEP COPY of the step graph.
 *
 * Outputs are added before inputs, so an input may pill from an output created in
 * the same call — everything lands in one `/snapshot` POST.
 */
export function applyStepOps(steps: Array<StepRecord>, ops: StepOps): ApplyStepOpsResult {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("stepOps: no steps to operate on.");
  }

  var patched = JSON.parse(JSON.stringify(steps)) as Array<StepRecord>;
  var changes: Array<string> = [];
  var warnings: Array<string> = [];
  var touched: Array<string> = [];
  var markTouched = function (step: StepRecord): void {
    var cid = stepIdentity(step).cid;
    if (cid && touched.indexOf(cid) === -1) {
      touched.push(cid);
    }
  };

  // 1. Scripts.
  var scriptOps = ops.patchStepScripts || [];
  for (var s = 0; s < scriptOps.length; s += 1) {
    var op = scriptOps[s];
    var step = findStep(patched, op.step);
    var label = stepIdentity(step).label;
    var input = findScriptInput(step, op.scriptInputName);
    if (!input) {
      warnings.push(
        "step '" + label + "': no script input found"
          + (op.scriptInputName ? " named '" + op.scriptInputName + "'" : " (auto-detect)")
          + " — skipped"
      );
      continue;
    }
    var before = readString(input.value);
    var after: string;
    if (typeof op.setScript === "string") {
      after = op.setScript;
    } else if (op.patchScript) {
      if (before.indexOf(op.patchScript.find) === -1) {
        warnings.push("step '" + label + "': patchScript.find not present — skipped: " + op.patchScript.find);
        continue;
      }
      after = before.split(op.patchScript.find).join(op.patchScript.replace);
    } else {
      warnings.push("step '" + label + "': neither setScript nor patchScript supplied — skipped");
      continue;
    }
    if (after === before) {
      warnings.push("step '" + label + "': script unchanged — skipped");
      continue;
    }
    writeField(input, "value", after);
    markTouched(step);
    changes.push("step '" + label + "': script " + before.length + " -> " + after.length + " chars");
  }

  // 2. Step-level outputs (before inputs — an input may pill from one of these).
  var outputOps = ops.addStepOutputs || [];
  for (var o = 0; o < outputOps.length; o += 1) {
    var outOp = outputOps[o];
    var outName = assertSafeName(outOp.name, "output name");
    var outStep = findStep(patched, outOp.step);
    var outLabel = stepIdentity(outStep).label;
    var outputs = ioList(outStep, "extended_outputs");
    if (entryNamed(outputs, outName)) {
      warnings.push("step '" + outLabel + "': output '" + outName + "' already present — skipped");
      continue;
    }
    outputs.push(mirrorIoEntry(
      outputs,
      { name: outName, label: outOp.label, type: outOp.type, value: "" },
      outLabel,
      "extended_outputs"
    ));
    markTouched(outStep);
    changes.push("step '" + outLabel + "': +output '" + outName + "' (" + (outOp.type || "boolean") + ")");
  }

  // 3. Step-level inputs, pill-wired to a source step's output.
  var inputOps = ops.addStepInputs || [];
  for (var n = 0; n < inputOps.length; n += 1) {
    var inOp = inputOps[n];
    var inName = assertSafeName(inOp.name, "input name");
    if (!inOp.pillFrom || typeof inOp.pillFrom !== "object") {
      throw new Error("stepOps: addStepInputs '" + inName + "' requires pillFrom {step, output}.");
    }
    var pillOutput = assertSafeName(inOp.pillFrom.output, "pillFrom.output");
    var inStep = findStep(patched, inOp.step);
    var inLabel = stepIdentity(inStep).label;
    var sourceStep = findStep(patched, inOp.pillFrom.step);
    var sourceId = stepIdentity(sourceStep);
    if (!sourceId.cid) {
      throw new Error("stepOps: source step '" + inOp.pillFrom.step + "' has no cid — cannot build a data pill.");
    }

    var sourceOutputs = Array.isArray(sourceStep.extended_outputs)
      ? (sourceStep.extended_outputs as Array<IoEntry>)
      : [];
    if (!entryNamed(sourceOutputs, pillOutput)) {
      // Not fatal — the publish accepts it — but it is a dead pill at runtime, so say so loudly.
      warnings.push(
        "step '" + inLabel + "': pillFrom output '" + pillOutput + "' is not an extended_output of '"
          + sourceId.label + "' — the pill will resolve to undefined at runtime"
      );
    }

    var inputs = ioList(inStep, "extended_inputs");
    if (entryNamed(inputs, inName)) {
      warnings.push("step '" + inLabel + "': input '" + inName + "' already present — skipped");
      continue;
    }
    var pill = formatStepPill(sourceId.cid, pillOutput);
    inputs.push(mirrorIoEntry(
      inputs,
      { name: inName, label: inOp.label, type: inOp.type, value: pill },
      inLabel,
      "extended_inputs"
    ));
    markTouched(inStep);
    changes.push("step '" + inLabel + "': +input '" + inName + "' <- " + pill);
  }

  return { steps: patched, changes: changes, warnings: warnings, touchedCids: touched };
}

/**
 * Compare what we published against what the instance now reports, for the steps
 * we touched. A 201 from `/snapshot` means "snapshot compiled", NOT "your edit
 * landed the way you meant it" — so read the steps back and prove it.
 */
export function verifySteps(
  expected: Array<StepSummary>,
  actual: Array<StepSummary>,
  touchedCids: Array<string>
): VerifyStepsResult {
  var notes: Array<string> = [];
  var ok = true;
  var byCid = function (list: Array<StepSummary>, cid: string): StepSummary | null {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].cid === cid) {
        return list[i];
      }
    }
    return null;
  };
  var names = function (list: Array<StepIoSummary>): Array<string> {
    return list.map(function (e) { return e.name; });
  };

  for (var t = 0; t < touchedCids.length; t += 1) {
    var cid = touchedCids[t];
    var want = byCid(expected, cid);
    var got = byCid(actual, cid);
    if (!want) {
      continue;
    }
    if (!got) {
      ok = false;
      notes.push("MISSING step '" + want.label + "' (" + cid + ") on read-back");
      continue;
    }
    var failures: Array<string> = [];
    if (want.scriptChars !== got.scriptChars) {
      failures.push(
        "script is " + String(got.scriptChars) + " chars on the instance, expected " + String(want.scriptChars)
      );
    }
    var missingIo = function (kind: string, wantIo: Array<StepIoSummary>, gotIo: Array<StepIoSummary>): void {
      var gotNames = names(gotIo);
      for (var i = 0; i < wantIo.length; i += 1) {
        if (gotNames.indexOf(wantIo[i].name) === -1) {
          failures.push(kind + " '" + wantIo[i].name + "' absent on read-back");
        }
      }
    };
    missingIo("extended_output", want.extendedOutputs, got.extendedOutputs);
    missingIo("extended_input", want.extendedInputs, got.extendedInputs);

    if (failures.length > 0) {
      ok = false;
      for (var f = 0; f < failures.length; f += 1) {
        notes.push("step '" + want.label + "': " + failures[f]);
      }
    } else {
      notes.push("step '" + want.label + "' verified on the instance");
    }
  }

  if (touchedCids.length === 0) {
    notes.push("no steps touched — nothing to verify");
  }
  return { ok: ok, notes: notes };
}

/** True when `ops` carries at least one per-step op. */
export function hasStepOps(ops: StepOps): boolean {
  return Boolean(
    (ops.patchStepScripts && ops.patchStepScripts.length > 0)
      || (ops.addStepOutputs && ops.addStepOutputs.length > 0)
      || (ops.addStepInputs && ops.addStepInputs.length > 0)
  );
}
