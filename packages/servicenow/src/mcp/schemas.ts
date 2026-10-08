/**
 * Zod input schemas for the dovetail-servicenow MCP tools. Schemas live in their
 * own file so registry.ts stays focused on wiring.
 */

import { z } from "zod";

export var createViewSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  updateSetSysId: z.string().min(1),
  scope: z.string().optional(),
  dryRun: z.boolean().optional(),
});

export var setListLayoutSchema = z.object({
  table: z.string().min(1),
  view: z.string().optional(),
  columns: z.array(z.string().min(1)).min(1),
  parent: z.string().optional(),
  updateSetSysId: z.string().min(1),
  scope: z.string().optional(),
  prune: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export var formSectionSchema = z.object({
  caption: z.string().optional(),
  fields: z.array(z.string().min(1)),
});

export var setFormLayoutSchema = z.object({
  table: z.string().min(1),
  view: z.string().optional(),
  sections: z.array(formSectionSchema).min(1),
  updateSetSysId: z.string().min(1),
  scope: z.string().optional(),
  prune: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export var setRelatedListsSchema = z.object({
  table: z.string().min(1),
  view: z.string().optional(),
  relatedLists: z.array(z.string().min(1)).min(1),
  updateSetSysId: z.string().min(1),
  scope: z.string().optional(),
  prune: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export var choiceValueSchema = z.object({
  value: z.string(),
  label: z.string(),
  sequence: z.number().optional(),
  language: z.string().optional(),
});

export var addChoicesToFieldSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  choices: z.array(choiceValueSchema).min(1),
  updateSetSysId: z.string().min(1),
  choiceType: z
    .union([z.literal(0), z.literal(1), z.literal(3)])
    .nullable()
    .optional(),
  /** Plan only: reads happen, no sys_choice / sys_dictionary write is sent. */
  dryRun: z.boolean().optional(),
});

export var removeChoicesFromFieldSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  values: z.array(z.string().min(1)).min(1),
  language: z.string().min(1).optional(),
  updateSetSysId: z.string().min(1),
  /** Plan only: reads happen, no inactive=true write is sent. */
  dryRun: z.boolean().optional(),
});

export var viewFlowSchema = z.object({
  sysId: z.string().min(1),
  raw: z.boolean().optional(),
});

export var viewActionSchema = z.object({
  sysId: z.string().min(1),
  scopeSysId: z.string().min(1),
  raw: z.boolean().optional(),
});

export var publishFlowSchema = z.object({
  sysId: z.string().min(1),
  scopeSysId: z.string().optional(),
});

export var copyFlowSchema = z.object({
  sourceSysId: z.string().min(1),
  newName: z.string().min(1),
  scopeSysId: z.string().optional(),
});

export var createFlowSchema = z.object({
  name: z.string().min(1),
  templateSysId: z.string().min(1),
  scopeSysId: z.string().min(1),
  internalName: z.string().optional(),
  description: z.string().optional(),
  triggerTable: z.string().optional(),
  triggerCondition: z.string().optional(),
  logMessage: z.string().optional(),
  dryRun: z.boolean().optional(),
});

export var testFlowSchema = z.object({
  sysId: z.string().min(1),
  mode: z.union([z.literal("validate"), z.literal("execute")]).optional(),
  inputs: z.record(z.any()).optional(),
  confirm: z.boolean().optional(),
  runnerPath: z.string().optional(),
});

export var stepInputPatchSchema = z.object({
  step: z.string().min(1),
  input: z.string().min(1),
  value: z.any(),
});

/** A step is addressed by its cid or its label. */
var stepRefSchema = z.string().min(1);

/** Set an EXISTING step input's value, e.g. a REST step's http_method. */
var setStepInputSchema = z.object({
  step: stepRefSchema,
  input: z.string().min(1),
  value: z.string(),
});

export var editActionSchema = z.object({
  sysId: z.string().min(1),
  scopeSysId: z.string().min(1),
  ops: z.object({
    patchStepScripts: z
      .array(
        z.object({
          step: stepRefSchema,
          setScript: z.string().optional(),
          patchScript: z
            .object({
              find: z.string().min(1),
              replace: z.string(),
            })
            .optional(),
          scriptInputName: z.string().optional(),
        }),
      )
      .optional(),
    setStepInputs: z.array(setStepInputSchema).optional(),
    addStepOutputs: z
      .array(
        z.object({
          step: stepRefSchema,
          name: z.string().min(1),
          label: z.string().optional(),
          type: z.string().optional(),
        }),
      )
      .optional(),
    addStepInputs: z
      .array(
        z.object({
          step: stepRefSchema,
          name: z.string().min(1),
          label: z.string().optional(),
          type: z.string().optional(),
          pillFrom: z.object({
            step: stepRefSchema,
            output: z.string().min(1),
          }),
        }),
      )
      .optional(),
    patchScript: z
      .object({
        find: z.string().min(1),
        replace: z.string(),
      })
      .optional(),
    setScript: z.string().optional(),
    mergeOutputs: z.array(z.record(z.unknown())).optional(),
    scriptInputName: z.string().optional(),
  }),
  /** Default false — dry-run. Only true republishes. */
  apply: z.boolean().optional(),
  updateSetSysId: z.string().optional(),
});

/**
 * action_clone — clone a Custom Action Type into a scope and publish it.
 * Mirrors the dove-sn clone-action flags; ops is the inline StepOps object.
 */
export var cloneActionSchema = z.object({
  /** Source sys_hub_action_type_definition sys_id. */
  from: z.string().regex(/^[0-9a-f]{32}$/, "from must be a 32-char sys_id"),
  name: z.string().min(1),
  /** Target scope name (x_cadso_email_spok) or 32-hex sys_id. */
  scope: z.string().min(1),
  internalName: z.string().min(1).optional(),
  description: z.string().optional(),
  /** Required when confirm is true. */
  updateSetSysId: z.string().optional(),
  ops: z
    .object({
      patchStepScripts: editActionSchema.shape.ops.shape.patchStepScripts,
      setStepInputs: z.array(setStepInputSchema).optional(),
      addStepOutputs: editActionSchema.shape.ops.shape.addStepOutputs,
      addStepInputs: editActionSchema.shape.ops.shape.addStepInputs,
    })
    .strict()
    .optional(),
  /** Default false — dry-run. Only true writes + publishes. */
  confirm: z.boolean().optional(),
  /** Forces a dry-run even with confirm. */
  dryRun: z.boolean().optional(),
});

/**
 * action_define — define a Custom Action Type's inputs, outputs and steps the way
 * the Designer's Save does. Mirrors dove-sn define-action; `spec` is the
 * DefineActionSpec (strict — unknown keys are rejected here and again by the
 * planner, which also refuses bad names and dangling / unknown pill references).
 */
var defineVarType = z.enum(["string", "choice", "boolean", "integer"]);
var defineStepValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.object({ name: z.string().min(1), value: z.string() }).strict()),
  z.object({ value: z.string(), display: z.string().optional() }).strict(),
]);
export var defineActionSpecSchema = z
  .object({
    action: z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        access: z.enum(["public", "package_private"]).optional(),
      })
      .strict()
      .optional(),
    inputs: z
      .array(
        z
          .object({
            name: z.string().min(1),
            label: z.string().optional(),
            type: defineVarType.optional(),
            mandatory: z.boolean().optional(),
            choices: z.array(z.object({ value: z.string().min(1), label: z.string().optional() }).strict()).optional(),
            default: z.string().optional(),
            order: z.number().optional(),
            maxLength: z.number().positive().optional(),
            remove: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    outputs: z
      .array(
        z
          .object({
            name: z.string().min(1),
            label: z.string().optional(),
            type: defineVarType.optional(),
            value: z.string().optional(),
            remove: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    steps: z
      .array(
        z
          .object({
            ref: z.string().min(1),
            type: z.enum(["script", "rest"]),
            label: z.string().min(1).optional(),
            match: z.string().min(1).optional(),
            remove: z.boolean().optional(),
            errorHandling: z.enum(["EVAL_ERRORS", "NEXT_STEP"]).optional(),
            script: z.string().optional(),
            inputs: z
              .record(
                z.union([
                  z.string(),
                  z
                    .object({
                      value: z.string().optional(),
                      type: defineVarType.optional(),
                      label: z.string().optional(),
                      mandatory: z.boolean().optional(),
                      remove: z.boolean().optional(),
                    })
                    .strict(),
                ]),
              )
              .optional(),
            outputs: z
              .array(
                z
                  .object({
                    name: z.string().min(1),
                    label: z.string().optional(),
                    type: defineVarType.optional(),
                    remove: z.boolean().optional(),
                  })
                  .strict(),
              )
              .optional(),
            values: z.record(defineStepValue).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export var defineActionSchema = z.object({
  /** sys_hub_action_type_definition sys_id (the shell must already exist). */
  sysId: z.string().regex(/^[0-9a-f]{32}$/, "sysId must be a 32-char sys_id"),
  /** The action's scope — name (x_cadso_email_spok) or 32-hex sys_id. */
  scope: z.string().min(1),
  spec: defineActionSpecSchema,
  /** Pin the REST session to this update set before the save/publish. */
  updateSetSysId: z.string().optional(),
  /** With confirm: also publish (snapshot) after the save. */
  publish: z.boolean().optional(),
  /** Default false — dry-run. Only true writes. */
  confirm: z.boolean().optional(),
  /** Forces a dry-run even with confirm. */
  dryRun: z.boolean().optional(),
});

export var editFlowSchema = z.object({
  sysId: z.string().min(1),
  ops: z.object({
    rename: z
      .object({
        name: z.string().optional(),
        internalName: z.string().optional(),
      })
      .optional(),
    description: z.string().optional(),
    patchStepInputs: z.array(stepInputPatchSchema).optional(),
  }),
  apply: z.boolean().optional(),
  scopeSysId: z.string().optional(),
  updateSetSysId: z.string().optional(),
});

export var hostAssetsSchema = z.object({
  dir: z.string().min(1),
  app: z.string().min(1),
  scope: z.string().min(1),
  updateSetSysId: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().optional(),
  allowOversize: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export var columnSpecSchema = z.object({
  label: z.string().min(1),
  type: z.string().min(1),
  name: z.string().optional(),
  max_length: z.union([z.string(), z.number()]).optional(),
  reference: z.string().optional(),
  mandatory: z.boolean().optional(),
  default: z.string().optional(),
  // add_column only — the sibling column a document_id resolves against. Must already
  // exist on the table. Ignored by create_table's form path.
  dependent_on_field: z.string().optional(),
});

export var createTableSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  scope: z.string().min(1),
  columns: z.array(columnSpecSchema).min(1),
  extendsTable: z.string().optional(),
  numberPrefix: z.string().optional(),
  userRole: z.string().optional(),
  createAccessControls: z.boolean().optional(),
  access: z.string().optional(),
  showInMenu: z.boolean().optional(),
  updateSetSysId: z.string().optional(),
  saveActionSysId: z.string().optional(),
  columnsRelId: z.string().optional(),
  dryRun: z.boolean().optional(),
  debug: z.boolean().optional(),
});

export var addColumnSchema = z.object({
  table: z.string().min(1),
  column: columnSpecSchema,
  scope: z.string().optional(),
  // Explicit opt-in to a column OWNED by `scope` when that differs from the table's
  // scope (a Journey field on an Automate table). Without it a mismatched scope is
  // refused — on dryRun and live alike — because that is the classic wrong-scope slip.
  crossScope: z.boolean().optional(),
  updateSetSysId: z.string().optional(),
  dryRun: z.boolean().optional(),
  debug: z.boolean().optional(),
});

// add-index keeps a column LIST because an index is conceptually multi-column, but the
// only headless lever (sys_dictionary.unique) is per-COLUMN — so addIndex REFUSES a list
// longer than one rather than silently building a different index than the one asked for.
// `unique` is a plain boolean here for the same reason `internalType` is accepted by
// set-column: a caller who asks for a non-unique index earns the explanation of why it is
// impossible instead of a schema error that reads like a typo. updateSetSysId is optional
// because dryRun needs none; the live-path requirement is enforced at the tool boundary
// (registry.ts), matching add_column.
export var addIndexSchema = z.object({
  table: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  unique: z.boolean(),
  scope: z.string().optional(),
  updateSetSysId: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
  debug: z.boolean().optional(),
});

// index_list is read-only: a table name and nothing else. `v_db_index` keys on the table
// NAME, not a sys_id, so no sys_id form is offered — accepting one would mean resolving it
// and then listing a table the caller never named.
export var listIndexesSchema = z.object({
  table: z.string().min(1),
});

// index_create takes an ordered column LIST — order is part of an index's identity, so it
// is preserved verbatim and never sorted. `name` is accepted ONLY so that asking for one
// earns the explanation that the platform's index-creator form has no name input (the
// same contract set-column uses for internalType/element); createIndex refuses it.
// confirm is the write gate: without confirm:true the tool is a pure dry-run that sends
// nothing and reads nothing. There is deliberately NO updateSetSysId — a database index is
// physical and is not captured in an update set.
export var createIndexSchema = z.object({
  table: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  unique: z.boolean().optional(),
  name: z.string().optional(),
  accessMethod: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  pollAttempts: z.number().int().positive().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  debug: z.boolean().optional(),
});

// set-column takes a CLOSED attribute set, not an open field map: an unbounded write to
// sys_dictionary lets a caller silently corrupt the schema. internalType and element are
// listed but are NOT settable — ServiceNow honours neither on an existing column, and
// setColumn refuses both by name. They are accepted here only so that asking for one
// earns an explanation instead of being silently dropped, which would leave a caller who
// asked to rename a column believing it had happened.
export var columnAttributesSchema = z.object({
  label: z.string().min(1).optional(),
  mandatory: z.boolean().optional(),
  default: z.string().optional(),
  readOnly: z.boolean().optional(),
  maxLength: z.number().int().positive().optional(),
  // sys_dictionary.dependent_on_field; "" clears it. Must name a column on the table.
  dependentOnField: z.string().optional(),
  // Present so a caller can express them and be told WHY they are impossible, rather
  // than having them silently dropped. setColumn refuses both.
  internalType: z.string().optional(),
  element: z.string().optional(),
});

export var setColumnSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  attributes: columnAttributesSchema,
  // Optional because dryRun works without one; when given it must be non-empty.
  // The live-path requirement is enforced at the tool boundary (registry.ts),
  // matching add_column — a .refine here would be dropped from `.shape`.
  updateSetSysId: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
});

// set-table takes a CLOSED attribute set for the same reason set-column does: an
// unbounded write to sys_dictionary lets a caller silently corrupt schema. These are
// the TABLE's own attributes (the internal_type=collection row), not a column's.
//
// .passthrough() is deliberate: z.object() strips unknown keys by default, which would
// silently drop a column attribute (or a typo) BEFORE resolveTableAttributes could see
// it — so { audit:true, label:"x" } would succeed, quietly discarding label. Passing
// unknown keys through lets the core allowlist reject them (a column attribute earns the
// "use set-column" redirect; anything else, "not a settable table attribute").
export var tableAttributesSchema = z
  .object({
    audit: z.boolean().optional(),
  })
  .passthrough();

export var setTableSchema = z.object({
  table: z.string().min(1),
  attributes: tableAttributesSchema,
  // Optional because dryRun works without one; the live-path requirement is
  // enforced at the tool boundary (registry.ts), matching set_column.
  updateSetSysId: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
});

// Data-record write verbs. Kept as plain z.object (no .refine wrapper) so
// registry.ts can read `.shape`; the deeper rules — one of sysId/query, at
// least one field, the schema-table refusal — are enforced by the core
// setField / createRecord functions, which throw clear errors.
export var setFieldSchema = z.object({
  table: z.string().min(1),
  sysId: z.string().optional(),
  query: z.string().optional(),
  fields: z.record(z.string()),
  updateSetSysId: z.string().min(1),
  dryRun: z.boolean().optional(),
});

export var createRecordSchema = z.object({
  table: z.string().min(1),
  fields: z.record(z.string()),
  scope: z.string().min(1),
  updateSetSysId: z.string().min(1),
  ifAbsentQuery: z.string().optional(),
  dryRun: z.boolean().optional(),
});

// delete_record: DRY-RUN BY DEFAULT — the delete only fires with confirm:true
// (dryRun:true forces a dry-run even then). updateSetSysId is REQUIRED and sent,
// but the server op honours it only once #297 ships — until then the capture
// lands in the session's current update set. The
// table-name / 32-hex sys_id shapes are enforced here AND in deleteRecord so a
// malformed id is rejected before any network call on either surface.
export var deleteRecordSchema = z.object({
  table: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, "table must be a ServiceNow table name (lowercase letters, digits, underscores)"),
  sysId: z.string().regex(/^[0-9a-f]{32}$/, "sysId must be a 32-character lowercase hex sys_id"),
  updateSetSysId: z.string().min(1),
  confirm: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

// app_publish: publish a scoped app to the ServiceNow Store or the company
// application repository. Deliberately NO credential fields — the Store
// account resolves from SN_STORE_USERNAME/SN_STORE_PASSWORD inside the verb,
// so credentials never transit MCP arguments or telemetry.
// update_set_export / app_export: the exported document always has its secret
// values replaced with the __SET_DURING_INSTALL__ sentinel — there is deliberately
// NO opt-out field here, so a caller cannot ask for an unredacted export. A field
// that looks secret and no rule covers fails the call instead of shipping.
export var exportUpdateSetSchema = z.object({
  updateSet: z.string().min(1),
  mode: z.union([z.literal("assemble"), z.literal("complete")]).optional(),
  rulesPath: z.string().optional(),
  pageSize: z.number().int().positive().optional(),
  maxRows: z.number().int().positive().optional(),
  confirm: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export var exportAppSchema = z.object({
  app: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  includeData: z.boolean().optional(),
  keepSet: z.boolean().optional(),
  rulesPath: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  confirm: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export var publishAppSchema = z.object({
  app: z.string().min(1),
  version: z.string().min(1),
  devNotes: z.string().optional(),
  target: z.union([
    z.literal("store"),
    z.literal("repo"),
    z.literal("repo-ui"),
    z.literal("update-set"),
  ]),
  updateSetName: z.string().optional(),
  updateSetDescription: z.string().optional(),
  includeData: z.boolean().optional(),
  confirm: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

// invoke_rest: transport primitive for arbitrary authenticated REST operations
// (Scripted REST included). The dry-run-unless-confirm gate lives in invokeRest
// itself; the regex here rejects absolute URLs and non-/api/ paths early.
export var invokeRestSchema = z.object({
  method: z.preprocess(
    function (v) {
      return typeof v === "string" ? v.toUpperCase() : v;
    },
    z.enum(["GET", "POST", "PUT", "DELETE"]),
  ),
  path: z
    .string()
    .min(1)
    .regex(/^\/api\//, "path must be instance-relative and start with /api/"),
  body: z.unknown().optional(),
  confirm: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});
