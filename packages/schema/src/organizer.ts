import { promises as fsp } from "fs";
import path from "path";
import chalk from "chalk";
import {
  RawSchemaMap,
  TableSchema,
  AppSummary,
  SchemaIndex,
  OrganizeOptions,
  AppTableGroup,
} from "./types";
import { logger } from "./logger";

function getAppName(scope: string): string {
  // Extract the app short name from the scope identifier.
  // Pattern: x_{vendor}_{app} -> {app}
  // Examples:
  //   x_cadso_work     -> work
  //   x_cadso_ti_agile -> ti_agile
  //   x_nuvo_sinc      -> sinc
  const parts = scope.split("_");
  // First two parts are the vendor prefix (x, vendor)
  if (parts.length > 2) {
    return parts.slice(2).join("_");
  }
  return scope;
}

export function groupByApplication(options: {
  schema: RawSchemaMap;
}): AppTableGroup {
  const { schema } = options;
  const tablesByApp: AppTableGroup = {};

  for (const [tableName, tableData] of Object.entries(schema)) {
    const appName = getAppName(tableData.scope);

    if (!tablesByApp[appName]) {
      tablesByApp[appName] = {};
    }

    tablesByApp[appName][tableName] = tableData;
  }

  return tablesByApp;
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fsp.mkdir(dirPath, { recursive: true });
  } catch (e: any) {
    if (e.code !== "EEXIST") {
      throw e;
    }
  }
}

async function writeTableFiles(options: {
  appDir: string;
  tables: RawSchemaMap;
}): Promise<void> {
  const { appDir, tables } = options;

  for (const [tableName, tableData] of Object.entries(tables)) {
    const enhancedData: TableSchema = {
      table_name: tableName,
      label: tableData.label,
      scope: tableData.scope,
      parent: tableData.parent,
      hierarchy: tableData.hierarchy,
      field_count: tableData.fields.length,
      fields: tableData.fields,
    };

    const filePath = path.join(appDir, `${tableName}.json`);
    await fsp.writeFile(filePath, JSON.stringify(enhancedData, null, 2));
  }
}

async function writeSummary(options: {
  appDir: string;
  appName: string;
  tables: RawSchemaMap;
}): Promise<void> {
  const { appDir, appName, tables } = options;

  const summary: AppSummary = {
    application: appName,
    table_count: Object.keys(tables).length,
    tables: Object.keys(tables).map((tableName) => ({
      name: tableName,
      label: tables[tableName].label,
      field_count: tables[tableName].fields.length,
      has_parent: !!tables[tableName].parent,
    })),
  };

  const summaryPath = path.join(appDir, "_summary.json");
  await fsp.writeFile(summaryPath, JSON.stringify(summary, null, 2));
}

async function writeIndex(options: {
  outputDir: string;
  tablesByApp: AppTableGroup;
  instance: string;
  scopes: string[];
  totalTables: number;
}): Promise<SchemaIndex> {
  const { outputDir, tablesByApp, instance, scopes, totalTables } = options;

  const index: SchemaIndex = {
    instance,
    total_tables: totalTables,
    scopes,
    applications: Object.keys(tablesByApp).map((appName) => ({
      name: appName,
      table_count: Object.keys(tablesByApp[appName]).length,
      tables: Object.keys(tablesByApp[appName]),
    })),
  };

  const indexPath = path.join(outputDir, "index.json");
  await fsp.writeFile(indexPath, JSON.stringify(index, null, 2));

  return index;
}

export async function organizeSchema(options: OrganizeOptions): Promise<SchemaIndex> {
  const { schema, outputDir, instance, scopes } = options;

  await ensureDir(outputDir);

  const tablesByApp = groupByApplication({ schema });

  const totalTables = Object.keys(schema).length;

  logger.info("\nOrganizing " + totalTables + " tables into " + Object.keys(tablesByApp).length + " applications...");

  for (const [appName, tables] of Object.entries(tablesByApp)) {
    const appDir = path.join(outputDir, appName);
    await ensureDir(appDir);

    await writeTableFiles({ appDir, tables });
    await writeSummary({ appDir, appName, tables });

    logger.item(chalk.cyan(appName) + ": " + Object.keys(tables).length + " tables");
  }

  const index = await writeIndex({
    outputDir,
    tablesByApp,
    instance,
    scopes,
    totalTables,
  });

  logger.success("\nSchema organized into " + outputDir);

  return index;
}
