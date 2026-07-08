import { Sinc, TSFIXME } from "@tenonhq/dovetail-types";
import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import chalk from "chalk";
import { defaultClient, unwrapSNResponse } from "./snClient";
import { logger } from "./Logger";
import { fileLogger } from "./FileLogger";
import { setLogLevel } from "./commands";
import * as ConfigManager from "./config";
import * as AppUtils from "./appUtils";
import { getUpdateSetsConfigPath } from "./projectFiles";

interface CreateRecordArgs {
  table: string;
  name?: string;
  scope?: string;
  from?: string;
  field?: string[];
  ci?: boolean;
  logLevel: string;
}

interface UpdateSetSelection {
  sys_id: string;
  name: string;
}

type UpdateSetConfig = Record<string, UpdateSetSelection>;

const getUpdateSetConfig = (): UpdateSetConfig => {
  const configPath = getUpdateSetsConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch (e) {
    // Ignore parse errors
  }
  return {};
};

/**
 * Parses --field flag values from "key=value" format into an object.
 */
function parseFieldFlags(fieldArgs: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (var i = 0; i < fieldArgs.length; i++) {
    var arg = fieldArgs[i];
    var eqIndex = arg.indexOf("=");
    if (eqIndex === -1) {
      logger.warn(
        "Skipping invalid --field value (expected key=value): " + arg,
      );
      continue;
    }
    var key = arg.substring(0, eqIndex);
    var value = arg.substring(eqIndex + 1);
    fields[key] = value;
  }
  return fields;
}

/**
 * Loads field values from a JSON file.
 */
function loadFieldsFromFile(filePath: string): Record<string, string> {
  var resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error("File not found: " + resolvedPath);
  }
  var content = fs.readFileSync(resolvedPath, "utf8");
  var parsed = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "JSON file must contain an object with field key-value pairs",
    );
  }
  return parsed;
}

/**
 * Resolves the target scope from args, manifest, or user prompt.
 */
async function resolveScope(args: CreateRecordArgs): Promise<string> {
  if (args.scope) {
    return args.scope;
  }

  // Try to get scope from current manifest
  try {
    var manifest = ConfigManager.getManifest();
    if (
      manifest &&
      !ConfigManager.isMultiScopeManifest(manifest) &&
      manifest.scope
    ) {
      return manifest.scope;
    }
  } catch (e) {
    // No manifest available
  }

  // Try to get scopes from config
  try {
    var config = ConfigManager.getConfig();
    if (config.scopes) {
      var scopeNames = Object.keys(config.scopes);
      if (scopeNames.length === 1) {
        return scopeNames[0];
      }
      if (scopeNames.length > 1 && !args.ci) {
        var choices = scopeNames.map(function (s) {
          return { name: s, value: s };
        });
        var answers: { scope: string } = await inquirer.prompt([
          {
            type: "list",
            name: "scope",
            message: "Select target scope:",
            choices: choices,
          },
        ]);
        return answers.scope;
      }
    }
  } catch (e) {
    // No config available
  }

  if (args.ci) {
    throw new Error("Scope is required in CI mode. Use --scope flag.");
  }

  var scopeAnswer: { scope: string } = await inquirer.prompt([
    {
      type: "input",
      name: "scope",
      message: "Target scope (e.g., x_cadso_core):",
      validate: function (input: string) {
        if (!input || input.trim() === "") {
          return "Scope is required";
        }
        return true;
      },
    },
  ]);
  return scopeAnswer.scope;
}

/**
 * Main create record command handler.
 */
