import { Sinc, SN } from "@tenonhq/dovetail-types";
import { logger } from "./Logger";
import { fileLogger } from "./FileLogger";
import * as ConfigManager from "./config";
import * as AppUtils from "./appUtils";
import * as fUtils from "./FileUtils";
import { setupDotEnv, getLoginInfo } from "./wizard";
import { defaultClient, unwrapSNResponse } from "./snClient";
import { setLogLevel } from "./commands";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import ProgressBar from "progress";

const fsp = fs.promises;

export interface ScopeConfig {
  sourceDirectory?: string;
  buildDirectory?: string;
  refreshInterval?: number;
  tableOptions?: any;
}

export interface ScopeResult {
  scope: string;
  success: boolean;
  manifest?: any;
  error?: Error;
}

// Custom function to process manifest with specific source directory.
// Exported for regression testing of filesystem-safe folder writing.
export async function processManifestForScope(
  manifest: SN.AppManifest,
  sourceDirectory: string,
  forceWrite = false,
): Promise<void> {
  try {
    // Ensure the source directory exists
    try {
      await fsp.mkdir(sourceDirectory, { recursive: true });
    } catch (dirError) {
      logger.error("Failed to create directory: " + sourceDirectory);
      throw dirError;
    }

    // Re-key the manifest to filesystem-safe folder names before writing.
    // Idempotent, so it is safe even when the caller already normalized.
    // Without this, a Windows-illegal display name (trailing dot/space, or
    // any of <>:"|?*) would be written as a raw folder and abort `git clone`
    // on Windows. Keeps the folder ≡ manifest-key invariant `dove push` relies
    // on. See toSafeFolderName / normalizeManifestKeys (PR #117, #133).
    AppUtils.normalizeManifestKeys(manifest);

    const tables = manifest.tables || {};
    const tableNames = Object.keys(tables);

    var totalRecords = 0;
    for (var tn = 0; tn < tableNames.length; tn++) {
      totalRecords += Object.keys(tables[tableNames[tn]].records || {}).length;
    }

    var scopeLabel = sourceDirectory.split(path.sep).pop() || "scope";
    var progBar: ProgressBar | null = null;
    if (logger.getLogLevel() === "info" && totalRecords > 0) {
      progBar = new ProgressBar(":scope :bar :current/:total (:percent)", {
        total: totalRecords,
        width: 40,
        complete: "=",
        incomplete: "-",
      });
    }

    for (const tableName of tableNames) {
      const tableRecords = tables[tableName];
      const tablePath = path.join(sourceDirectory, tableName);

      // Process each record in the table
      const recordNames = Object.keys(tableRecords.records || {});

      fileLogger.debug("Table " + tableName + ": " + recordNames.length + " records");

      for (const recordName of recordNames) {
        const record = tableRecords.records[recordName];
        // Derive the folder via toSafeFolderName (never the raw record.name):
        // normalizeManifestKeys above already re-keyed unsafe names to sys_id,
        // and this keeps the writer defensive if that ever changes.
        const recordDirName = AppUtils.toSafeFolderName(record);
        const recordPath = path.join(tablePath, recordDirName);

        // Check if metadata file exists in the files from server
        const hasMetadataFromServer = record.files && record.files.some(
          (f: any) => f.name === 'metaData' && f.type === 'json'
        );

        // Ensure the record directory exists
        await fsp.mkdir(recordPath, { recursive: true });

        // Process each file in the record
        for (const file of record.files || []) {
          // Normalize metaData.json through the shared stamper before it hits
          // disk. Without this the all-scopes path persisted the server's raw
          // metadata — an absolute https://<instance>.service-now.com
          // _record_link plus every field's live display_value — so a record
          // written here churned against the same record written by `refresh`,
          // and re-pulling from a different instance rewrote every file.
          // stampMetadataContent is a no-op on non-metaData files and idempotent
          // on already-normalized content.
          const stamped = AppUtils.stampMetadataContent(file);
          const filePath = path.join(recordPath, `${stamped.name}.${stamped.type}`);
          const fileContent = stamped.content || "";

          const fileDir = path.dirname(filePath);
          await fsp.mkdir(fileDir, { recursive: true });

          try {
            await fsp.writeFile(filePath, fileContent, "utf8");
          } catch (writeError) {
            logger.error("Failed to write: " + filePath);
            throw writeError;
          }
        }

        // If no metadata from server, write the deterministic placeholder. The
        // previous stub stamped `_generatedAt: new Date().toISOString()`, which
        // rewrote the file on every single run and read as a change downstream.
        if (!hasMetadataFromServer) {
          const metadataFilePath = path.join(recordPath, "metaData.json");

          try {
            await fsp.writeFile(metadataFilePath, AppUtils.EMPTY_METADATA_CONTENT, "utf8");
          } catch (metaError) {
            logger.error("Failed to write metadata: " + metadataFilePath);
          }
        }

        if (progBar) progBar.tick({ scope: scopeLabel });
      }
    }
  } catch (error) {
    logger.error("Error processing files for " + sourceDirectory + ": " + error);
    throw error;
  }
}

