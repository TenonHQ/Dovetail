/**
 * @tenonhq/dovetail-servicenow
 *
 * ServiceNow helpers that route writes through the Dovetail "Claude" Scripted
 * REST API so every change lands in the target update set and scope.
 */

export { createClient } from "./client";

export {
  resolveExecutionContext,
  isCiEnvironment,
  evaluateWriteGate,
  assertWriteAllowed,
} from "./executionContext";
export type {
  ExecutionContext,
  ResolveContextInput,
  MergeSignal,
  WriteGateInput,
  GateDecision,
} from "./executionContext";
export {
  createClientFromEnvFile,
  resolveConfigFromEnvFile,
} from "./createClientFromEnvFile";
export type {
  ServiceNowClient,
  TableQueryOptions,
  TableSchema,
  TableSchemaField,
  AttachmentMeta,
  NowInvokeMethod,
  NowInvokeParams,
  NowInvokeResponse,
} from "./client";

export { addChoicesToField, removeChoicesFromField } from "./choices";

export {
  hostAssets,
  classifyChunks,
  formatHostAssetsResult,
} from "./hostAssets";

export { formatAddChoicesResult, formatRemoveChoicesResult } from "./formatter";

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
  editActionType,
  applyStepOps,
  verifySteps,
  summarizeSteps,
  formatStepPill,
  readFlow,
  readActionType,
  publishFlow,
  copyFlow,
  createFlow,
  buildPublishModel,
  editFlow,
  testFlow,
  DEFAULT_RUN_FLOW_PATH,
  generateSysId,
  topoSort,
  executeWritePlan,
  WriteOrderError,
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
  EditActionTypeParams,
  EditActionTypeResult,
  EditActionTypeOps,
  StepOps,
  StepRecord,
  StepSummary,
  StepIoSummary,
  PatchStepScriptOp,
  AddStepOutputOp,
  AddStepInputOp,
  ApplyStepOpsResult,
  VerifyStepsResult,
  ReadFlowParams,
  ReadFlowResult,
  FlowStep,
  FlowVariable,
  ReadActionTypeParams,
  ReadActionTypeResult,
  ActionIo,
  PublishFlowParams,
  PublishFlowResult,
  CopyFlowParams,
  CopyFlowResult,
  CreateFlowParams,
  CreateFlowResult,
  EditFlowParams,
  EditFlowResult,
  EditFlowOps,
  StepInputPatch,
  TestFlowParams,
  TestFlowResult,
  WriteOp,
  WriteOpResult,
} from "./flowDesigner";

export type {
  ServiceNowClientConfig,
  ChoiceValue,
  ChoiceType,
  AddChoicesParams,
  AddChoicesResult,
  ChoiceActionResult,
  RemoveChoicesParams,
  RemoveChoicesResult,
  ChoiceRemovalResult,
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
  SetRelatedListsParams,
  ChunkRole,
  ChunkInfo,
  ChunkResult,
  PrunedResult,
  HostAssetsParams,
  HostAssetsResult,
} from "./types";

export {
  createTable,
  projectTableGraph,
  buildColumnXml,
  normalizeColumns,
  resolveType,
  applyTableSaveOverlay,
  defaultAccessFlags,
  TYPE_MAP,
  DEFAULT_SUPER_CLASS,
  DEFAULT_SAVE_ACTION,
  addColumn,
  deriveElement,
  setColumn,
  resolveAttributes,
  toStoredValue,
  setTable,
  resolveTableAttributes,
} from "./table";
export type {
  CreateTableParams,
  CreateTableResult,
  AddColumnParams,
  AddColumnResult,
  SetColumnParams,
  SetColumnResult,
  ColumnAttributes,
  AttributeChange,
  SetTableParams,
  SetTableResult,
  TableAttributes,
  TableGraph,
  NormalizedColumn,
  ColumnSpec,
  AccessFlags,
  OverlaySpec,
} from "./table";

export { setField } from "./setField";
export { createRecord } from "./createRecord";
export type {
  RecordWriteResult,
  SetFieldParams,
  SetFieldResult,
} from "./setField";
export type { CreateRecordParams, CreateRecordResult } from "./createRecord";

export { invokeRest, INVOKE_REST_METHODS } from "./invokeRest";
export type { InvokeRestParams, InvokeRestResult } from "./invokeRest";

export {
  publishApp,
  buildStartFields,
  parseXmlAnswer,
  parseProgressTree,
  classifyProgress,
  flattenSteps,
  harvestProgressResults,
  parseCicdPublishResponse,
  parseCicdProgress,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  PUBLISH_POLL_DELAYS_MS,
} from "./publishApp";
export type {
  PublishAppParams,
  PublishAppResult,
  PublishTarget,
  PublishStep,
  ProgressNode,
  CicdProgress,
  PublishTransport,
} from "./publishApp";
