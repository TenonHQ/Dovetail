export namespace Sinc {
  interface SharedCmdArgs {
    logLevel: string;
  }

  interface CmdDownloadArgs extends SharedCmdArgs {
    scope: string;
  }
  interface PushCmdArgs extends SharedCmdArgs {
    target?: string;
    diff: string;
    scopeSwap: boolean;
    updateSet: string;
    ci: boolean;
  }
  interface BuildCmdArgs extends SharedCmdArgs {
    diff: string;
  }
  interface WatchCmdArgs extends SharedCmdArgs {
    noDashboard: boolean;
    port?: number;
    monitorInterval?: number;
    noMonitoring?: boolean;
  }
  interface Config {
    sourceDirectory: string;
    buildDirectory: string;
    rules?: PluginRule[];
    includes?: TablePropMap;
    excludes?: TablePropMap;
    tableOptions: ITableOptionsMap;
    refreshInterval: number;
  }
  interface ScopedConfigsMap {
    [scope: string]: Config;
  }
  interface ScopedConfig extends Config {
    scopes?: ScopedConfigsMap;
  }

  interface ITableOptionsMap {
    [table: string]: ITableOptions;
  }

  interface ITableOptions {
    displayField?: string;
    differentiatorField?: string | string[];
    query: string;
  }

  interface FieldConfig {
    type: SN.FileType;
  }
  interface FieldMap {
    [fieldName: string]: FieldConfig;
  }
  interface TablePropMap {
    [key: string]: boolean | FieldMap | string[] | { [scope: string]: any };
  }
  interface PluginRule {
    match: RegExp;
    plugins: PluginConfig[];
  }
  interface PluginConfig {
    name: string;
    options: { [property: string]: any };
  }
  interface FileSyncParams {
    filePath: string;
    name: string;
    tableName: string;
    targetField: string;
    ext: string;
  }

  interface FileContext extends FileSyncParams {
    sys_id: string;
    scope: string;
    fileContents?: string;
  }

  interface ServerRequestConfig {
    url: string;
    data: string;
    method: string;
  }

  interface Plugin {
    run: PluginFunc;
  }

  interface PluginFunc {
    (
      context: FileContext,
      content: string,
      options: any,
    ): Promise<PluginResults>;
  }

  interface PluginResults {
    success: boolean;
    output: string;
  }

  type TransformResults = {
    success: boolean;
    content: string;
  };

  interface LoginAnswers {
    instance: string;
    username: string;
    password: string;
    /** Inbound REST API key (x-sn-apikey). Optional; becomes the default auth mode when set. */
    apiKey?: string;
  }

  interface AppSelectionAnswer {
    app: string;
  }

  interface DiffFile {
    changed: Array<string>;
  }

  type RecordContextMap = Record<string, FileContext>;
  type TableContextTree = Record<string, RecordContextMap>;
  type AppFileContextTree = Record<string, TableContextTree>;

  interface PushResult {
    success: boolean;
    message: string;
  }

  interface BuildResult extends PushResult {}

  interface BuildRecord {
    result: Sinc.PromiseResult<Record<string, string>>;
    summary: string;
    context: Sinc.FileContext;
  }

  type SuccessPromiseResult<T> = { status: "fulfilled"; value: T };
  type FailPromiseResult = { status: "rejected"; reason: any };
  type PromiseResult<T> = SuccessPromiseResult<T> | FailPromiseResult;

  // ============================================================================
  // Init Plugin System
  // Packages export a `sincPlugin` object conforming to InitPlugin.
  // Core discovers these at runtime via node_modules scan.
  // ============================================================================

  interface InitPlugin {
    name: string;
    displayName: string;
    description: string;
    login?: InitLoginHook[];
    configure?: InitConfigureHook[];
    initialize?: (context: InitContext) => Promise<void>;
  }

  interface InitLoginHook {
    envKey: string;
    prompt: {
      type: "input" | "password";
      message: string;
      mask?: string;
    };
    validate?: (value: string, context: InitContext) => Promise<true | string>;
    instructions?: string[];
    required?: boolean;
  }

  interface InitConfigureHook {
    key: string;
    label: string;
    run: (context: InitContext) => Promise<any>;
  }

  interface InitContext {
    env: Record<string, string>;
    answers: Record<string, any>;
    rootDir: string;
    hasConfig: boolean;
    inquirer: any;
    chalk: any;
  }

  interface SNAPIResponse<T> {
    result: T;
  }

  interface BuildableRecord {
    table: string;
    sysId: string;
    fields: Record<string, Sinc.FileContext>;
  }

  interface RecBuildFail {
    success: false;
    message: string;
  }

  interface RecBuildSuccess {
    success: true;
    builtRec: Record<string, string>;
  }

  type RecBuildRes = RecBuildFail | RecBuildSuccess;
}

export namespace SN {
  interface AppManifest {
    tables: TableMap;
    scope: string;
  }

  interface TableMap {
    [tableName: string]: TableConfig;
  }

  interface TableConfig {
    records: TableConfigRecords;
  }

  interface TableConfigRecords {
    [name: string]: MetaRecord;
  }

  interface MetaRecord {
    files: File[];
    name: string;
    sys_id: string;
  }

  interface File {
    name: string;
    type: FileType;
    content?: string;
  }

  interface Field {
    name: string;
    type: string;
  }

  interface Record {
    sys_id: string;
  }

  interface TableAPIResult {
    result: Record[];
  }

  type FileType = "js" | "css" | "xml" | "html" | "scss" | "txt" | "json";

  interface TypeMap {
    [type: string]: string;
  }

  interface MissingFileTableMap {
    [tableName: string]: MissingFileRecord;
  }
  interface MissingFileRecord {
    [sys_id: string]: File[];
  }
  interface ScopeObj {
    scope: string;
    sys_id: string;
  }
  interface App {
    scope: string;
    displayName: string;
    sys_id: string;
  }

  interface UserRecord {
    sys_id: string;
  }

  interface UserPrefRecord {
    sys_id: string;
  }

  interface ScopeRecord {
    sys_id: string;
    // Scope name (e.g. "x_cadso_core"). Present when the read selects it; used
    // to reverse-resolve a scope sys_id back to its name for push routing.
    scope?: string;
  }

  interface UpdateSetRecord {
    sys_id: string;
  }
}

export type TSFIXME = any;
