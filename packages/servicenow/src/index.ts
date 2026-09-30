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

export {
  addChoicesToField,
  removeChoicesFromField,
  ChoiceWriteError,
} from "./choices";

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
  addIndex,
  parseIndexColumns,
  indexMatchesColumns,
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
  AddIndexParams,
  AddIndexResult,
  AddIndexVerification,
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

export {
  exportUpdateSet,
  renderUpdateXmlRow,
  renderRemoteUpdateSet,
  renderUnload,
  countUnloadRecords,
  countUpdateXml,
  fetchUpdateXmlRows,
  refreshTypeFields,
  parseStatsCount,
  formatUnloadDate,
  xmlEscape,
  UPDATE_XML_FIELDS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_MAX_ROWS,
} from "./exportUpdateSet";
export type {
  ExportUpdateSetParams,
  ExportUpdateSetResult,
  ExportMode,
  ExportTransport,
} from "./exportUpdateSet";

export {
  exportApp,
  buildCreateSetFields,
  buildPublishFields,
  DEFAULT_EXPORT_APP_TIMEOUT_MS,
} from "./exportApp";
export type {
  ExportAppParams,
  ExportAppResult,
  ExportAppTransport,
} from "./exportApp";

export {
  stripSecrets,
  verifyStripped,
  readField,
  readRecordTable,
  recordFieldNames,
  plannedStrips,
  stripField,
  stripJsonValue,
  encodeXmlEntities,
  encodeXmlText,
  escapeRegExp,
} from "./secrets/stripSecrets";
export type {
  StripSecretsResult,
  StripSecretsOptions,
  SecretField,
  ReviewFinding,
} from "./secrets/stripSecrets";

export {
  defaultSecretRules,
  loadSecretRules,
  mergeSecretRules,
  secretFieldsFromDictionary,
  isCapturable,
  SENTINEL,
  SECRET_INTERNAL_TYPES,
} from "./secrets/secretRules";
export type {
  SecretRules,
  FieldRule,
  NotSecretRule,
  DictionaryRow,
  CapturableRow,
} from "./secrets/secretRules";
