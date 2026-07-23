/**
 * @tenonhq/dovetail-servicenow — type definitions
 */

export interface ServiceNowClientConfig {
  /** Instance host, e.g. "tenonworkstudio.service-now.com". Defaults to SN_INSTANCE env var. */
  instance?: string;
  /** Basic-auth user. Defaults to SN_USER env var. */
  user?: string;
  /** Basic-auth password. Defaults to SN_PASSWORD env var. */
  password?: string;
  /** Min gap between requests (ms). Defaults to SN_REQUEST_INTERVAL_MS or 20. */
  requestIntervalMs?: number;
  /** Max retries on 429. Defaults to SN_MAX_RETRIES_429 or 5. */
  maxRetries429?: number;
  /** Max retries on 5xx/network. Defaults to SN_MAX_RETRIES_5XX or 3. */
  maxRetries5xx?: number;
}

export interface ChoiceValue {
  value: string;
  label: string;
  /** Order hint. Optional; ServiceNow auto-sequences when omitted. */
  sequence?: number;
  /** Defaults to "en". */
  language?: string;
}

/** sys_dictionary.choice column values. 0 = none, 1 = suggestion, 3 = dropdown w/ --None--. */
export type ChoiceType = 0 | 1 | 3;

export interface AddChoicesParams {
  /** Target table, e.g. "x_cadso_core_event". */
  table: string;
  /** Target column, e.g. "state". */
  column: string;
  /** Choice values to upsert. */
  choices: Array<ChoiceValue>;
  /** Update set sys_id that will capture every write. Required — no default. */
  updateSetSysId: string;
  /** sys_dictionary.choice setting. Defaults to 3 (dropdown). Pass null to leave dictionary alone. */
  choiceType?: ChoiceType | null;
}

export interface DictionaryRecord {
  sys_id: string;
  name: string;
  element: string;
  choice: string;
  /** sys_scope is a reference; ServiceNow returns the sys_id string. */
  sys_scope: string;
}

export interface UpdateSetRecord {
  sys_id: string;
  name: string;
  state: string;
  application: string;
}

export interface ChoiceActionResult {
  value: string;
  label: string;
  /** The primary row acted on — `sysIds[0]`. */
  sysId: string;
  /**
   * EVERY sys_choice row that matched this language::value. Normally one, but
   * sys_choice has no uniqueness constraint, so a field can hold duplicates — all of
   * them are written, and a length > 1 is the caller's signal that the field needs
   * cleaning up.
   */
  sysIds: Array<string>;
  action: "created" | "updated" | "unchanged";
}

export interface AddChoicesResult {
  dictionary: {
    sysId: string;
    scope: string;
    choiceWas: ChoiceType;
    choiceNow: ChoiceType;
  };
  updateSet: {
    sysId: string;
    name: string;
  };
  choices: Array<ChoiceActionResult>;
}

export interface RemoveChoicesParams {
  /** Target table, e.g. "x_cadso_core_event". */
  table: string;
  /** Target column, e.g. "state". */
  column: string;
  /** Choice values to soft-delete (deactivate). */
  values: Array<string>;
  /** Language of the choices to deactivate. Defaults to "en". */
  language?: string;
  /** Update set sys_id that will capture every write. Required — no default. */
  updateSetSysId: string;
}

export interface ChoiceRemovalResult {
  value: string;
  /** The primary row acted on — `sysIds[0]`, or "" when the value was not found. */
  sysId: string;
  /**
   * EVERY sys_choice row that matched this language::value; [] when missing. A field
   * can hold more than one row for a value (sys_choice has no uniqueness constraint),
   * and all live ones are deactivated — acting on just the first would leave the
   * choice selectable while reporting success.
   */
  sysIds: Array<string>;
  /**
   * deactivated — was active, now inactive=true.
   * unchanged   — already inactive; nothing written (idempotent).
   * missing     — no such value on this field.language; nothing written.
   */
  action: "deactivated" | "unchanged" | "missing";
}

