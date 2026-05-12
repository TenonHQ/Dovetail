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

export { cloneActionType } from "./cloneActionType";
export type { CloneActionTypeParams, CloneActionTypeResult } from "./cloneActionType";

export { triggerPublication } from "./triggerPublication";
export type { TriggerPublicationParams, TriggerPublicationResult } from "./triggerPublication";

export {
  generateSysId,
  stripSystemFields,
  applyScope,
  assertSysId,
  SYSTEM_FIELDS_TO_STRIP,
} from "./shape";

export { topoSort, executeWritePlan, WriteOrderError } from "./writeOrder";
export type { WriteOp, WriteOpResult } from "./writeOrder";
