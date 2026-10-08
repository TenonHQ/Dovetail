/**
 * Headless ServiceNow table-create capability (form-login replay of the
 * sys_db_object.do save). See createTable.ts for the full sequence + the
 * live-validation caveat.
 */

export {
  createTable,
  projectTableGraph,
  parseSysIdFromLocation,
  DEFAULT_SUPER_CLASS,
  DEFAULT_SAVE_ACTION,
  DEFAULT_COLUMNS_REL_ID,
} from "./createTable";
export type {
  CreateTableParams,
  CreateTableResult,
  TableGraph,
} from "./createTable";

export { buildColumnXml, xmlEscape } from "./buildColumnXml";
export type { NormalizedColumn } from "./buildColumnXml";

export {
  normalizeColumns,
  resolveType,
  applyTableSaveOverlay,
  defaultAccessFlags,
  showInMenuKey,
  listEditKey,
  TYPE_MAP,
} from "./buildTableSave";
export type { ColumnSpec, AccessFlags, OverlaySpec } from "./buildTableSave";

export {
  resolveFormAuth,
  openFormSession,
  setCurrentApplication,
  getRecordForm,
  getNewRecordForm,
  getWithSession,
  getFormPage,
  parseFormInputs,
  postForm,
  scrapeCk,
  decodeHtmlEntities,
} from "./formSession";
export type {
  FormAuth,
  FormSession,
  HarvestedForm,
  FetchedFormPage,
  PostResult,
} from "./formSession";

export { addColumn, deriveElement } from "./addColumn";
export type { AddColumnParams, AddColumnResult, DesignAccessFlag } from "./addColumn";
export {
  ensureDesignAccess,
  findDesignAccess,
  resolveScopeRef,
  DESIGN_ACCESS_TABLE,
} from "./designAccess";
export type {
  EnsureDesignAccessParams,
  EnsureDesignAccessResult,
  ResolvedScopeRef,
} from "./designAccess";

export {
  addIndex,
  scanForDuplicates,
  parseIndexColumns,
  indexMatchesColumns,
} from "./addIndex";
export type {
  AddIndexParams,
  AddIndexResult,
  AddIndexVerification,
  DuplicateScan,
  DuplicateValue,
} from "./addIndex";

export { listIndexes, assertTableName } from "./listIndexes";
export type {
  ListIndexesParams,
  ListIndexesResult,
  TableIndex,
} from "./listIndexes";

export {
  createIndex,
  validateCreateIndex,
  DEFAULT_INDEX_FORM_PATH,
  NOT_IN_UPDATE_SET,
} from "./createIndex";
export type { CreateIndexParams, CreateIndexResult } from "./createIndex";

export {
  setColumn,
  resolveAttributes,
  toStoredValue,
  findTruncationRisk,
} from "./setColumn";
export type {
  SetColumnParams,
  SetColumnResult,
  ColumnAttributes,
  AttributeChange,
  TruncationRisk,
} from "./setColumn";

export {
  OVERRIDABLE,
  LABEL_LANGUAGE,
  explainMaxLengthNotOverridable,
  resolveTableScope,
  findOverrideRow,
  findLabelRow,
  effectiveValue,
  diffInherited,
  applyInheritedWrites,
  overrideUpdateName,
  labelUpdateName,
} from "./overrideColumn";
export type {
  OverridableAttribute,
  InheritedChange,
  InheritedWriteParams,
  InheritedWriteResult,
} from "./overrideColumn";
export { setTable, resolveTableAttributes } from "./setTable";
export type {
  SetTableParams,
  SetTableResult,
  TableAttributes,
} from "./setTable";