export interface RemoveChoicesResult {
  field: {
    table: string;
    column: string;
    language: string;
    dictionarySysId: string;
  };
  updateSet: {
    sysId: string;
    name: string;
  };
  choices: Array<ChoiceRemovalResult>;
}

/* ─── Form / list / view layout tooling ─────────────────────────────────── */

/** Outcome of a single sys_ui_* record within a layout reconcile. */
export type LayoutAction = "created" | "updated" | "deleted" | "unchanged";

/** Per-record result row — one ServiceNow sys_ui_* record touched (or planned). */
export interface LayoutRecordResult {
  /** The sys_ui_* table written, e.g. "sys_ui_element". */
  table: string;
  /** sys_id of the record; "" for a create that was only planned (dryRun). */
  sysId: string;
  action: LayoutAction;
  /** Human-readable identity: a section caption, field/column name, or related-list id. */
  label: string;
}

/** Shared envelope for setFormLayout / setListLayout / setRelatedLists results. */
export interface LayoutResult {
  /** The ServiceNow table whose layout changed, e.g. "x_cadso_automate_audience". */
  table: string;
  /** "" = the Default view. */
  view: string;
  updateSet: { sysId: string; name: string };
  /** True when the writes were planned but not performed. */
  dryRun: boolean;
  /** Every sys_ui_* record created/updated/deleted/unchanged, in apply order. */
  records: Array<LayoutRecordResult>;
}

export interface CreateViewParams {
  /** View name, e.g. "sales_support". The unique key for sys_ui_view. */
  name: string;
  /** Display title. Defaults to the name when omitted. */
  title?: string;
  /** Update set sys_id that captures the write. Required. */
  updateSetSysId: string;
  /** Scope namespace for the view record. Defaults to "global". */
  scope?: string;
  /** Plan the write without performing it. Defaults to false. */
  dryRun?: boolean;
}

export interface CreateViewResult {
  view: { sysId: string; name: string; title: string; action: LayoutAction };
  updateSet: { sysId: string; name: string };
  dryRun: boolean;
}

/** One section of a form: a caption (empty = the primary/unnamed section) + ordered fields. */
export interface FormSectionSpec {
  /** Section caption. Omit or "" for the primary section. */
  caption?: string;
  /** Field (element) names, in display order. */
  fields: Array<string>;
}

export interface SetFormLayoutParams {
  /** Target table, e.g. "x_cadso_automate_audience". */
  table: string;
  /** View name; omit or "" for the Default view. */
  view?: string;
  /** Sections in display order. The first entry is the primary section. */
  sections: Array<FormSectionSpec>;
  /** Update set sys_id that captures every write. Required. */
  updateSetSysId: string;
  /** Scope namespace; auto-resolved from the table when omitted. */
  scope?: string;
  /** Delete sections/elements not present in the spec. Defaults to true. */
  prune?: boolean;
  /** Plan the writes without performing them. Defaults to false. */
  dryRun?: boolean;
}

export interface SetListLayoutParams {
  /** Target table, e.g. "x_cadso_automate_audience". */
  table: string;
  /** View name; omit or "" for the Default view. */
  view?: string;
  /** Column (element) names in display order. Dot-walked columns allowed (e.g. "assigned_to.name"). */
  columns: Array<string>;
  /** Parent table name for a related-list column layout. Omit for a standard list. */
  parent?: string;
  /** Update set sys_id that captures every write. Required. */
  updateSetSysId: string;
  /** Scope namespace; auto-resolved from the table when omitted. */
  scope?: string;
  /** Delete columns not present in the spec. Defaults to true. */
  prune?: boolean;
  /** Plan the writes without performing them. Defaults to false. */
  dryRun?: boolean;
}

