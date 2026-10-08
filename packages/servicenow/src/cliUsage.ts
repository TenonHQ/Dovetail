/**
 * dove-sn usage table — the ONE place a verb's flags, value formats, write gate and
 * example live. `dove-sn help`, `dove-sn help <verb>`, `dove-sn <verb> --help` and the
 * usage block appended to a "Missing required flags" error are all rendered from here,
 * so the help cannot drift from the dispatcher: cliHelp.test.ts walks the dispatch sites
 * in cli.ts and fails when a verb is missing an entry (or an entry names no verb).
 *
 * The `stringFlags` lists are ALSO read by cli.ts's bareStringFlagError guard, so a flag
 * the parser refuses when given no value is, by construction, a flag the help documents.
 *
 * No side effects, no imports — safe to load before an env file is read or a client is
 * built, which is what lets `--help` short-circuit without touching the network.
 */

/**
 * How a verb treats the instance. Rendered via GATE_TEXT; `gateNote` on an entry adds the
 * verb-specific qualifier (e.g. which flag is required on the live path).
 */
export type WriteGate =
  | "read-only"
  | "local"
  | "writes"
  | "dry-run-flag"
  | "confirm"
  | "apply"
  | "execute-confirm"
  | "server";

export var GATE_TEXT: Record<WriteGate, string> = {
  "read-only": "Read-only — nothing on the instance is written.",
  local: "Local only — reads/writes files on this machine; makes no instance call.",
  writes:
    "WRITES on the instance as soon as it runs — there is no --dry-run for this verb.",
  "dry-run-flag":
    "Writes by default; pass --dry-run to print the plan and write nothing.",
  confirm:
    "DRY-RUN BY DEFAULT — nothing is written without --confirm; --dry-run forces a dry-run even with --confirm.",
  apply:
    "DRY-RUN BY DEFAULT — prints the would-be changes; --apply persists them.",
  "execute-confirm":
    "Validate-only by default (read-only pre-flight); --execute --confirm runs it for real and can cause side effects.",
  server:
    "Starts a long-running process on this machine; it connects to the instance only when a tool is invoked.",
};

export interface FlagDoc {
  /**
   * Flag name without the leading dashes. Mutually-exclusive alternatives are joined with
   * " | " (e.g. "fields | from-json") and rendered as `--fields | --from-json`.
   */
  flag: string;
  /** Value placeholder, e.g. "<sys_id>". Omitted for a boolean switch. */
  value?: string;
  /** Format, default, or caveat — one line. */
  note?: string;
}

export interface VerbUsage {
  /** One line, no trailing period — shown in the verb index. */
  summary: string;
  required: Array<FlagDoc>;
  optional: Array<FlagDoc>;
  gate: WriteGate;
  /** Verb-specific qualifier appended to the gate sentence. */
  gateNote?: string;
  /** One runnable example; starts with `dove-sn <verb>`. */
  example: string;
  /** Caveats worth a line each. */
  notes?: Array<string>;
  /**
   * String-valued flags the verb refuses when given no value (a bare `--label` would
   * otherwise arrive as the string "true"). cli.ts reads this list — keep aliases such as
   * `updateSetSysId` here too, since the parser accepts them.
   */
  stringFlags?: Array<string>;
}

/** Flags every verb accepts. Rendered once in the index and as a footer on each verb. */
export var GLOBAL_FLAGS: Array<FlagDoc> = [
  {
    flag: "env | env-file",
    value: "<name|path>",
    note:
      "Load credentials from this env file (or DOVETAIL_ENV_FILE). A bare name like 'prod' means .env.prod in the cwd. Its SN_* vars replace any already exported; a missing or incomplete file is an error. Default: .env in the cwd.",
  },
  {
    flag: "help",
    note: "Print this verb's usage and exit — loads no env file, builds no client, sends nothing.",
  },
];

var JSON_FLAG: FlagDoc = {
  flag: "json",
  note: "Emit the structured result instead of human text.",
};
var DRY_RUN_FLAG: FlagDoc = {
  flag: "dry-run",
  note: "Print the plan; write nothing.",
};
var CONFIRM_FLAG: FlagDoc = {
  flag: "confirm",
  note: "Execute for real (without it the run is a dry-run).",
};
var FORCE_DRY_RUN_FLAG: FlagDoc = {
  flag: "dry-run",
  note: "Force a dry-run even with --confirm.",
};
var UPDATE_SET_FLAG: FlagDoc = {
  flag: "update-set",
  value: "<sys_id>",
  note: "Update set that captures every write (alias: --updateSetSysId).",
};
var DEBUG_FLAG: FlagDoc = {
  flag: "debug",
  note: "Verbose request/response tracing on stderr.",
};

/**
 * Insertion order is the index order — grouped: choices, schema, indexes, records,
 * layouts, Flow Designer, action types, REST, publish/export, local.
 */
