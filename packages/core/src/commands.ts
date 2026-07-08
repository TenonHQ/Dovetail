import { Sinc } from "@tenonhq/dovetail-types";
import * as ConfigManager from "./config";
import * as AppUtils from "./appUtils";
import { runInit } from "./initSystem/orchestrator";
import { logger } from "./Logger";
import { fileLogger } from "./FileLogger";
import { logPushResults, logBuildResults } from "./logMessages";
import { defaultClient, unwrapSNResponse } from "./snClient";
import inquirer from "inquirer";
import { gitDiffToEncodedPaths } from "./gitUtils";
import { encodedPathsToFilePaths } from "./FileUtils";
import { getActiveTaskPath, getUpdateSetsConfigPath } from "./projectFiles";
import * as path from "path";
import * as fs from "fs";

export function setLogLevel(args: Sinc.SharedCmdArgs) {
  logger.setLogLevel(args.logLevel);
}

export async function refreshCommand(
  args: Sinc.SharedCmdArgs & {
    force?: boolean;
    scope?: string;
    benchmark?: boolean;
  },
  log: boolean = true,
) {
  setLogLevel(args);
  try {
    if (!log) setLogLevel({ logLevel: "warn" });
    fileLogger.debug(
      "Syncing manifest from instance (force=" +
        !!args.force +
        ", benchmark=" +
        !!args.benchmark +
        ")",
    );
    await AppUtils.syncManifest(args.scope, {
      force: !!args.force,
      benchmark: !!args.benchmark,
    });
    logger.success("Refresh complete!");
    setLogLevel(args);
  } catch (e) {
    throw e;
  }
}

export async function pushCommand(args: Sinc.PushCmdArgs): Promise<void> {
  setLogLevel(args);
  try {
    const { updateSet, ci: skipPrompt, target, diff } = args;
    let encodedPaths;
    if (target !== undefined && target !== "") encodedPaths = target;
    else encodedPaths = await gitDiffToEncodedPaths(diff);

    const fileList = await AppUtils.getAppFileList(encodedPaths);
    const instance = process.env.SN_INSTANCE || "unknown";
    logger.info(fileList.length + " files to push to " + instance);

    if (!skipPrompt) {
      const targetServer = process.env.SN_INSTANCE;
      if (!targetServer) {
        logger.error("No SN_INSTANCE configured. Set it in your .env file.");
        return;
      }
      const answers: { confirmed: boolean } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message:
            "Pushing will overwrite code in your instance. Are you sure?",
          default: false,
        },
      ]);
      if (!answers["confirmed"]) return;
    }

    // Handle --clickup flag: resolve ClickUp task into an update set name
    let resolvedUpdateSet = updateSet;
    if (!resolvedUpdateSet && (args as any).clickup) {
      try {
        const { resolveClickUpForPush } = await import("./clickupPushHelper");
        resolvedUpdateSet = await resolveClickUpForPush((args as any).clickup);
      } catch (cuErr) {
        if (cuErr instanceof Error) logger.error(cuErr.message);
        process.exit(1);
      }
    }

    // Extract scope from file list and auto-swap to it
    var pushScope: string | undefined;
    if (fileList.length > 0) {
      var fieldKeys = Object.keys(fileList[0].fields);
      if (fieldKeys.length > 0) {
        pushScope = fileList[0].fields[fieldKeys[0]].scope;
      }
    }

    if (pushScope) {
      try {
        var client = defaultClient();
        await client.changeScope(pushScope);
        logger.info("Switched to scope: " + pushScope);
      } catch (scopeErr) {
        logger.warn("Could not auto-switch scope: " + scopeErr);
      }
    }

    // Does not create update set if updateSetName is blank
    if (resolvedUpdateSet) {
      if (!skipPrompt) {
        let answers: { confirmed: boolean } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirmed",
            message: `A new Update Set "${resolvedUpdateSet}" will be created for these pushed changes. Do you want to proceed?`,
            default: false,
          },
        ]);
        if (!answers["confirmed"]) {
          process.exit(0);
        }
      }

      const newUpdateSet = await AppUtils.createAndAssignUpdateSet(
        resolvedUpdateSet,
        pushScope,
      );
      logger.debug(
        `New Update Set Created(${newUpdateSet.name}) sys_id:${newUpdateSet.id}`,
      );
    }
    const pushResults = await AppUtils.pushFiles(fileList);
    logPushResults(pushResults);
  } catch (e) {
    logger.getInternalLogger().error(e);
    process.exit(1);
  }
}