export interface SetRelatedListsParams {
  /** Target table, e.g. "x_cadso_automate_audience". */
  table: string;
  /** View name; omit or "" for the Default view. */
  view?: string;
  /** Related-list identifiers in display order: "<table>.<field>" or "REL:<sys_relationship>". */
  relatedLists: Array<string>;
  /** Update set sys_id that captures every write. Required. */
  updateSetSysId: string;
  /** Scope namespace; auto-resolved from the table when omitted. */
  scope?: string;
  /** Delete related-list entries not present in the spec. Defaults to true. */
  prune?: boolean;
  /** Plan the writes without performing them. Defaults to false. */
  dryRun?: boolean;
}

/* ─── Front-end asset hosting (host-assets) ─────────────────────────────── */

/** Role of a built chunk, inferred from its base name. Drives m2m chunk_role + load order. */
export type ChunkRole =
  | "index"
  | "entry"
  | "vendor"
  | "router"
  | "state"
  | "lazy"
  | "style";

/**
 * A classified build chunk — pure metadata, derived before any bytes are read.
 * The carrier sys_ui_script is named `app_shell_asset:<viteRelPath>` (hash included),
 * because the Scripted REST serving resource resolves an asset by that exact name.
 */
export interface ChunkInfo {
  /** Dist-relative path with forward slashes, e.g. "assets/index-a1b2c3d4.js" or "index.html". */
  viteRelPath: string;
  /** Carrier sys_ui_script name: "app_shell_asset:" + viteRelPath. Stable per build, rotates with the hash. */
  name: string;
  /** Filename only, e.g. "index-a1b2c3d4.js". */
  fileName: string;
  /** Hash-stripped base used only for role inference, e.g. "index". */
  base: string;
  /** Lowercased extension without the dot, e.g. "js". */
  ext: string;
  role: ChunkRole;
  /** Gap-free load order across all chunks (ascending). */
  order: number;
  /** MIME type written to the attachment. */
  contentType: string;
}

export interface HostAssetsParams {
  /** Path to the pre-built dist/ directory. */
  dir: string;
  /** Application record sys_id (32 hex) — written verbatim to the m2m `application` field. */
  app: string;
  /** Scope namespace the carrier records live in, e.g. "x_cadso_app_shell". */
  scope: string;
  /** Update set sys_id that captures every metadata write. Resolved from the scope's current update set when omitted. */
  updateSetSysId?: string;
  /**
   * Max bytes per chunk. The serving layer streams each chunk via
   * GlideSysAttachment.getContentStream(), capped by glide.scriptable.excel.max_file_size
   * (~5 MB) — a larger chunk truncates on serve. Defaults to 5 * 1024 * 1024.
   */
  maxBytes?: number;
  /** Warn instead of failing when a chunk meets/exceeds maxBytes. Defaults to false (fail). */
  allowOversize?: boolean;
  /** Plan the deploy (read + classify) without writing/uploading/pruning. Defaults to false. */
  dryRun?: boolean;
}

export interface ChunkResult {
  /** Carrier sys_ui_script name ("app_shell_asset:<viteRelPath>"). */
  name: string;
  viteRelPath: string;
  base: string;
  role: ChunkRole;
  order: number;
  contentType: string;
  bytes: number;
  scriptSysId: string;
  scriptAction: "created" | "updated" | "unchanged";
  attachmentSysId: string;
  attachmentAction: "uploaded" | "replaced" | "unchanged";
  m2mSysId: string;
  m2mAction: "created" | "updated" | "unchanged";
  /** True once the script record + an attachment were read back from the instance. */
  verified: boolean;
}

export interface PrunedResult {
  /** Carrier sys_ui_script name that was removed (or planned for removal). */
  name: string;
  scriptSysId: string;
  m2mSysId: string;
  /** False when the carrier script was kept because another app's m2m still references it. */
  scriptDeleted: boolean;
}

export interface HostAssetsResult {
  scope: string;
  app: string;
  updateSet: { sysId: string; name: string };
  dryRun: boolean;
  chunks: Array<ChunkResult>;
  pruned: Array<PrunedResult>;
}
