export interface TableField {
  name: string;
  label: string;
  type: string;
  max_length: string;
  mandatory: boolean;
  reference: string;
  default_value: string;
  inherited_from: string | null;
}

export interface RawTableData {
  label: string;
  scope: string;
  parent: string | null;
  hierarchy: string[];
  fields: TableField[];
}

export interface RawSchemaMap {
  [tableName: string]: RawTableData;
}

export interface TableSchema {
  table_name: string;
  label: string;
  scope: string;
  parent: string | null;
  hierarchy: string[];
  field_count: number;
  fields: TableField[];
}

export interface AppSummary {
  application: string;
  table_count: number;
  tables: Array<{
    name: string;
    label: string;
    field_count: number;
    has_parent: boolean;
  }>;
}

export interface SchemaIndex {
  instance: string;
  // Optional: the generator no longer stamps a per-pull timestamp into the
  // tracked dump (it produced 100% diff noise). Kept optional so snapshots and
  // older baselines that still carry it remain readable for diffs.
  generated_at?: string;
  total_tables: number;
  scopes: string[];
  applications: Array<{
    name: string;
    table_count: number;
    tables: string[];
  }>;
}

export interface SchemaOptions {
  instance: string;
  username: string;
  password: string;
  /** Inbound REST API key (x-sn-apikey). When set it is the default auth mode and basic auth is not sent. */
  apiKey?: string;
  outputDir: string;
  scopes: string[];
}

export interface OrganizeOptions {
  schema: RawSchemaMap;
  outputDir: string;
  instance: string;
  scopes: string[];
}

export interface AppTableGroup {
  [appName: string]: RawSchemaMap;
}

// ---------------------------------------------------------------------------
// Snapshot + diff
// ---------------------------------------------------------------------------

export type Severity = "BREAKING" | "WARN" | "INFO";

export interface SnapshotManifest {
  instance: string;
  label: string | null;
  created_at: string;
  scopes: string[];
  total_tables: number;
}

export interface SnapshotInfo extends SnapshotManifest {
  dir: string;
}

// A field reduced to comparable primitives. `type`/`reference` are coerced from
// either a string or a legacy {link,value} object; `inherited_from` is dropped.
export interface NormalizedField {
  name: string;
  label: string;
  type: string;
  max_length: string;
  mandatory: boolean;
  reference: string;
  default_value: string;
}

export interface NormalizedTable {
  table_name: string;
  label: string;
  scope: string;
  fields: NormalizedField[];
}

export interface NormalizedSchema {
  instance: string;
  generated_at: string | null;
  tables: { [tableName: string]: NormalizedTable };
}

export type TableChangeKind = "added" | "removed";

export interface TableChange {
  table: string;
  change: TableChangeKind;
  severity: Severity;
}

export type FieldChangeKind =
  | "added"
  | "removed"
  | "retyped"
  | "length_shrunk"
  | "length_grew"
  | "newly_mandatory"
  | "now_optional"
  | "retargeted"
  | "default_changed"
  | "label_changed";

export interface FieldChange {
  table: string;
  field: string;
  change: FieldChangeKind;
  severity: Severity;
  from?: string | boolean | null;
  to?: string | boolean | null;
}

export interface SchemaDiff {
  instance: string;
  from: { ref: string; generated_at: string | null };
  to: { ref: string; generated_at: string | null };
  scope: string | null;
  summary: { breaking: number; warn: number; info: number };
  tables: TableChange[];
  fields: FieldChange[];
  exit_code: number;
}