export async function createRecordCommand(args: TSFIXME): Promise<void> {
  setLogLevel(args as Sinc.SharedCmdArgs);
  var typedArgs = args as CreateRecordArgs;

  try {
    var table = typedArgs.table;
    if (!table) {
      logger.error("Table name is required");
      process.exit(1);
    }

    fileLogger.debug("Create record: table=" + table);

    // 1. Build field values from all sources
    var fields: Record<string, string> = {};

    // Load from JSON file if provided
    if (typedArgs.from) {
      logger.info("Loading fields from " + typedArgs.from);
      var fileFields = loadFieldsFromFile(typedArgs.from);
      Object.assign(fields, fileFields);
    }

    // Merge inline --field values (override JSON)
    if (typedArgs.field && typedArgs.field.length > 0) {
      var flagFields = parseFieldFlags(typedArgs.field);
      Object.assign(fields, flagFields);
    }

    // Add --name to fields if provided
    if (typedArgs.name) {
      fields.name = typedArgs.name;
    }

    // 2. Prompt for missing required fields
    if (!fields.name && !typedArgs.ci) {
      var nameAnswer: { name: string } = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "Record name:",
          validate: function (input: string) {
            if (!input || input.trim() === "") {
              return "Record name is required";
            }
            return true;
          },
        },
      ]);
      fields.name = nameAnswer.name;
    }

    if (!fields.name) {
      logger.error(
        "Record name is required. Use --name or --from with a JSON file.",
      );
      process.exit(1);
    }

    // 3. Resolve scope
    var scope = await resolveScope(typedArgs);
    logger.info("Scope: " + chalk.cyan(scope));

    // 4. Check update set configuration
    var updateSetConfig = getUpdateSetConfig();
    var updateSet = updateSetConfig[scope];
    var updateSetSysId: string | undefined;

    if (updateSet) {
      logger.info("Update set: " + chalk.cyan(updateSet.name));
      updateSetSysId = updateSet.sys_id;
    }

    // 5. Confirmation prompt
    if (!typedArgs.ci) {
      logger.info("");
      logger.info(chalk.bold("Create Record Summary:"));
      logger.info("  Table: " + chalk.cyan(table));
      logger.info("  Name: " + chalk.cyan(fields.name));
      logger.info("  Scope: " + chalk.cyan(scope));
      if (updateSet) {
        logger.info("  Update Set: " + chalk.cyan(updateSet.name));
      }

      var fieldNames = Object.keys(fields).filter(function (f) {
        return f !== "name";
      });
      if (fieldNames.length > 0) {
        logger.info("  Fields: " + fieldNames.join(", "));
      }
      logger.info("");

      var confirmAnswer: { confirmed: boolean } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message:
            "Create this record on " +
            (process.env.SN_INSTANCE || "the instance") +
            "?",
          default: true,
        },
      ]);
      if (!confirmAnswer.confirmed) {
        logger.info("Cancelled.");
        return;
      }
    }

    // 6. Call the create endpoint
    logger.info("Creating record...");
    fileLogger.debug(
      "Create request:",
      JSON.stringify({
        table: table,
        fields: fields,
        scope: scope,
        update_set_sys_id: updateSetSysId,
      }),
    );

    var client = defaultClient();
    var createResponse = await client.createRecord({
      table: table,
      fields: fields,
      scope: scope,
      update_set_sys_id: updateSetSysId,
    });

    var result = createResponse.data;
    // Handle wrapped response
    if (result && (result as TSFIXME).result) {
      result = (result as TSFIXME).result;
    }

    var resultData = result as TSFIXME;

    if (resultData.error) {
      logger.error("Failed to create record: " + resultData.error);
      process.exit(1);
    }

    var newSysId = resultData.sys_id;
    var recordName = resultData.name || fields.name;

    logger.success(
      chalk.green("Record created: ") +
        chalk.bold(recordName) +
        " (" +
        newSysId +
        ")",
    );

    // 7. Full round-trip: pull the record back locally
    logger.info("Syncing record to local files...");
    fileLogger.debug("Starting manifest sync for scope:", scope);

    try {
      await AppUtils.syncManifest(scope);
      var sourcePath = ConfigManager.getSourcePath();
      var localPath = path.join(sourcePath, table, recordName);
      logger.success(chalk.green("Local files created at: ") + localPath);
    } catch (syncErr) {
      logger.warn("Record created on instance but local sync failed.");
      logger.warn("Run 'npx dove refresh' to pull the record locally.");
      if (syncErr instanceof Error) {
        fileLogger.error("Sync error:", syncErr.message);
      }
    }
  } catch (e) {
    logger.error("Failed to create record");
    if (e instanceof Error) {
      logger.error(e.message);
      if ((e as TSFIXME).response) {
        var respStatus = (e as TSFIXME).response.status;
        var respData = (e as TSFIXME).response.data;
        logger.error("Server responded with status " + respStatus);
        fileLogger.error(
          "Create failed — status: " +
            respStatus +
            ", response: " +
            JSON.stringify(respData),
        );
      }
    }
    process.exit(1);
  }
}
