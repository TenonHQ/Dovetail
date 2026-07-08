import { Sinc, TSFIXME } from "@tenonhq/dovetail-types";
import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import chalk from "chalk";
import { defaultClient } from "./snClient";
import { logger } from "./Logger";
import { fileLogger } from "./FileLogger";
import { setLogLevel } from "./commands";
import * as ConfigManager from "./config";
import * as FileUtils from "./FileUtils";

interface DeleteRecordArgs {
  table: string;
  name?: string;
  scope?: string;
  sysid?: string;
  ci?: boolean;
  keepLocal?: boolean;
  logLevel: string;
}

/**
 * Resolves the target scope from args, manifest, or user prompt.
 */
async function resolveScope(args: DeleteRecordArgs): Promise<string> {
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
 * Main delete record command handler.
 */
export async function deleteRecordCommand(args: TSFIXME): Promise<void> {
  setLogLevel(args as Sinc.SharedCmdArgs);
  var typedArgs = args as DeleteRecordArgs;

  try {
    var table = typedArgs.table;
    if (!table) {
      logger.error("Table name is required");
      process.exit(1);
    }

    var name = typedArgs.name;
    var sysId = typedArgs.sysid;

    if (!name && !sysId) {
      if (typedArgs.ci) {
        logger.error(
          "Record name or --sysid is required. Use positional name or --sysid flag.",
        );
        process.exit(1);
      }
      var nameAnswer: { name: string } = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "Record name to delete:",
          validate: function (input: string) {
            if (!input || input.trim() === "") {
              return "Record name is required";
            }
            return true;
          },
        },
      ]);
      name = nameAnswer.name;
    }

    fileLogger.debug(
      "Delete record: table=" +
        table +
        " name=" +
        (name || "n/a") +
        " sysId=" +
        (sysId || "from manifest"),
    );

    // 1. Resolve scope
    var scope = await resolveScope(typedArgs);
    logger.info("Scope: " + chalk.cyan(scope));

    // 2. Resolve sys_id from manifest if not provided
    if (!sysId) {
      var scopeManifest = await ConfigManager.loadScopeManifest(scope);
      if (
        !scopeManifest ||
        !scopeManifest.tables ||
        !scopeManifest.tables[table] ||
        !scopeManifest.tables[table].records ||
        !scopeManifest.tables[table].records[name as string]
      ) {
        logger.error(
          "Record not found in manifest: " +
            table +
            "/" +
            name +
            " (scope: " +
            scope +
            ")",
        );
        logger.error("Use --sysid to delete by sys_id directly.");
        process.exit(1);
      }
      sysId = scopeManifest.tables[table].records[name as string].sys_id;
      logger.info("Resolved sys_id: " + chalk.cyan(sysId));
    }

    // 3. Confirmation prompt
    if (!typedArgs.ci) {
      logger.info("");
      logger.info(chalk.bold.red("Delete Record:"));
      logger.info("  Table: " + chalk.cyan(table));
      if (name) {
        logger.info("  Name: " + chalk.cyan(name));
      }
      logger.info("  Scope: " + chalk.cyan(scope));
      logger.info("  Sys ID: " + chalk.cyan(sysId));
      if (typedArgs.keepLocal) {
        logger.info(
          "  Keep Local: " +
            chalk.yellow("yes (local files will be preserved)"),
        );
      }
      logger.info("");

      var confirmAnswer: { confirmed: boolean } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message:
            chalk.red("DELETE") +
            " this record from " +
            (process.env.SN_INSTANCE || "the instance") +
            "?",
          default: false,
        },
      ]);
      if (!confirmAnswer.confirmed) {
        logger.info("Cancelled.");
        return;
      }
    }

    // 4. Call the delete endpoint
    logger.info(
      "Deleting " +
        table +
        "/" +
        (name || sysId) +
        " from " +
        (process.env.SN_INSTANCE || "instance") +
        "...",
    );

    var client = defaultClient();
    var deleteResponse = await client.deleteRecord({
      table: table,
      sys_id: sysId,
      scope: scope,
    });

    var result = deleteResponse.data;
    // Handle wrapped response
    if (result && (result as TSFIXME).result) {
      result = (result as TSFIXME).result;
    }

    var resultData = result as TSFIXME;

    if (resultData.error) {
      logger.error("Failed to delete record: " + resultData.error);
      process.exit(1);
    }

    var recordName = resultData.name || name || sysId;
    logger.success(
      chalk.green("Record deleted: ") +
        chalk.bold(recordName) +
        " (" +
        sysId +
        ")",
    );

    // 5. Local cleanup
    if (!typedArgs.keepLocal) {
      logger.info("Cleaning up local files...");

      try {
        // Remove local record directory
        var sourcePath = ConfigManager.getSourcePath();
        var recordDir = path.join(sourcePath, table, name || recordName);

        if (fs.existsSync(recordDir)) {
          fs.rmSync(recordDir, { recursive: true, force: true });
          logger.success(chalk.green("Removed: ") + recordDir);
        } else {
          fileLogger.debug("Local directory not found: " + recordDir);
        }

        // Update manifest
        var manifest = await ConfigManager.loadScopeManifest(scope);
        if (
          manifest &&
          manifest.tables &&
          manifest.tables[table] &&
          manifest.tables[table].records
        ) {
          var recordKey = name || recordName;
          if (manifest.tables[table].records[recordKey]) {
            delete manifest.tables[table].records[recordKey];

            // Remove table entry if no records remain
            if (Object.keys(manifest.tables[table].records).length === 0) {
              delete manifest.tables[table];
            }

            await FileUtils.writeScopeManifest(scope, manifest);
            logger.success(chalk.green("Manifest updated"));
          }
        }
      } catch (cleanupErr) {
        logger.warn("Record deleted on instance but local cleanup failed.");
        logger.warn("Run 'npx dove refresh' to sync local files.");
        if (cleanupErr instanceof Error) {
          fileLogger.error("Cleanup error:", cleanupErr.message);
        }
      }
    } else {
      logger.info(chalk.yellow("Local files preserved (--keep-local)"));
    }
  } catch (e) {
    logger.error("Failed to delete record");
    if (e instanceof Error) {
      logger.error(e.message);
      if ((e as TSFIXME).response) {
        var respStatus = (e as TSFIXME).response.status;
        var respData = (e as TSFIXME).response.data;
        logger.error("Server responded with status " + respStatus);
        fileLogger.error(
          "Delete failed — status: " +
            respStatus +
            ", response: " +
            JSON.stringify(respData),
        );
      }
    }
    process.exit(1);
  }
}