export var VERB_USAGE: Record<string, VerbUsage> = {
  "add-choices": {
    summary: "Upsert sys_choice rows for a table.column",
    required: [
      { flag: "table", value: "<name>" },
      { flag: "column", value: "<element>" },
      UPDATE_SET_FLAG,
      {
        flag: "choices",
        value: '"<value=Label,value2=Label 2,...>"',
        note: "Comma-separated value=Label pairs; each entry needs exactly one '='.",
      },
    ],
    optional: [
      {
        flag: "choice-type",
        value: "<0|1|3>",
        note: "sys_dictionary.choice to set on the field (default 3 = dropdown without --None--; 1 = with --None--).",
      },
      {
        flag: "from-json",
        value: "<path>",
        note: 'Replaces the flags above. JSON { "table", "column", "updateSetSysId", "choiceType"?, "choices": [{ "value", "label" }] }.',
      },
      {
        flag: "dry-run",
        note: "Verify the field + update set and print [would create] / [would update] rows; nothing is written.",
      },
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    gateNote: "Every insert/update is captured into --update-set.",
    example:
      'dove-sn add-choices --table x_cadso_core_event --column state --update-set <sys_id> --choices "delivered=Delivered,failed=Failed"',
    stringFlags: [
      "table",
      "column",
      "update-set",
      "updateSetSysId",
      "choices",
      "from-json",
      "choice-type",
    ],
  },
  "remove-choices": {
    summary: "Soft-delete (inactive=true) sys_choice values for a table.column — never a row drop",
    required: [
      { flag: "table", value: "<name>" },
      { flag: "column", value: "<element>" },
      UPDATE_SET_FLAG,
      { flag: "values", value: '"<a,b,c>"', note: "Comma-separated choice values to retire." },
    ],
    optional: [
      { flag: "language", value: "<code>", note: "Choice language row to target (default en)." },
      {
        flag: "from-json",
        value: "<path>",
        note: 'Replaces the flags above. JSON { "table", "column", "updateSetSysId", "values": [...], "language"? } — validated against the MCP schema.',
      },
      {
        flag: "dry-run",
        note: "Verify the field + update set and print [would deactivate] rows; nothing is written.",
      },
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    gateNote: "Each deactivation is captured into --update-set; a value already inactive is reported, not rewritten.",
    example:
      'dove-sn remove-choices --table x_cadso_core_event --column state --update-set <sys_id> --values "expired,failed"',
    stringFlags: [
      "table",
      "column",
      "update-set",
      "updateSetSysId",
      "values",
      "language",
      "from-json",
    ],
  },

  "create-table": {
    summary: "Create a NEW table (sys_db_object) WITH columns, via the Studio form save",
    required: [
      { flag: "name", value: "<x_scope_table>" },
      { flag: "label", value: "<text>" },
      { flag: "scope", value: "<x_scope>" },
      {
        flag: "columns | from-json",
        value: '"Label:type:max, Other:choice, ..." | <spec.json>',
        note: "Inline: Label[:internal_type[:max_length]] per column, type defaults to string. Or a full CreateTableParams JSON spec.",
      },
    ],
    optional: [
      { flag: "extends", value: "<table>", note: "Parent table (e.g. sys_metadata)." },
      { flag: "number-prefix", value: "<PFX>", note: "Auto-number prefix." },
      { flag: "user-role", value: "<role>", note: "Role that may read the table." },
      { flag: "no-acls", note: "Skip the default access controls." },
      { flag: "no-menu", note: "Skip the application-menu module." },
      UPDATE_SET_FLAG,
      { flag: "save-action", value: "<sys_id>", note: "Advanced: override the Studio save UI action." },
      { flag: "columns-rel-id", value: "<sys_id>", note: "Advanced: override the Studio columns relationship id." },
      DRY_RUN_FLAG,
      DEBUG_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example:
      'dove-sn create-table --name x_cadso_core_error --label Error --scope x_cadso_core --columns "Key:string:255, Severity:choice:50" --update-set <sys_id> --dry-run',
    notes: ["Exit 2 when the platform reports the save failed."],
  },
  "add-column": {
    summary: "Add ONE column to an EXISTING table via a scope-aware sys_dictionary insert, then verify",
    required: [
      { flag: "table", value: "<name|sys_id>" },
      {
        flag: "label | from-json",
        value: "<text> | <spec.json>",
        note: "Inline label (+ --type) or an AddColumnParams JSON spec with a `column` object.",
      },
    ],
    optional: [
      { flag: "type", value: "<internal_type>", note: "Default string (url, integer, reference, choice, document_id, ...)." },
      { flag: "name", value: "<element>", note: "Column element; default is a slug of --label." },
      { flag: "max-length", value: "<n>" },
      { flag: "reference", value: "<table>", note: "Target table for a reference column." },
      { flag: "mandatory", note: "Set mandatory=true." },
      { flag: "default", value: "<value>" },
      {
        flag: "dependent-on-field",
        value: "<element>",
        note: "Sibling column a document_id resolves against (its table_name column); must already exist.",
      },
      {
        flag: "scope",
        value: "<x_scope>",
        note: "Owning app scope. Must match the table's scope unless --cross-scope is passed.",
      },
      {
        flag: "cross-scope",
        note: "Opt in to a column OWNED by --scope, which differs from the table's scope (element becomes <scope>_<name>; the table must allow new fields; --update-set must be in --scope).",
      },
      {
        flag: "ensure-design-access",
        note: "Cross-scope only: create the missing sys_scope_design_access record (--scope -> table's scope) first, in the same update set. Without it a missing record is only flagged.",
      },
      { flag: "update-set", value: "<sys_id>", note: "REQUIRED on the live path (only --dry-run works without one)." },
      DRY_RUN_FLAG,
      DEBUG_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    gateNote: "--update-set is required unless --dry-run.",
    example:
      "dove-sn add-column --table x_cadso_journey --label URL --type url --max-length 1024 --update-set <sys_id>",
    notes: [
      "Exit 2 when the write landed but the read-back does not show the column.",
      "Cross-scope: dove-sn add-column --table x_cadso_automate_email_batch --label 'Instance Step' --name instance_step --type reference --reference x_cadso_journey_instance_step --scope x_cadso_journey --cross-scope --update-set <journey set>",
    ],
  },
  "design-access": {
    summary: "Ensure the sys_scope_design_access record that lets one app author in another app's tables (required by the UI for cross-scope columns)",
    required: [
      { flag: "source", value: "<x_scope>", note: "The AUTHORING app (owns the record and its update set)." },
      { flag: "target", value: "<x_scope>", note: "The app that OWNS the tables." },
    ],
    optional: [
      { flag: "update-set", value: "<sys_id>", note: "Update set in --source. REQUIRED on the live path." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    gateNote: "--update-set is required unless --dry-run; --dry-run reports exists/missing only.",
    example:
      "dove-sn design-access --source x_cadso_journey --target x_cadso_automate --update-set <journey set>",
    notes: [
      "Idempotent: an existing record is reported and nothing is written.",
      "Symptom it fixes: \"Invalid 'Table' selected on the Dictionary Entry record ... can only select '<app>' tables with read access enabled\" — the table's own access flags are NOT the gate.",
      "Exit 2 when the record could not be created or verified on read-back.",
    ],
  },
  "set-column": {
    summary: "Update an EXISTING column's schema (label/mandatory/default/read-only/max-length/dependent-on-field), then verify",
    required: [
      { flag: "table", value: "<name>" },
      { flag: "column", value: "<element>" },
    ],
    optional: [
      { flag: "update-set", value: "<sys_id>", note: "Required unless --dry-run (alias: --updateSetSysId)." },
      { flag: "label", value: "<text>" },
      { flag: "mandatory", value: "<true|false>" },
      { flag: "default", value: "<value>" },
      { flag: "read-only", value: "<true|false>" },
      { flag: "max-length", value: "<n>", note: "Positive integer. A SHRINK is refused while rows hold longer values." },
      { flag: "dependent-on-field", value: "<element>", note: "Empty string clears the dependency." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example:
      'dove-sn set-column --table x_cadso_journey --column description --label "Description" --max-length 4000 --update-set <sys_id>',
    notes: [
      "An INHERITED column is narrowed for your table alone via sys_dictionary_override; max-length is the parent's physical column and is refused.",
      "--element / --internal-type are REFUSED with an explanation: ServiceNow silently ignores both on an existing column.",
      "Exit 2 when the write landed but was not verified or not captured in the update set.",
    ],
    stringFlags: [
      "label",
      "default",
      "table",
      "column",
      "update-set",
      "updateSetSysId",
      "dependent-on-field",
    ],
  },
  "set-table": {
    summary: "Update an EXISTING table's own dictionary row (the collection row), then verify",
    required: [{ flag: "table", value: "<name>" }],
    optional: [
      { flag: "update-set", value: "<sys_id>", note: "Required unless --dry-run (alias: --updateSetSysId)." },
      {
        flag: "audit",
        value: "<true|false>",
        note: "Record auditing for the whole table — true writes a sys_audit row per changed field on every insert/update.",
      },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example: "dove-sn set-table --table x_cadso_core_setting --audit true --update-set <sys_id>",
    notes: ["Column attributes belong to set-column; record values to set-field."],
    stringFlags: ["table", "update-set", "updateSetSysId"],
  },

  "add-index": {
    summary: "Create a single-column UNIQUE index (sys_dictionary.unique), then verify",
    required: [
      { flag: "table", value: "<name|sys_id>" },
      { flag: "columns", value: "<column>", note: "ONE column only — a composite index is refused, not narrowed." },
      { flag: "unique", note: "Required: the only headless lever is sys_dictionary.unique; a plain index stays UI work." },
    ],
    optional: [
      { flag: "update-set", value: "<sys_id>", note: "REQUIRED on the live path (not for a dry-run)." },
      CONFIRM_FLAG,
      { flag: "scope", value: "<x_scope>" },
      FORCE_DRY_RUN_FLAG,
      DEBUG_FLAG,
      JSON_FLAG,
    ],
    gate: "confirm",
    example:
      "dove-sn add-index --table x_cadso_journey_instance --columns occurrence_key --unique --update-set <sys_id> --confirm",
    notes: [
      "ABORTS before writing when the column holds duplicate values (EMPTY counts) or the duplicate scan hits its row cap — an unproven scan is treated like a proven collision.",
      "Success is read back from v_db_index, which has no uniqueness field, so ENFORCEMENT is always reported unverified.",
      "Exit 2 when the dictionary flag is set but no index was read back.",
    ],
  },
  "index-list": {
    summary: "List a table's DATABASE indexes from the v_db_index view",
    required: [{ flag: "table", value: "<name>" }],
    optional: [JSON_FLAG],
    gate: "read-only",
    example: "dove-sn index-list --table x_cadso_automate_message_batch_recipient --json",
    notes: [
      "v_db_index is the only index read surface (sys_index is API-ACL 403; sys_index_column does not exist). It has no uniqueness field, so WHICH indexes are unique is reported unverified.",
    ],
  },
  "index-create": {
    summary: "Create a DATABASE index (composite and non-unique included) by replaying the platform Database Indexes dialog's processor calls, pinned to an update set, then read it back",
    required: [
      { flag: "table", value: "<name>" },
      { flag: "columns", value: "<a[,b,...]>", note: "Comma-separated column elements, in index order." },
      { flag: "update-set", value: "<sys_id>", note: "Required on the live path; the index definition is captured into it. Must be in the table's application scope." },
    ],
    optional: [
      { flag: "unique" },
      { flag: "access-method", value: "<m>", note: "Platform access method (default: btree, as the dialog does)." },
      CONFIRM_FLAG,
      FORCE_DRY_RUN_FLAG,
      { flag: "poll-attempts", value: "<n>", note: "Positive integer." },
      { flag: "poll-interval-ms", value: "<n>", note: "Positive integer." },
      DEBUG_FLAG,
      JSON_FLAG,
    ],
    gate: "confirm",
    gateNote: "Nothing is sent OR read without --confirm.",
    example: "dove-sn index-create --table x_cadso_journey_instance --columns state,created_on --update-set <sys_id> --confirm",
    notes: [
      "An index IS captured in an update set: the build job writes a sys_update_xml row (type=Indexes) into the user's CURRENT set, so --update-set is pinned first and the capture row is read back from it. The physical index is still built per instance; committing the set elsewhere rebuilds it.",
      "Replays the dialog's own xmlhttp.do calls: IndexCreatorErrorChecker.canCreate (pre-flight) then ScheduleCreator.createSchedule. Idempotent: an index over exactly those columns returns already-exists with no write. --name is refused (the dialog has no name input; the real name is returned).",
      "Needs a username+password identity that can form-log-in (xmlhttp.do ignores Basic auth / API keys).",
      "Exit 2 when the index was scheduled but never read back from v_db_index, and when it was read back but its capture row was not found in the pinned set.",
    ],
  },

  "set-field": {
    summary: "Set field value(s) on an EXISTING record, into an update set, then verify",
    required: [
      { flag: "table", value: "<name>" },
      {
        flag: "sys-id | query",
        value: "<sys_id> | <encoded-query>",
        note: "A --query must resolve to exactly one row.",
      },
      { flag: "update-set", value: "<sys_id>", note: "The change is captured here." },
      {
        flag: "fields | from-json | from-stdin",
        value: '"k=v,k2=v2" | <path> | (JSON piped on stdin)',
        note: "At least one. --from-json / --from-stdin (alias --from-json -) take a JSON { field: value } object, win on a shared key, and are the only forms for large or multiline values. stdin is read ONLY with --from-stdin.",
      },
    ],
    optional: [DRY_RUN_FLAG, JSON_FLAG],
    gate: "dry-run-flag",
    example:
      'dove-sn set-field --table x_cadso_core_metric_point_type --query "name=send_size" --fields "order=20" --update-set <sys_id>',
    notes: ["Exit 2 when the write landed but the read-back is unverified."],
  },
  "create-record": {
    summary: "Create ONE NEW record in a data table, into an update set, then verify",
    required: [
      { flag: "table", value: "<name>" },
      { flag: "scope", value: "<x_scope>", note: "The app that owns the new record." },
      { flag: "update-set", value: "<sys_id>", note: "The insert is captured here." },
      {
        flag: "fields | from-json | from-stdin",
        value: '"k=v,k2=v2" | <path> | (JSON piped on stdin)',
        note: "At least one. --from-json / --from-stdin (alias --from-json -) take a JSON { field: value } object and win on a shared key. stdin is read ONLY with --from-stdin.",
      },
    ],
    optional: [
      { flag: "if-absent", value: "<encoded-query>", note: "Skip the insert when this query already matches a row." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example:
      'dove-sn create-record --table x_cadso_core_metric_point_type --scope x_cadso_core --fields "name=avg_parts,label=Avg Parts,order=35" --if-absent "name=avg_parts" --update-set <sys_id>',
    notes: ["Exit 2 when the write landed but the read-back is unverified (or --if-absent skipped with drift)."],
  },
  "delete-record": {
    summary: "Delete ONE EXISTING data record, then read it back to verify it is GONE",
    required: [
      { flag: "table", value: "<name>", note: "Plain table name; schema tables (sys_db_object / sys_dictionary) are refused." },
      { flag: "sys-id", value: "<32-hex>", note: "The record to delete — 32 lowercase hex characters." },
      {
        flag: "update-set",
        value: "<sys_id>",
        note: "Must exist and be in progress (checked on the dry-run too); pinned as current before the delete.",
      },
    ],
    optional: [
      { flag: "apply", note: "Delete for real (without it the run is a dry-run)." },
      { flag: "dry-run", note: "Force a dry-run even with --apply." },
      JSON_FLAG,
    ],
    gate: "apply",
    gateNote: "The dry-run prints the record snapshot that would be deleted.",
    example:
      "dove-sn delete-record --table x_cadso_core_metric_point_type --sys-id <32-hex sys_id> --update-set <sys_id> --apply",
    notes: [
      "Reads the record BEFORE (a missing record is an error, never a no-op delete) and AFTER (exit 2 if it is still present — including when the server refused the delete with an error).",
      "Until TenonHQ/Dovetail#297 ships server-side the delete op IGNORES --update-set and captures into the session's current update set — so the verb pins --update-set as current first (refusing, nothing deleted, if the pin does not read back) and reads the DELETE row back from sys_update_xml: exit 2 when it is not in the requested set.",
    ],
  },
  "host-assets": {
    summary: "Deploy a built dist/ to ServiceNow (carrier sys_ui_script + attachment + m2m)",
    required: [
      { flag: "dir", value: "<dist>", note: "Path to the pre-built dist/ directory." },
      { flag: "app", value: "<sys_id>", note: "Application record sys_id (m2m `application`)." },
      { flag: "scope", value: "<namespace>", note: "Carrier scope, e.g. x_cadso_app_shell." },
    ],
    optional: [
      { flag: "update-set", value: "<sys_id>", note: "Default: the scope's current update set." },
      { flag: "max-bytes", value: "<n>", note: "Per-chunk serve cap (default ~5 MB)." },
      { flag: "allow-oversize", note: "Warn instead of failing on an oversize chunk." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example: "dove-sn host-assets --dir ./dist --app <sys_id> --scope x_cadso_app_shell --dry-run",
    notes: ["Exit 2 when a write landed but its read-back is unverified."],
  },

  "create-view": {
    summary: "Create a custom view (sys_ui_view)",
    required: [{ flag: "name", value: "<name>" }, UPDATE_SET_FLAG],
    optional: [
      { flag: "title", value: "<text>" },
      { flag: "scope", value: "<x_scope>" },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example: 'dove-sn create-view --name sales_support --title "Sales Support" --update-set <sys_id>',
  },
  "set-list-layout": {
    summary: "Set the columns of a list layout",
    required: [
      { flag: "table", value: "<name>", note: "Or pass everything via --from-json." },
      { flag: "columns", value: '"<a,b,c>"', note: "Comma-separated elements, in display order." },
      UPDATE_SET_FLAG,
    ],
    optional: [
      { flag: "from-json", value: "<path>", note: "SetListLayoutParams JSON — replaces the flags above." },
      { flag: "view", value: "<name>", note: "Default view when omitted." },
      { flag: "parent", value: "<table>" },
      { flag: "scope", value: "<x_scope>" },
      { flag: "prune", value: "false", note: "Keep columns not in the list (default prunes them)." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example: 'dove-sn set-list-layout --table x_cadso_core_event --columns "number,state,sys_created_on" --update-set <sys_id>',
  },
  "set-form-layout": {
    summary: "Set the sections + fields of a form layout",
    required: [
      { flag: "from-json", value: "<path>", note: "SetFormLayoutParams JSON — sections are nested, so there is no inline form." },
    ],
    optional: [
      { flag: "update-set", value: "<sys_id>", note: "Overrides updateSetSysId in the spec." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example: "dove-sn set-form-layout --from-json ./form.json --dry-run",
  },
  "set-related-lists": {
    summary: "Set which related lists appear on a form",
    required: [
      { flag: "table", value: "<name>", note: "Or pass everything via --from-json." },
      { flag: "related-lists", value: '"<a,b>"', note: "Comma-separated related-list ids." },
      UPDATE_SET_FLAG,
    ],
    optional: [
      { flag: "from-json", value: "<path>", note: "SetRelatedListsParams JSON — replaces the flags above." },
      { flag: "view", value: "<name>" },
      { flag: "scope", value: "<x_scope>" },
      { flag: "prune", value: "false", note: "Keep related lists not in the list (default prunes them)." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example:
      'dove-sn set-related-lists --table x_cadso_core_event --related-lists "x_cadso_core_event_log.event" --update-set <sys_id>',
  },

  "view-flow": {
    summary: "Read a flow/subflow's compiled step graph",
    required: [{ flag: "sys-id", value: "<sys_id>", note: "sys_hub_flow sys_id (flow or subflow)." }],
    optional: [JSON_FLAG, { flag: "raw", note: "With --json: include the full processflow model." }],
    gate: "read-only",
    example: "dove-sn view-flow --sys-id <sys_id> --json --raw",
  },
  "view-action": {
    summary: "Read a Custom Action Type's model — inputs/outputs",
    required: [
      { flag: "sys-id", value: "<sys_id>", note: "sys_hub_action_type_definition sys_id." },
      { flag: "scope", value: "<sys_id>", note: "Application scope (sysparm_transaction_scope)." },
    ],
    optional: [JSON_FLAG, { flag: "raw", note: "With --json: include the full model." }],
    gate: "read-only",
    example: "dove-sn view-action --sys-id <action_sys_id> --scope <scope_sys_id>",
  },
  "publish-flow": {
    summary: "Compile a flow/subflow snapshot (publish the current design)",
    required: [{ flag: "sys-id", value: "<sys_id>", note: "sys_hub_flow sys_id (flow or subflow)." }],
    optional: [
      { flag: "scope", value: "<sys_id>", note: "sysparm_transaction_scope (default: the model's scope)." },
      JSON_FLAG,
    ],
    gate: "writes",
    gateNote: "POST /snapshot recompiles whatever is currently saved in the Designer.",
    example: "dove-sn publish-flow --sys-id <sys_id>",
  },
  "copy-flow": {
    summary: "Copy a flow/subflow as an INACTIVE DRAFT via the Designer's Copy API",
    required: [
      { flag: "sys-id", value: "<sys_id>", note: "Source sys_hub_flow sys_id." },
      { flag: "name", value: "<name>", note: "Name for the copy." },
    ],
    optional: [
      { flag: "scope", value: "<sys_id>", note: "Target scope (default: the source's scope)." },
      JSON_FLAG,
    ],
    gate: "writes",
    gateNote: "Creates a draft only; publish it with publish-flow. Do NOT publish a copy of a triggered production flow unless you intend it to fire.",
    example: 'dove-sn copy-flow --sys-id <sys_id> --name "My Copy"',
  },
  "create-flow": {
    summary: "Create a NEW flow from scratch and PUBLISH it (grafts a template's trigger+action graph)",
    required: [
      { flag: "name", value: "<name>" },
      { flag: "template", value: "<sys_id>", note: "Published sys_hub_flow whose trigger+action graph is grafted." },
      { flag: "scope", value: "<sys_id>", note: "Target scope (sysparm_transaction_scope)." },
    ],
    optional: [
      { flag: "internal-name", value: "<name>", note: "Default: a slug of --name." },
      { flag: "description", value: "<text>" },
      { flag: "trigger-table", value: "<table>", note: "Patch the trigger's table input." },
      { flag: "trigger-condition", value: "<encoded-query>", note: "Patch the trigger's condition." },
      { flag: "log-message", value: "<text>", note: "Patch the action's message / short_description." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    gateNote: "The result is a PUBLISHED flow — a published triggered flow can fire on its trigger.",
    example:
      'dove-sn create-flow --name "My Flow" --template <flow_sys_id> --scope <scope_sys_id> --trigger-table customer_contact --dry-run',
    notes: ["Exit 2 when the flow was created but the snapshot did not compile (not published)."],
  },
  "test-flow": {
    summary: "Validate (default) or run a flow/subflow",
    required: [{ flag: "sys-id", value: "<sys_id>", note: "sys_hub_flow sys_id (flow or subflow)." }],
    optional: [
      { flag: "execute", note: "Actually run it (default is validate-only)." },
      { flag: "confirm", note: "Required with --execute — the deliberate run-for-real gate." },
      { flag: "inputs", value: "'<json>'", note: "JSON object of flow inputs." },
      { flag: "inputs-json", value: "<path>", note: "Same, from a file." },
      { flag: "runner", value: "<path>", note: "Override the FlowAPI runner endpoint path." },
      JSON_FLAG,
    ],
    gate: "execute-confirm",
    example: 'dove-sn test-flow --sys-id <sys_id> --execute --confirm --inputs \'{"phone":"+15550100"}\'',
    notes: ["Exit 2 when validation (or the run) reports not ok."],
  },
  "edit-flow": {
    summary: "Patch a flow/subflow (rename, description, step inputs)",
    required: [
      { flag: "sys-id", value: "<sys_id>", note: "sys_hub_flow sys_id (flow or subflow)." },
      {
        flag: "from-json",
        value: "<path>",
        note: 'EditFlowOps JSON { "rename"?, "description"?, "patchStepInputs"? }.',
      },
    ],
    optional: [
      { flag: "apply", note: "Persist the edit (default is a dry-run diff)." },
      { flag: "update-set", value: "<sys_id>", note: "Required with --apply when ops include rename/description." },
      { flag: "scope", value: "<sys_id>", note: "sysparm_transaction_scope for the publish." },
      JSON_FLAG,
    ],
    gate: "apply",
    example: "dove-sn edit-flow --sys-id <sys_id> --from-json ops.json --apply --update-set <sys_id>",
  },
  "build-flow": {
    summary: "Author Custom Action Types and Subflows from a JSON spec (clone | create)",
    required: [{ flag: "from-json", value: "<path>", note: "JSON spec for the artifact (clone | create)." }],
    optional: [
      { flag: "update-set", value: "<sys_id>", note: "Overrides spec.updateSetSysId." },
      { flag: "dry-run", note: "Emit the planned write graph; do nothing." },
      { flag: "skip-publish", note: "Skip the publish trigger entirely." },
      JSON_FLAG,
    ],
    gate: "dry-run-flag",
    example: "dove-sn build-flow --from-json ./spec.json --dry-run",
    notes: [
      "Exit codes mirror BuildFlowResult.outcome: 0 done/unchanged/dry-run, 2 needs-ui-publish, 3 verify-mismatch, 4 write-failed (discard the update set to roll back), 5 unrecoverable.",
    ],
  },

  "edit-action": {
    summary: "Patch a published Custom Action Type and republish (snapshot)",
    required: [
      { flag: "sys-id", value: "<sys_id>", note: "sys_hub_action_type_definition sys_id." },
      { flag: "scope", value: "<sys_id>", note: "sysparm_transaction_scope (app scope sys_id)." },
    ],
    optional: [
      {
        flag: "from-json",
        value: "<ops.json>",
        note: 'EditActionTypeOps — the full surface: { "patchStepScripts", "addStepOutputs", "addStepInputs", ... }; `step` is a cid or label, `scriptFile` resolves relative to the ops file.',
      },
      { flag: "patch-script", value: '"<find>::<replace>"', note: "Find/replace in the auto-detected script step." },
      { flag: "set-script", value: "<path>", note: "Replace the auto-detected script step value from a file." },
      { flag: "merge-outputs", value: "<path>", note: "JSON output-variable object/array to merge by name." },
      { flag: "script-input", value: "<name>", note: "Input holding the script (default: auto-detect)." },
      { flag: "update-set", value: "<sys_id>", note: "Capture the republish here." },
      { flag: "apply", note: "Republish (POST /snapshot). Omit for a dry-run." },
      JSON_FLAG,
    ],
    gate: "apply",
    example: 'dove-sn edit-action --sys-id <sys_id> --scope <scope_sys_id> --patch-script "foo::bar" --apply --update-set <sys_id>',
    notes: ["Exit 2 when the post-publish read-back does not match."],
  },
  "clone-action": {
    summary: "Clone a Custom Action Type (all steps + step IO) into a scope and publish it",
    required: [
      { flag: "from", value: "<sys_id>", note: "Source sys_hub_action_type_definition sys_id." },
      { flag: "name", value: "<name>", note: "Display name of the clone (idempotency key with --scope)." },
      { flag: "scope", value: "<name|sys_id>", note: "Target scope — a scope name (x_cadso_email_spok) or 32-hex sys_id." },
    ],
    optional: [
      { flag: "internal-name", value: "<name>", note: "Default: slug of --name." },
      { flag: "description", value: "<text>" },
      {
        flag: "ops",
        value: "<path>",
        note: "StepOps JSON applied before publish: patchStepScripts / setStepInputs / addStepOutputs / addStepInputs.",
      },
      { flag: "update-set", value: "<sys_id>", note: "Required with --confirm — every write + the publish land here." },
      CONFIRM_FLAG,
      FORCE_DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "confirm",
    example:
      'dove-sn clone-action --from <source_sys_id> --name "Send REST (Spoke)" --scope x_cadso_email_spok --update-set <sys_id> --confirm',
    notes: ["Idempotent on (name, scope). Publishes via the snapshot path and reads the steps back to verify (exit 1 on a failed verify)."],
    stringFlags: ["from", "name", "scope", "internal-name", "description", "ops", "update-set"],
  },
  "define-action": {
    summary: "Define a Custom Action Type's inputs, outputs and steps the way the Designer's Save does, then optionally publish",
    required: [
      { flag: "sys-id", value: "<sys_id>", note: "The action shell must exist (clone-action or the Designer)." },
      { flag: "scope", value: "<name|sys_id>", note: "The action's own scope." },
      {
        flag: "spec",
        value: "<spec.json>",
        note: 'Every part optional: { "action", "inputs", "outputs", "steps" }; `scriptFile` resolves relative to the spec file.',
      },
    ],
    optional: [
      { flag: "update-set", value: "<sys_id>", note: "Pin the REST session to this update set before the save/publish." },
      { flag: "publish", note: "With --confirm: also publish (snapshot) after the save." },
      CONFIRM_FLAG,
      FORCE_DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "confirm",
    example: "dove-sn define-action --sys-id <sys_id> --scope x_cadso_email_spok --spec spec.json --confirm --publish",
    notes: ["Idempotent: a spec already in effect makes no PUT. Exit 1 on a failed read-back verify."],
    stringFlags: ["sys-id", "scope", "spec", "update-set"],
  },

  "invoke-rest": {
    summary: "Invoke an arbitrary authenticated REST operation (Scripted REST included)",
    required: [
      { flag: "method", value: "<GET|POST|PUT|DELETE>" },
      { flag: "path", value: "</api/...>", note: "Instance-relative; must start with /api/." },
    ],
    optional: [
      { flag: "body", value: "'<json>'", note: "Inline JSON request body." },
      { flag: "body-json", value: "<path>", note: "Request body from a JSON file." },
      {
        flag: "out",
        value: "<file>",
        note: "Also write the full structured result to a file (atomic; OVERWRITES) — the reliable channel for large bodies.",
      },
      CONFIRM_FLAG,
      FORCE_DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "confirm",
    example: "dove-sn invoke-rest --method GET --path /api/now/table/sys_user?sysparm_limit=1 --confirm --json",
    notes: [
      "Bodies are NEVER printed in human output (request or response); --json is the one channel that carries them.",
      "Exit 2 when sent but the response is non-2xx.",
    ],
  },

  "publish-app": {
    summary: "Publish a scoped app to the Store, the company repository and/or a new update set, then poll to completion",
    required: [
      { flag: "app", value: "<scope|sys_id|name>" },
      { flag: "version", value: "<v>", note: "e.g. 6.0.20260716" },
      {
        flag: "target",
        value: "<store|repo|repo-ui|update-set|both>",
        note: "Comma-separated ok; both = store,repo. repo needs the sn_cicd plugin; repo-ui uses the UI uploader instead.",
      },
    ],
    optional: [
      { flag: "dev-notes", value: "<text>", note: "Developer notes (uploader targets)." },
      { flag: "store-user", value: "<email>", note: "Store account (else SN_STORE_USERNAME). The password comes ONLY from SN_STORE_PASSWORD — never a flag." },
      { flag: "timeout-ms", value: "<n>", note: "Progress-poll budget, positive integer (default 120000)." },
      { flag: "update-set-name", value: "<name>", note: "update-set target only; default the app's name." },
      { flag: "update-set-description", value: "<text>", note: "update-set target only; Tenon convention is the YYYYMMDD release stamp." },
      { flag: "include-data", note: "update-set target only; include demo data." },
      CONFIRM_FLAG,
      FORCE_DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "confirm",
    gateNote: "Without --confirm the resolved plan is printed and the command exits 1 (a deliberate refusal). STORE PUBLISH IS EXTERNALLY VISIBLE.",
    example: "dove-sn publish-app --app x_cadso_core --version 6.0.20260716 --target update-set --confirm",
    notes: ["Multiple targets run sequentially and short-circuit on the first failure. Exit 2 on failed/timeout."],
  },
  "export-update-set": {
    summary: "Export an update set to importable <unload> XML with secret values replaced by __SET_DURING_INSTALL__",
    required: [
      { flag: "update-set", value: "<sys_id|name>" },
      { flag: "out", value: "<file>", note: "Required unless --dry-run; the XML is never written to stdout." },
    ],
    optional: [
      {
        flag: "mode",
        value: "<assemble|complete>",
        note: "assemble (default) is READ-ONLY; complete marks the set complete on the instance first.",
      },
      { flag: "rules", value: "<file>", note: "JSON overrides for the secret rules." },
      { flag: "page-size", value: "<n>", note: "Positive integer." },
      { flag: "max-rows", value: "<n>", note: "Positive integer." },
      { flag: "confirm", note: "Required for --mode complete." },
      DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "read-only",
    gateNote: "That is assemble mode. --mode complete is a real write (marks the set complete) and needs --confirm.",
    example: "dove-sn export-update-set --update-set <sys_id> --out ./release.xml",
    notes: [
      "Secret stripping has no opt-out; a secret-looking field covered by no rule fails the run and nothing is written.",
      "Exit 1 when complete mode runs unconfirmed; 2 on failure.",
    ],
  },
  "export-app": {
    summary: "Publish a scoped app into a new update set and export it as stripped XML",
    required: [
      { flag: "app", value: "<scope|sys_id|name>" },
      { flag: "out", value: "<file>", note: "Required unless --dry-run." },
    ],
    optional: [
      { flag: "version", value: "<v>", note: "Default: the app's current version." },
      { flag: "description", value: "<text>", note: "Recorded on the update set." },
      { flag: "include-data", note: "Ship table DATA as well as schema." },
      { flag: "keep-set", value: "false", note: "Delete the publish update set afterwards (default keeps it)." },
      { flag: "rules", value: "<file>", note: "JSON overrides for the secret rules." },
      { flag: "timeout-ms", value: "<n>", note: "Positive integer." },
      CONFIRM_FLAG,
      FORCE_DRY_RUN_FLAG,
      JSON_FLAG,
    ],
    gate: "confirm",
    gateNote: "PUBLISHING IS A REAL INSTANCE WRITE — a new update set and ~1000+ records.",
    example: "dove-sn export-app --app x_cadso_core --out ./core.xml --confirm",
    notes: ["Exit 1 when run unconfirmed; 2 on failure/timeout."],
  },
  "strip-secrets": {
    summary: "Strip secret values from an unload XML exported elsewhere",
    required: [{ flag: "in", value: "<file>", note: "An unload XML exported earlier." }],
    optional: [
      { flag: "out", value: "<file>", note: "Required unless --report." },
      { flag: "rules", value: "<file>", note: "JSON overrides for the secret rules." },
      { flag: "report", note: "List what WOULD be stripped and what needs review; write nothing." },
      JSON_FLAG,
    ],
    gate: "local",
    example: "dove-sn strip-secrets --in ./export.xml --out ./export.stripped.xml",
    notes: ["Exit 2 when a field needs review or a secret survived."],
  },

  mcp: {
    summary: "Run the dove-sn MCP stdio server (--smoke lists the registered tools and exits)",
    required: [],
    optional: [{ flag: "smoke", note: "List registered tools and exit; no instance call." }],
    gate: "server",
    example: "dove-sn mcp --smoke",
  },
  help: {
    summary: "Show this index, or the full usage of one verb",
    required: [],
    optional: [],
    gate: "local",
    example: "dove-sn help add-choices",
    notes: ["Forms: dove-sn help | dove-sn --help | dove-sn help <verb> | dove-sn <verb> --help."],
  },
};

/** Verb names in index order. */
export var VERB_NAMES: Array<string> = Object.keys(VERB_USAGE);

var MAX_VERB_INPUT_LENGTH = 64;

/**
 * Reduce raw user input to a comparable verb key: lower-case, trimmed, `_` → `-` (MCP tool
 * names use underscores), anything outside [a-z0-9-] dropped, capped in length. The
 * result is the ONLY form of user input that is ever echoed back or looked up.
 */
export function normalizeVerbInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, MAX_VERB_INPUT_LENGTH);
}

export function isKnownVerb(verb: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERB_USAGE, verb);
}

/** The usage entry for a verb, or null for an unknown one. */
export function usageFor(verb: string): VerbUsage | null {
  return isKnownVerb(verb) ? VERB_USAGE[verb] : null;
}

/**
 * Closest known verbs to a mistyped one, by simple prefix / substring in either
 * direction (so "choices" → add-choices, remove-choices; "set-colum" → set-column;
 * "action-clone" → clone-action). Empty input or no overlap → [].
 */
export function findClosestVerbs(raw: unknown): Array<string> {
  var needle = normalizeVerbInput(raw);
  if (needle.length === 0) return [];
  // Pass 1: the whole input is a prefix/substring of a verb, or vice versa.
  var direct: Array<string> = [];
  for (var i = 0; i < VERB_NAMES.length; i += 1) {
    var name = VERB_NAMES[i];
    if (name.indexOf(needle) !== -1 || needle.indexOf(name) !== -1) {
      direct.push(name);
    }
  }
  if (direct.length > 0) return direct;
  // Pass 2 (only when pass 1 found nothing): any dash-separated token of 3+ chars —
  // "action-clone" → the *-action verbs. Shorter tokens ("set") match too much.
  var parts = needle.split("-").filter(function (p) {
    return p.length >= 3;
  });
  var byToken: Array<string> = [];
  for (var v = 0; v < VERB_NAMES.length; v += 1) {
    for (var p = 0; p < parts.length; p += 1) {
      if (VERB_NAMES[v].indexOf(parts[p]) !== -1) {
        byToken.push(VERB_NAMES[v]);
        break;
      }
    }
  }
  if (byToken.length > 0) return byToken;
  // Pass 3: a typo in the tail ("choises") — try ever-shorter leading prefixes, down to
  // 4 chars, as a substring. Shorter than that and every verb is a neighbour.
  for (var len = needle.length - 1; len >= 4; len -= 1) {
    var prefix = needle.slice(0, len);
    var byPrefix: Array<string> = [];
    for (var w = 0; w < VERB_NAMES.length; w += 1) {
      if (VERB_NAMES[w].indexOf(prefix) !== -1) byPrefix.push(VERB_NAMES[w]);
    }
    if (byPrefix.length > 0) return byPrefix;
  }
  return [];
}

var FLAG_COLUMN_WIDTH = 34;

function renderFlag(doc: FlagDoc): string {
  var names = doc.flag.split(" | ").map(function (f) {
    return "--" + f;
  });
  return names.join(" | ") + (doc.value ? " " + doc.value : "");
}

function padRight(text: string, width: number): string {
  var out = text;
  while (out.length < width) out += " ";
  return out;
}

function renderFlagLines(docs: Array<FlagDoc>): string {
  if (docs.length === 0) return "  (none)\n";
  var out = "";
  for (var i = 0; i < docs.length; i += 1) {
    var head = renderFlag(docs[i]);
    var note = docs[i].note;
    if (!note) {
      out += "  " + head + "\n";
    } else if (head.length + 2 <= FLAG_COLUMN_WIDTH) {
      out += "  " + padRight(head, FLAG_COLUMN_WIDTH) + note + "\n";
    } else {
      out += "  " + head + "\n" + padRight("", FLAG_COLUMN_WIDTH + 2) + note + "\n";
    }
  }
  return out;
}

/** The full usage block for one verb. Throws on an unknown verb — callers check first. */
export function formatVerbUsage(verb: string): string {
  var usage = usageFor(verb);
  if (!usage) {
    throw new Error("No usage entry for verb '" + normalizeVerbInput(verb) + "'");
  }
  var out = "dove-sn " + verb + " — " + usage.summary + "\n\n";
  out += "Required:\n" + renderFlagLines(usage.required);
  out += "Optional:\n" + renderFlagLines(usage.optional);
  out += "Write gate:\n  " + GATE_TEXT[usage.gate];
  if (usage.gateNote) out += " " + usage.gateNote;
  out += "\n";
  if (usage.notes && usage.notes.length > 0) {
    out += "Notes:\n";
    for (var n = 0; n < usage.notes.length; n += 1) {
      out += "  - " + usage.notes[n] + "\n";
    }
  }
  out += "Example:\n  " + usage.example + "\n";
  out += "Global:\n" + renderFlagLines(GLOBAL_FLAGS);
  return out;
}

/** The verb index printed by `dove-sn help` / `dove-sn --help` / bare `dove-sn`. */
export function formatVerbIndex(): string {
  var width = 0;
  for (var i = 0; i < VERB_NAMES.length; i += 1) {
    if (VERB_NAMES[i].length > width) width = VERB_NAMES[i].length;
  }
  var out =
    "dove-sn — ServiceNow platform helpers\n\n" +
    "Usage:\n" +
    "  dove-sn <verb> [flags]\n" +
    "  dove-sn help <verb>       required/optional flags, value formats, write gate, example\n" +
    "  dove-sn <verb> --help     same, and never touches the instance\n\n" +
    "Verbs:\n";
  for (var v = 0; v < VERB_NAMES.length; v += 1) {
    out += "  " + padRight(VERB_NAMES[v], width + 2) + VERB_USAGE[VERB_NAMES[v]].summary + "\n";
  }
  out += "\nGlobal flags:\n" + renderFlagLines(GLOBAL_FLAGS);
  out +=
    "\nFlow Designer auth: /api/now/processflow/* can't carry an API access policy, so under\n" +
    "SN_API_KEY those calls use a dedicated basic-auth identity — SN_FLOW_USER / SN_FLOW_PASSWORD\n" +
    "(or SN_DEV_FLOW_* / SN_PROD_FLOW_*).\n" +
    "\nRun `dove-sn help <verb>` for one verb's full usage.\n";
  return out;
}

/**
 * The message for a verb that is not in the table: names the (sanitized) input, lists the
 * closest matches when there are any, and points at the index.
 */
export function formatUnknownVerb(raw: unknown): string {
  var shown = normalizeVerbInput(raw);
  var close = findClosestVerbs(shown);
  var out = "dove-sn: unknown verb '" + (shown || "(empty)") + "'.";
  if (close.length > 0) {
    out += " Did you mean: " + close.join(", ") + "?";
  }
  out += "\nRun `dove-sn help` for the verb index.\n";
  return out;
}
