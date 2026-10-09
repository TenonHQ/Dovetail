/**
 * Flow Designer authoring surface for @tenonhq/sincronia-servicenow.
 *
 * Phase 1.B exports listTemplates + verifyArtifact. The clone/create/publish
 * functions land in Phase 1.C/D.
 */

export { listTemplates } from "./listTemplates";
export type { TemplateRef, ListTemplatesParams, FlowKind } from "./listTemplates";

export { verifyArtifact } from "./verifyArtifact";
export type {
  VerifyExpect,
  VerifyFound,
  VerifyFailure,
  VerifyReport,
  VerifyArtifactParams,
} from "./verifyArtifact";

export { cloneSubflow } from "./cloneSubflow";
export type { CloneSubflowParams, CloneSubflowResult } from "./cloneSubflow";

export { cloneActionType, resolveScope, slugInternalName, remapClonedSteps } from "./cloneActionType";
export type {
  CloneActionTypeParams,
  CloneActionTypeResult,
  CloneActionTypePlan,
  CloneActionTypeStepReport,
} from "./cloneActionType";

export { fetchActionSteps, actionTypePath } from "./actionTypeApi";

export { triggerPublication } from "./triggerPublication";
export type { TriggerPublicationParams, TriggerPublicationResult } from "./triggerPublication";

export { publishActionType } from "./publishActionType";
export type { PublishActionTypeParams, PublishActionTypeResult } from "./publishActionType";

export { editActionType } from "./editActionType";
export type { EditActionTypeParams, EditActionTypeResult, EditActionTypeOps } from "./editActionType";

export { applyStepOps, verifySteps, summarizeSteps, formatStepPill, findStep, findStepInput, hasStepOps } from "./stepOps";
export type {
  StepOps,
  StepRecord,
  StepSummary,
  StepIoSummary,
  PatchStepScriptOp,
  SetStepInputOp,
  AddStepOutputOp,
  AddStepInputOp,
  ApplyStepOpsResult,
  VerifyStepsResult
} from "./stepOps";

export { readFlow } from "./readFlow";
export type { ReadFlowParams, ReadFlowResult, FlowStep, FlowVariable } from "./readFlow";

export { readActionType } from "./readActionType";
export type { ReadActionTypeParams, ReadActionTypeResult, ActionIo } from "./readActionType";

export { publishFlow } from "./publishFlow";
export type { PublishFlowParams, PublishFlowResult } from "./publishFlow";

export { copyFlow } from "./copyFlow";
export type { CopyFlowParams, CopyFlowResult } from "./copyFlow";

export { createFlow, buildPublishModel } from "./createFlow";
export type { CreateFlowParams, CreateFlowResult } from "./createFlow";

export { editFlow } from "./editFlow";
export type { EditFlowParams, EditFlowResult, EditFlowOps, StepInputPatch } from "./editFlow";

export { testFlow, DEFAULT_RUN_FLOW_PATH, LEGACY_RUN_FLOW_PATH } from "./testFlow";
export type { TestFlowParams, TestFlowResult, TestFlowTarget } from "./testFlow";

export {
  generateSysId,
  stripSystemFields,
  applyScope,
  assertSysId,
  SYSTEM_FIELDS_TO_STRIP,
} from "./shape";

export { topoSort, executeWritePlan, WriteOrderError } from "./writeOrder";
export type { WriteOp, WriteOpResult } from "./writeOrder";

export {
  defineActionType,
  planActionDefinition,
  validateDefineSpec,
  viewAction,
  diffViews,
  toDesignerStep,
  canonValue,
} from "./defineActionType";
export type {
  DefineActionSpec,
  DefineActionInputSpec,
  DefineActionOutputSpec,
  DefineStepSpec,
  DefineStepVarSpec,
  DefineStepOutputSpec,
  DefineStepValue,
  DefineActionTypeParams,
  DefineActionTypeResult,
  DefineActionDiff,
  DefineActionPlan,
  PlanActionDefinitionParams,
  ActionView,
  StepView,
} from "./defineActionType";
