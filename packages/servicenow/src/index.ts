/**
 * @tenonhq/dovetail-servicenow
 *
 * ServiceNow helpers that route writes through the Dovetail "Claude" Scripted
 * REST API so every change lands in the target update set and scope.
 */

export { createClient } from "./client";
export type {
  ServiceNowClient,
  TableQueryOptions,
  TableSchema,
  TableSchemaField
} from "./client";

export { addChoicesToField } from "./choices";

export { formatAddChoicesResult } from "./formatter";

export { createView } from "./layout/views";
export { setListLayout } from "./layout/listLayout";
export { setFormLayout } from "./layout/formLayout";
export { setRelatedLists } from "./layout/relatedLists";
export { formatLayoutResult, formatCreateViewResult } from "./layout/formatter";

export { sincPlugin } from "./plugin";

export {
  listTemplates,
  verifyArtifact,
  cloneSubflow,
  cloneActionType,
  triggerPublication,
  publishActionType,
  readFlow,
  readActionType,
  publishFlow,
  editFlow,
  testFlow,
  DEFAULT_RUN_FLOW_PATH,
  generateSysId,
  topoSort,
  executeWritePlan,
  WriteOrderError
} from "./flowDesigner";

export type {
  TemplateRef,
  ListTemplatesParams,
  FlowKind,
  VerifyExpect,
  VerifyFound,
  VerifyFailure,
  VerifyReport,
  VerifyArtifactParams,
  CloneSubflowParams,
  CloneSubflowResult,
  CloneActionTypeParams,
  CloneActionTypeResult,
  TriggerPublicationParams,
  TriggerPublicationResult,
  PublishActionTypeParams,
  PublishActionTypeResult,
  ReadFlowParams,
  ReadFlowResult,
  FlowStep,
  FlowVariable,
  ReadActionTypeParams,
  ReadActionTypeResult,
  ActionIo,
  PublishFlowParams,
  PublishFlowResult,
  EditFlowParams,
  EditFlowResult,
  EditFlowOps,
  StepInputPatch,
  TestFlowParams,
  TestFlowResult,
  WriteOp,
  WriteOpResult
} from "./flowDesigner";

export type {
  ServiceNowClientConfig,
  ChoiceValue,
  ChoiceType,
  AddChoicesParams,
  AddChoicesResult,
  ChoiceActionResult,
  DictionaryRecord,
  UpdateSetRecord,
  LayoutAction,
  LayoutRecordResult,
  LayoutResult,
  CreateViewParams,
  CreateViewResult,
  FormSectionSpec,
  SetFormLayoutParams,
  SetListLayoutParams,
  SetRelatedListsParams
} from "./types";