export async function processScope(
  scopeName: string,
  scopeConfig: ScopeConfig | boolean,
  apiDelay: number = 0,
): Promise<ScopeResult> {
  try {
    const instance = process.env.SN_INSTANCE || "unknown";
    logger.info("Processing scope: " + scopeName + " (" + instance + ")");

    // Get the client
    const client = defaultClient();

    // Get the config
    const config = ConfigManager.getConfig();

    // Determine the source directory for this scope
    let sourceDirectory: string;
    if (typeof scopeConfig === "object" && scopeConfig.sourceDirectory) {
      sourceDirectory = path.resolve(
        ConfigManager.getRootDir(),
        scopeConfig.sourceDirectory,
      );
    } else {
      // Default to src/{scope} if no sourceDirectory specified
      sourceDirectory = path.resolve(
        ConfigManager.getRootDir(),
        "src",
        scopeName,
      );
    }

    fileLogger.debug("Source directory for " + scopeName + ": " + sourceDirectory);

    const apps = await unwrapSNResponse(client.getAppList());

    const scopeApp = apps.find((app: any) => app.scope === scopeName);
    if (!scopeApp) {
      logger.warn("Scope " + scopeName + " not found in ServiceNow apps list");
    } else {
      logger.info("Found app: " + scopeApp.displayName);
    }

    // Resolve the table whitelist and field overrides for this scope
    var resolvedConfig = ConfigManager.resolveConfigForScope(scopeName);
    var allowedTables = resolvedConfig.tables;

    // Build a config safe for the ServiceNow API (no _ directive keys)
    var apiConfig = Object.assign({}, config, {
      includes: resolvedConfig.apiIncludes,
      excludes: resolvedConfig.apiExcludes,
    });

    logger.info("Downloading manifest for " + scopeName + "...");
    if (apiDelay > 0) {
      await delay(apiDelay);
    }
    const manifest = await unwrapSNResponse(
      client.getManifest(scopeName, apiConfig, false), // Get structure first
    );

    // Client-side table filtering — only keep tables in the _tables whitelist
    if (allowedTables && allowedTables.length > 0) {
      var manifestTableNames = Object.keys(manifest.tables || {});
      var filteredTables: any = {};
      var skippedCount = 0;

      for (var t = 0; t < manifestTableNames.length; t++) {
        var tName = manifestTableNames[t];
        if (allowedTables.indexOf(tName) !== -1) {
          filteredTables[tName] = manifest.tables[tName];
        } else {
          skippedCount++;
        }
      }

      var keptCount = Object.keys(filteredTables).length;
      if (skippedCount > 0) {
        fileLogger.debug(
          "Filtered " + skippedCount + " tables not in _tables whitelist for " + scopeName +
          ". Keeping " + keptCount + " of " + manifestTableNames.length
        );
      }
      logger.info(scopeName + ": " + keptCount + " tables match config (" + skippedCount + " filtered out)");
      manifest.tables = filteredTables;
    } else {
      logger.warn("No _tables whitelist defined — writing ALL tables for " + scopeName);
    }

    // Record-key normalization now happens inside processManifestForScope (the
    // writer owns the folder ≡ key invariant). The missing-files structure
    // below keys by record.sys_id, so it does not depend on normalized names.

    // Build the missing files structure from the filtered manifest
    var manifestTables = manifest.tables || {};
    var allMissingFiles: any = {};
    for (var tableName in manifestTables) {
      var table = manifestTables[tableName];
      allMissingFiles[tableName] = {};

      for (var recordName in table.records || {}) {
        var record = table.records[recordName];
        allMissingFiles[tableName][record.sys_id] = record.files.map(function(f: any) {
          return { name: f.name, type: f.type };
        });
      }
    }

    // Download file contents in chunks to avoid ServiceNow 500 errors on large payloads
    var CHUNK_SIZE = 5;
    var tableNames = Object.keys(allMissingFiles);
    var totalChunks = Math.ceil(tableNames.length / CHUNK_SIZE);
    logger.info("Downloading file contents for " + scopeName + " (" + tableNames.length + " tables in " + totalChunks + " batch" + (totalChunks !== 1 ? "es" : "") + ")...");

    for (var chunkIdx = 0; chunkIdx < tableNames.length; chunkIdx += CHUNK_SIZE) {
      var chunkTableNames = tableNames.slice(chunkIdx, chunkIdx + CHUNK_SIZE);
      var chunkMissing: any = {};
      for (var ci = 0; ci < chunkTableNames.length; ci++) {
        chunkMissing[chunkTableNames[ci]] = allMissingFiles[chunkTableNames[ci]];
      }

      if (apiDelay > 0) {
        await delay(apiDelay);
      }

      var batchNum = Math.floor(chunkIdx / CHUNK_SIZE) + 1;
      fileLogger.debug("Downloading batch " + batchNum + "/" + totalChunks + " for " + scopeName + ": " + chunkTableNames.join(", "));

      var chunkContent = await unwrapSNResponse(
        client.getMissingFiles(chunkMissing, config.tableOptions || {}),
      );

      // Merge chunk content back into the manifest
      for (var chunkTable in chunkContent || {}) {
        if (manifest.tables[chunkTable]) {
          for (var chunkRecName in chunkContent[chunkTable].records || {}) {
            var recordWithContent = chunkContent[chunkTable].records[chunkRecName];
            var manifestRecords = manifest.tables[chunkTable].records;
            var matchingRecord = Object.values(manifestRecords).find(function(r: any) {
              return r.sys_id === recordWithContent.sys_id;
            });
            if (matchingRecord) {
              matchingRecord.files = recordWithContent.files;
            }
          }
        }
      }
    }

    const tableCount = Object.keys((manifest && manifest.tables) || {}).length;
    logger.info("Writing " + tableCount + " tables for " + scopeName + "...");
    await processManifestForScope(manifest, sourceDirectory, true);

    // Create the scope-specific manifest structure
    const scopeManifest = {
      tables: (manifest && manifest.tables) || {},
      scope: scopeName,
    };

    logger.success("Scope " + scopeName + " complete — files saved to " + sourceDirectory);

    return {
      scope: scopeName,
      success: true,
      manifest: scopeManifest,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to process scope " + scopeName + ": " + errorMessage);
    return {
      scope: scopeName,
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

// Helper function to add delay between API calls
async function delay(ms: number): Promise<void> {
  if (ms > 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export async function initScopesCommand(args: Sinc.SharedCmdArgs & { delay?: number }) {
  setLogLevel(args);
  
  // Get API delay from args, default to 0ms (no delay)
  const apiDelay = args.delay || 0;
  if (apiDelay > 0) {
    logger.info(`Using ${apiDelay}ms delay between API calls to prevent server overload`);
  }

  try {
    // First check if we have environment variables set
    if (
      !process.env.SN_USER ||
      !process.env.SN_PASSWORD ||
      !process.env.SN_INSTANCE
    ) {
      try {
        let loginAnswers = await getLoginInfo();
        await setupDotEnv(loginAnswers);
      } catch (error) {
        logger.error("Error getting ServiceNow credentials: " + error);
        throw error;
      }
      if (
        !process.env.SN_USER ||
        !process.env.SN_PASSWORD ||
        !process.env.SN_INSTANCE
      ) {
        logger.error(
          "Missing ServiceNow credentials. Please ensure SN_USER, SN_PASSWORD, and SN_INSTANCE are set in your .env file",
        );
        throw new Error("ServiceNow credentials not configured");
      }
    }

    // Load config
    await ConfigManager.loadConfigs();
    const config = ConfigManager.getConfig();

    if (!config.scopes) {
      logger.error("No scopes defined in dove.config.js");
      throw new Error("No scopes defined in configuration");
    }

    const scopes = Object.keys(config.scopes);
    const instance = process.env.SN_INSTANCE || "unknown";
    logger.info("Initializing " + scopes.length + " scopes from " + instance + ": " + scopes.join(", "));

    const scopePromises = scopes.map((scopeName) =>
      processScope(scopeName, config.scopes![scopeName], apiDelay),
    );

    const results = await Promise.allSettled(scopePromises);

    // Collect successful manifests
    const manifests: { [key: string]: any } = {};
    let successCount = 0;
    let failCount = 0;

    results.forEach((result, index) => {
      const scopeName = scopes[index];
      if (result.status === "fulfilled" && result.value.success) {
        manifests[scopeName] = result.value.manifest;
        successCount++;
      } else {
        failCount++;
        const error =
          result.status === "rejected" ? result.reason : (result.value && result.value.error);
        logger.error(
          `Failed to process ${scopeName}: ${
            (error && error.message) || "Unknown error"
          }`,
        );
      }
    });

    // Write per-scope manifest files instead of a single combined one
    for (const [scopeName, scopeData] of Object.entries(manifests)) {
      const scopeManifestPath = ConfigManager.getScopeManifestPath(scopeName);
      await fsp.writeFile(
        scopeManifestPath,
        JSON.stringify(scopeData, null, 2),
      );
      logger.info(`Wrote manifest for ${scopeName} to: ${scopeManifestPath}`);
    }

    logger.info("─".repeat(50));
    logger.success("Scope initialization complete — " + successCount + "/" + scopes.length + " scopes processed");
    if (failCount > 0) {
      logger.warn(failCount + " scope(s) failed — check errors above");
    }
    logger.info("Manifests: dove.manifest.<scope>.json");
    logger.success("Run 'npx dove watch' to start development");
  } catch (e) {
    logger.error("Error initializing scopes: " + e);
    throw e;
  }
}

export async function watchAllScopesCommand(args: Sinc.WatchCmdArgs) {
  setLogLevel(args);

  var dashboardProcess: ChildProcess | null = null;

  try {
    // First check if we have environment variables set
    if (
      !process.env.SN_USER ||
      !process.env.SN_PASSWORD ||
      !process.env.SN_INSTANCE
    ) {
      let loginAnswers = await getLoginInfo();
      logger.error(
        "Missing ServiceNow credentials. Please ensure SN_USER, SN_PASSWORD, and SN_INSTANCE are set in your .env file",
      );
      throw new Error("ServiceNow credentials not configured");
    }

    // Start dashboard unless --no-dashboard flag is set
    if (!args.noDashboard) {
      dashboardProcess = startDashboardProcess(args.port);
    }

    // Import and start the multi-scope watcher
    const { startMultiScopeWatching } = await import("./MultiScopeWatcher");

    // Start watching all scopes with monitoring options
    await startMultiScopeWatching({
      monitorIntervalMs: args.noMonitoring ? 0 : (args.monitorInterval || 120) * 1000,
    });

    // Keep the process running
    process.on("SIGINT", async () => {
      logger.info("\nStopping multi-scope watch...");
      if (dashboardProcess) {
        dashboardProcess.kill("SIGINT");
      }
      const { stopMultiScopeWatching } = await import("./MultiScopeWatcher");
      stopMultiScopeWatching();
      process.exit(0);
    });
  } catch (error) {
    if (dashboardProcess) {
      dashboardProcess.kill("SIGINT");
    }
    logger.error("Failed to start multi-scope watch: " + error);
    throw error;
  }
}

function startDashboardProcess(portOverride?: number): ChildProcess | null {
  var serverPath: string;
  try {
    serverPath = require.resolve("@tenonhq/dovetail-dashboard/server.js");
  } catch (e) {
    logger.warn(
      "Dashboard package not installed. Run: npm install @tenonhq/dovetail-dashboard",
    );
    return null;
  }

  var port = portOverride ? String(portOverride) : (process.env.DASHBOARD_PORT || "3456");

  var server = spawn("node", [serverPath], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: { ...process.env, DASHBOARD_PORT: port },
    detached: false,
  });

  server.on("error", function (err) {
    logger.warn("Failed to start dashboard: " + err.message);
  });

  logger.info("Dashboard started at http://localhost:" + port);

  // Open browser after a short delay
  setTimeout(function () {
    var url = "http://localhost:" + port;
    spawn("open", [url], { stdio: "ignore" });
  }, 1000);

  return server;
}