export async function downloadCommand(args: Sinc.CmdDownloadArgs) {
  setLogLevel(args);
  try {
    let answers: { confirmed: boolean } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: "Downloading will overwrite manifest and files. Are you sure?",
        default: false,
      },
    ]);
    if (!answers["confirmed"]) {
      return;
    }
    const instance = process.env.SN_INSTANCE || "unknown";
    logger.info(
      "Downloading from " +
        instance +
        " (scope: " +
        (args.scope || "default") +
        ")...",
    );

    const client = defaultClient();
    const config = ConfigManager.getConfig();

    // Resolve config for this scope (strips _ directives for API, provides table whitelist)
    var resolved = ConfigManager.resolveConfigForScope(args.scope);
    var apiConfig = Object.assign({}, config, {
      includes: resolved.apiIncludes,
      excludes: resolved.apiExcludes,
    });

    const man = await unwrapSNResponse(
      client.getManifest(args.scope, apiConfig, true),
    );

    // Client-side table filtering — only keep tables in the _tables whitelist
    if (resolved.tables && resolved.tables.length > 0) {
      var allTableNames = Object.keys(man.tables || {});
      var filtered: any = {};
      for (var i = 0; i < allTableNames.length; i++) {
        if (resolved.tables.indexOf(allTableNames[i]) !== -1) {
          filtered[allTableNames[i]] = man.tables[allTableNames[i]];
        }
      }
      var filteredOut = allTableNames.length - Object.keys(filtered).length;
      if (filteredOut > 0) {
        logger.info(
          "Filtered " + filteredOut + " tables not in _tables whitelist",
        );
      }
      man.tables = filtered;
    }

    const tableCount = Object.keys(man.tables).length;
    var recordCount = 0;
    Object.keys(man.tables).forEach(function (tableName) {
      recordCount += Object.keys(man.tables[tableName].records).length;
    });
    logger.info(
      "Received " + tableCount + " tables, " + recordCount + " records",
    );
    fileLogger.debug(
      "Download manifest: " +
        tableCount +
        " tables, " +
        recordCount +
        " records",
    );

    await AppUtils.processManifest(man, true);
    logger.success("Download complete — " + recordCount + " records written");
  } catch (e) {
    throw e;
  }
}

export async function initCommand(args: Sinc.SharedCmdArgs) {
  setLogLevel(args);
  try {
    await runInit({ logLevel: args.logLevel });
  } catch (e) {
    throw e;
  }
}

export async function buildCommand(args: Sinc.BuildCmdArgs) {
  setLogLevel(args);
  try {
    const encodedPaths = await gitDiffToEncodedPaths(args.diff);
    const fileList = await AppUtils.getAppFileList(encodedPaths);
    logger.info(`${fileList.length} files to build.`);
    const results = await AppUtils.buildFiles(fileList);
    logBuildResults(results);
  } catch (e) {
    process.exit(1);
  }
}

async function getDeployPaths(): Promise<string[]> {
  let changedPaths: string[] = [];
  try {
    changedPaths = ConfigManager.getDiffFile().changed || [];
  } catch (e) {}
  if (changedPaths.length > 0) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message:
          "Would you like to deploy only files changed in your diff file?",
        default: false,
      },
    ]);
    if (confirmed) return changedPaths;
  }
  return encodedPathsToFilePaths(ConfigManager.getBuildPath());
}

