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
  sysId: string;
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
