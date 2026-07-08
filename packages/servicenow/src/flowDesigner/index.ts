/**
 * Flow Designer authoring surface for @tenonhq/sincronia-servicenow.
 *
 * Phase 1.B exports listTemplates + verifyArtifact. The clone/create/publish
 * functions land in Phase 1.C/D.
 */

export { listTemplates } from "./listTemplates";
export type {
  TemplateRef,
  ListTemplatesParams,
  FlowKind,
} from "./listTemplates";

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

export { cloneActionType } from "./cloneActionType";
export type {
  CloneActionTypeParams,
  CloneActionTypeResult,
} from "./cloneActionType";

export { triggerPublication } from "./triggerPublication";
export type {
  TriggerPublicationParams,
  TriggerPublicationResult,
} from "./triggerPublication";

export { publishActionType } from "./publishActionType";
export type {
  PublishActionTypeParams,
  PublishActionTypeResult,
} from "./publishActionType";

export { editActionType } from "./editActionType";
export type {
  EditActionTypeParams,
  EditActionTypeResult,
  EditActionTypeOps,
} from "./editActionType";

export { readFlow } from "./readFlow";
export type {
  ReadFlowParams,
  ReadFlowResult,
  FlowStep,
  FlowVariable,
} from "./readFlow";

export { readActionType } from "./readActionType";
export type {
  ReadActionTypeParams,
  ReadActionTypeResult,
  ActionIo,
} from "./readActionType";

export { publishFlow } from "./publishFlow";
export type { PublishFlowParams, PublishFlowResult } from "./publishFlow";

export { copyFlow } from "./copyFlow";
export type { CopyFlowParams, CopyFlowResult } from "./copyFlow";

export { createFlow, buildPublishModel } from "./createFlow";
export type { CreateFlowParams, CreateFlowResult } from "./createFlow";

export { editFlow } from "./editFlow";
export type {
  EditFlowParams,
  EditFlowResult,
  EditFlowOps,
  StepInputPatch,
} from "./editFlow";

export { testFlow, DEFAULT_RUN_FLOW_PATH } from "./testFlow";
export type { TestFlowParams, TestFlowResult } from "./testFlow";

export {
  generateSysId,
  stripSystemFields,
  applyScope,
  assertSysId,
  SYSTEM_FIELDS_TO_STRIP,
} from "./shape";

export { topoSort, executeWritePlan, WriteOrderError } from "./writeOrder";
export type { WriteOp, WriteOpResult } from "./writeOrder";