export async function deployCommand(args: Sinc.SharedCmdArgs): Promise<void> {
  setLogLevel(args);
  try {
    const targetServer = process.env.SN_INSTANCE || "";
    if (!targetServer) {
      logger.error("No SN_INSTANCE configured. Set it in your .env file.");
      return;
    }
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message:
          "Deploying will overwrite code in your instance. Are you sure?",
        default: false,
      },
    ]);
    if (!confirmed) {
      return;
    }
    const paths = await getDeployPaths();
    logger.silly(`${paths.length} paths found...`);
    logger.silly(JSON.stringify(paths, null, 2));
    const appFileList = await AppUtils.getAppFileList(paths);

    // Auto-swap to scope detected from files
    if (appFileList.length > 0) {
      var fieldKeys = Object.keys(appFileList[0].fields);
      if (fieldKeys.length > 0) {
        var deployScope = appFileList[0].fields[fieldKeys[0]].scope;
        if (deployScope) {
          try {
            var client = defaultClient();
            await client.changeScope(deployScope);
            logger.info("Switched to scope: " + deployScope);
          } catch (scopeErr) {
            logger.warn("Could not auto-switch scope: " + scopeErr);
          }
        }
      }
    }

    const pushResults = await AppUtils.pushFiles(appFileList);
    logPushResults(pushResults);
  } catch (e) {
    throw e;
  }
}

export async function taskClearCommand(args: Sinc.SharedCmdArgs) {
  setLogLevel(args);
  var taskPath = getActiveTaskPath();
  // Always sweep both filenames so a clear leaves no stale state behind.
  var legacyTaskPath = path.resolve(process.cwd(), ".sinc-active-task.json");
  var newTaskPath = path.resolve(process.cwd(), ".dove-active-task.json");
  if (fs.existsSync(taskPath)) {
    try {
      var parsed = JSON.parse(fs.readFileSync(taskPath, "utf8"));
      var taskName = parsed.taskName || parsed.taskId || "unknown";
      [newTaskPath, legacyTaskPath].forEach(function (p) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });
      logger.success("Active task '" + taskName + "' cleared.");
    } catch (e) {
      // File exists but can't be parsed — still remove it
      [newTaskPath, legacyTaskPath].forEach(function (p) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });
      logger.success("Active task file removed.");
    }
  } else {
    logger.info("No active task is currently set.");
  }
}

export async function statusCommand() {
  try {
    const client = defaultClient();
    var config = ConfigManager.getConfig();
    let scopeObj = await unwrapSNResponse(client.getCurrentScope());
    logger.info("Instance:      " + (process.env.SN_INSTANCE || "not set"));
    logger.info("User:          " + (process.env.SN_USER || "not set"));
    logger.info("Active scope:  " + scopeObj.scope);

    // Read update set config
    var updateSetConfig: Record<string, { sys_id: string; name: string }> = {};
    var updateSetConfigPath = getUpdateSetsConfigPath();
    try {
      if (fs.existsSync(updateSetConfigPath)) {
        updateSetConfig = JSON.parse(
          fs.readFileSync(updateSetConfigPath, "utf8"),
        );
      }
    } catch (e) {
      logger.warn(
        "Failed to parse update-sets config at " +
          updateSetConfigPath +
          ": " +
          (e instanceof Error ? e.message : String(e)),
      );
    }

    if (config.scopes) {
      var scopeNames = Object.keys(config.scopes);
      logger.info("\nConfigured scopes (" + scopeNames.length + "):");
      for (var i = 0; i < scopeNames.length; i++) {
        var scopeName = scopeNames[i];
        var scopeConf = config.scopes[scopeName];
        var srcDir =
          typeof scopeConf === "object" && scopeConf.sourceDirectory
            ? scopeConf.sourceDirectory
            : "src/" + scopeName;
        var marker = scopeName === scopeObj.scope ? " (active)" : "";
        var updateSetInfo = updateSetConfig[scopeName]
          ? " [update set: " + updateSetConfig[scopeName].name + "]"
          : " [no update set configured]";
        logger.info("  " + scopeName + marker + " — " + srcDir + updateSetInfo);
      }
    }
  } catch (e) {
    throw e;
  }
}
