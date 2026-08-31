import axios, { AxiosInstance } from "axios";
import chalk from "chalk";
import { SchemaOptions, RawSchemaMap, TableField } from "./types";
import { logger } from "./logger";

function createClient(options: {
  instance: string;
  username: string;
  password: string;
  apiKey?: string;
}): AxiosInstance {
  const baseURL = options.instance.startsWith("https://")
    ? options.instance
    : `https://${options.instance}`;

  // An inbound API key is the default auth mode when present: the
  // x-sn-apikey header replaces basic auth entirely.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (options.apiKey) {
    headers["x-sn-apikey"] = options.apiKey;
  }

  return axios.create({
    baseURL: baseURL.endsWith("/") ? baseURL : baseURL + "/",
    auth: options.apiKey
      ? undefined
      : {
          username: options.username,
          password: options.password,
        },
    headers,
  });
}

async function getTablesForScope(options: {
  client: AxiosInstance;
  scope: string;
}): Promise<Array<{ name: string; label: string; super_class: any }>> {
  const { client, scope } = options;
  const response = await client.get("api/now/table/sys_db_object", {
    params: {
      sysparm_query: `nameSTARTSWITH${scope}_`,
      sysparm_fields: "name,label,super_class",
    },
  });

  return response.data.result || [];
}

async function getTableHierarchy(options: {
  client: AxiosInstance;
  tableName: string;
  visited?: Set<string>;
}): Promise<string[]> {
  const { client, tableName } = options;
  const visited = options.visited || new Set<string>();

  if (visited.has(tableName)) {
    return [];
  }

  visited.add(tableName);

  try {
    const response = await client.get("api/now/table/sys_db_object", {
      params: {
        sysparm_query: `name=${tableName}`,
        sysparm_fields: "name,super_class,label",
      },
    });

    if (response.data.result && response.data.result.length > 0) {
      const table = response.data.result[0];
      const hierarchy = [tableName];

      if (table.super_class && table.super_class.value) {
        const parentResponse = await client.get(
          `api/now/table/sys_db_object/${table.super_class.value}`,
          {
            params: { sysparm_fields: "name" },
          }
        );

        if (parentResponse.data.result && parentResponse.data.result.name) {
          const parentHierarchy = await getTableHierarchy({
            client,
            tableName: parentResponse.data.result.name,
            visited,
          });
          hierarchy.push(...parentHierarchy);
        }
      }

      return hierarchy;
    }
  } catch (error: any) {
    logger.warn("Error getting hierarchy for " + tableName + ": " + error.message);
  }

  return [tableName];
}

async function getTableFields(options: {
  client: AxiosInstance;
  tableName: string;
}): Promise<TableField[]> {
  const { client, tableName } = options;

  try {
    const query = `internal_type!=collection^ORinternal_type=NULL^name=${tableName}`;
    const response = await client.get("api/now/table/sys_dictionary", {
      params: {
        sysparm_query: query,
        sysparm_fields: "element,column_label,internal_type,max_length,mandatory,reference,default_value",
      },
    });

    if (response.data.result) {
      return response.data.result.map((field: any) => ({
        name: field.element,
        label: field.column_label,
        type: field.internal_type && field.internal_type.value
          ? field.internal_type.value
          : field.internal_type || "",
        max_length: field.max_length || "",
        mandatory: field.mandatory === "true",
        reference: field.reference || "",
        default_value: field.default_value || "",
        inherited_from: null,
      }));
    }
  } catch (error: any) {
    logger.warn("Error getting fields for " + tableName + ": " + error.message);
  }

  return [];
}

export async function fetchSchema(options: SchemaOptions): Promise<RawSchemaMap> {
  const { scopes } = options;
  const client = createClient({
    instance: options.instance,
    username: options.username,
    password: options.password,
    apiKey: options.apiKey,
  });

  logger.info("Fetching table schemas for " + scopes.length + " scopes...");

  const schema: RawSchemaMap = {};

  for (const scope of scopes) {
    logger.info("\nScope: " + scope);

    const tables = await getTablesForScope({ client, scope });

    if (tables.length === 0) {
      logger.warn("No tables found for scope " + scope);
      continue;
    }

    logger.success("Found " + tables.length + " tables");

    for (const table of tables) {
      logger.item("Processing: " + chalk.cyan(table.name) + " (" + table.label + ")");

      const hierarchy = await getTableHierarchy({ client, tableName: table.name });
      logger.detail("Hierarchy: " + hierarchy.join(" -> "));

      const allFields = new Map<string, TableField>();

      for (let i = hierarchy.length - 1; i >= 0; i--) {
        const hierarchyTableName = hierarchy[i];
        const fields = await getTableFields({ client, tableName: hierarchyTableName });

        for (const field of fields) {
          allFields.set(field.name, {
            ...field,
            inherited_from: i > 0 ? hierarchyTableName : null,
          });
        }
      }

      schema[table.name] = {
        label: table.label,
        scope,
        parent: hierarchy.length > 1 ? hierarchy[1] : null,
        hierarchy,
        fields: Array.from(allFields.values()),
      };

      logger.detail(allFields.size + " fields (including inherited)");
    }
  }

  logger.success("\nFetched schema for " + Object.keys(schema).length + " tables across " + scopes.length + " scopes");
  return schema;
}
