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
  getNewRecordForm,
  parseFormInputs,
  postForm,
  scrapeCk,
} from "./formSession";
export type {
  FormAuth,
  FormSession,
  HarvestedForm,
  PostResult,
} from "./formSession";
