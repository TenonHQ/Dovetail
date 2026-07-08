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
  dryRun: z.boolean().optional()
});

export var columnSpecSchema = z.object({
  label: z.string().min(1),
  type: z.string().min(1),
  name: z.string().optional(),
  max_length: z.union([z.string(), z.number()]).optional(),
  reference: z.string().optional(),
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
  updateSetSysId: z.string().optional(),
  saveActionSysId: z.string().optional(),
  columnsRelId: z.string().optional(),
  dryRun: z.boolean().optional(),
  debug: z.boolean().optional()
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
  dryRun: z.boolean().optional()
});

export var createRecordSchema = z.object({
  table: z.string().min(1),
  fields: z.record(z.string()),
  scope: z.string().min(1),
  updateSetSysId: z.string().min(1),
  ifAbsentQuery: z.string().optional(),
  dryRun: z.boolean().optional()
});
