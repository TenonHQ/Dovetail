import chokidar from "chokidar";
import { logFilePush } from "./logMessages";
import { debounce } from "lodash";
import {
  getFileContextFromPath,
  getFileContextWithSkipReason,
} from "./FileUtils";
import { Sinc } from "@tenonhq/dovetail-types";
import { groupAppFiles, pushFiles } from "./appUtils";
import { writeRecentEdit } from "./recentEdits";
import { logger } from "./Logger";
import * as path from "path";
import * as fs from "fs";
import * as ConfigManager from "./config";
import { getActiveTaskPath, getUpdateSetsConfigPath } from "./projectFiles";

const DEBOUNCE_MS = 300;

interface ScopeWatcher {
  scope: string;
  watcher: chokidar.FSWatcher;
  pushQueue: string[];
  sourceDirectory: string;
}

interface ActiveTaskFile {
  taskId: string;
  taskName: string;
  taskDescription: string;
  updateSetName: string;
  description: string;
  taskUrl: string;
  scopes: Record<string, { sys_id: string; name: string }>;
}

interface UpdateSetSelection {
  sys_id: string;
  name: string;
}

type UpdateSetConfig = Record<string, UpdateSetSelection>;

interface WatcherOptions {
  monitorIntervalMs: number; // 0 = disabled
}

class MultiScopeWatcherManager {
  private scopeWatchers: Map<string, ScopeWatcher> = new Map();
  private updateSetCheckInterval: NodeJS.Timeout | null = null;
  private scopeLock: Promise<void> = Promise.resolve();
  private cachedScope: string | null = null;
  private pendingScopes: Map<string, number> = new Map(); // scope -> first change timestamp
  private globalProcessQueue: ReturnType<typeof debounce> | null = null;

  async startWatchingAllScopes(options?: WatcherOptions) {
    var opts = options || { monitorIntervalMs: 120000 };
    try {
      // Load configuration
      await ConfigManager.loadConfigs();
      const config = ConfigManager.getConfig();

      if (!config.scopes) {
        logger.error("No scopes defined in dove.config.js");
        throw new Error("No scopes defined in configuration");
      }

      const scopes = Object.keys(config.scopes);
      logger.info(
        `Starting multi-scope watch for ${scopes.length} scopes: ${scopes.join(
          ", ",
        )}`,
      );

      // Start watching each scope
      for (const scopeName of scopes) {
        const scopeConfig = config.scopes[scopeName];
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

        this.startWatchingScope(scopeName, sourceDirectory);
      }

      // Start periodic update set checking (unless disabled)
      if (opts.monitorIntervalMs > 0) {
        this.startUpdateSetMonitoring(opts.monitorIntervalMs);
      } else {
        logger.info("Update set monitoring disabled (--noMonitoring)");
      }

      logger.success("✅ Multi-scope watch started successfully!");
      logger.info("Watching for file changes across all scopes...");
      logger.info("Press Ctrl+C to stop watching\n");
    } catch (error) {
      logger.error("Failed to start multi-scope watch: " + error);
      throw error;
    }
  }

  private startWatchingScope(scopeName: string, sourceDirectory: string) {
    logger.info(
      `Setting up watcher for scope ${scopeName} in ${sourceDirectory}`,
    );

    const watcher = chokidar.watch(sourceDirectory, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    const scopeWatcher: ScopeWatcher = {
      scope: scopeName,
      watcher: watcher,
      pushQueue: [],
      sourceDirectory: sourceDirectory,
    };

    // Initialize global debounce once (shared across all scopes)
    if (!this.globalProcessQueue) {
      this.globalProcessQueue = debounce(async () => {
        await this.processAllPendingScopes();
      }, DEBOUNCE_MS);
    }

    watcher.on("change", (filePath: string) => {
      logger.info(
        `[${scopeName}] File changed: ${path.relative(
          sourceDirectory,
          filePath,
        )}`,
      );
      scopeWatcher.pushQueue.push(filePath);
      if (!this.pendingScopes.has(scopeName)) {
        this.pendingScopes.set(scopeName, Date.now());
      }
      this.globalProcessQueue!();
    });

    watcher.on("add", (filePath: string) => {
      logger.info(
        `[${scopeName}] File added: ${path.relative(
          sourceDirectory,
          filePath,
        )}`,
      );
      scopeWatcher.pushQueue.push(filePath);
      if (!this.pendingScopes.has(scopeName)) {
        this.pendingScopes.set(scopeName, Date.now());
      }
      this.globalProcessQueue!();
    });

    watcher.on("error", (error: Error) => {
      logger.error(`[${scopeName}] Watcher error: ${error.message}`);
    });

    this.scopeWatchers.set(scopeName, scopeWatcher);
  }

  private async withScopeLock<T>(fn: () => Promise<T>): Promise<T> {
    var resolve: () => void;
    var next = new Promise<void>(function (r) {
      resolve = r;
    });
    var prev = this.scopeLock;
    this.scopeLock = next;
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  private getUpdateSetConfig(): UpdateSetConfig {
    var configPath = getUpdateSetsConfigPath();
    try {
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, "utf8"));
      }
    } catch (e) {
      logger.warn(
        `[MultiScope] Failed to parse update set config at ${configPath}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return {};
  }

  private readActiveTask(): ActiveTaskFile | null {
    var taskPath = getActiveTaskPath();
    try {
      if (fs.existsSync(taskPath)) {
        var parsed = JSON.parse(fs.readFileSync(taskPath, "utf8"));
        if (
          !parsed.taskId ||
          typeof parsed.taskId !== "string" ||
          parsed.taskId.trim() === ""
        ) {
          logger.error(
            "Active task file is missing a valid taskId. Ignoring active task.",
          );
          return null;
        }
        if (
          !parsed.updateSetName ||
          typeof parsed.updateSetName !== "string" ||
          parsed.updateSetName.trim() === ""
        ) {
          logger.error(
            "Active task file is missing a valid updateSetName. Ignoring active task.",
          );
          return null;
        }
        var stat = fs.statSync(taskPath);
        var ageMs = Date.now() - stat.mtimeMs;
        var ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        if (ageDays >= 7) {
          var taskName = parsed.taskName || parsed.taskId;
          logger.warn(
            "Active task " +
              taskName +
              " was selected " +
              ageDays +
              " days ago. Run dove task clear if you have moved on.",
          );
        }
        return parsed;
      }
    } catch (e) {
      logger.warn(
        `Failed to parse active task file: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return null;
  }

  private saveUpdateSetConfig(config: UpdateSetConfig): void {
    var configPath = getUpdateSetsConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  private async ensureUpdateSetForScope(scopeName: string): Promise<void> {
    var config = this.getUpdateSetConfig();
    if (config[scopeName]) {
      return; // Already has an update set mapped
    }

    var activeTask = this.readActiveTask();
    if (!activeTask) {
      // No active task — try to resolve the current update set from the ServiceNow
      // session so pushWithUpdateSet can be used instead of the fallback updateRecord.
      try {
        var { defaultClient } = await import("./snClient");
        var sessionClient = defaultClient();

        var curResp = await sessionClient.getCurrentUpdateSet(scopeName);
        var curData = curResp.data;
        if (curData && (curData as any).result) {
          curData = (curData as any).result;
        }
        var curSysId =
          curData && (curData as any).sysId ? (curData as any).sysId : null;
        var curName =
          curData && (curData as any).name ? (curData as any).name : null;

        if (curSysId && curName) {
          var isDefault =
            curName === "Default" ||
            curName.toLowerCase().indexOf("default") !== -1;
          if (isDefault) {
            logger.warn(
              `[${scopeName}] No update set configured for scope ${scopeName}. ` +
                `Changes will go to Default. ` +
                `Use dove createUpdateSet or activate a task in the dashboard.`,
            );
          } else {
            // Use the session's current non-Default update set
            config = this.getUpdateSetConfig();
            config[scopeName] = { sys_id: curSysId, name: curName };
            this.saveUpdateSetConfig(config);
            logger.info(`[${scopeName}] Using session update set: ${curName}`);
          }
        } else {
          logger.warn(
            `[${scopeName}] No update set configured for scope ${scopeName}. ` +
              `Changes will go to Default. ` +
              `Use dove createUpdateSet or activate a task in the dashboard.`,
          );
        }
      } catch (queryErr) {
        logger.warn(
          `[${scopeName}] No update set configured for scope ${scopeName}. ` +
            `Changes will go to Default (could not query current update set). ` +
            `Use dove createUpdateSet or activate a task in the dashboard.`,
        );
      }
      return;
    }

    var taskId = activeTask.taskId;
    var updateSetName = activeTask.updateSetName;
    var description = activeTask.description || "";

    if (!taskId || taskId.trim() === "") {
      logger.error(
        `[${scopeName}] Active task has an empty taskId. Skipping update set lookup.`,
      );
      return;
    }

    logger.info(
      `[${scopeName}] No update set found — auto-creating for task CU-${taskId}...`,
    );

    try {
      var { defaultClient, unwrapSNResponse } = await import("./snClient");
      var client = defaultClient();

      // Switch to the target scope and resolve its sys_id for update set creation
      await client.changeScope(scopeName);
      var scopeIdResult = await unwrapSNResponse(client.getScopeId(scopeName));
      var scopeSysId =
        scopeIdResult && scopeIdResult.length > 0
          ? scopeIdResult[0].sys_id
          : undefined;

      if (!scopeSysId) {
        logger.error(
          `[${scopeName}] Scope "${scopeName}" not found on the instance. Cannot create update set for an invalid scope.`,
        );
        return;
      }

      // Search for an existing update set matching this task in this scope
      var query =
        "application.scope=" +
        scopeName +
        "^nameLIKECU-" +
        taskId +
        "^state=in progress" +
        "^ORDERBYDESCsys_created_on";

      var searchResp = await client.client.get("api/now/table/sys_update_set", {
        params: {
          sysparm_query: query,
          sysparm_fields: "sys_id,name,state,application,sys_created_on",
          sysparm_limit: "10",
        },
      });

      var existing = (searchResp.data && searchResp.data.result) || [];
      var updateSet: { sys_id: string; name: string } | null = null;

      if (existing.length > 0) {
        updateSet = { sys_id: existing[0].sys_id, name: existing[0].name };
        logger.info(
          `[${scopeName}] Found existing update set: ${updateSet.name}`,
        );
      } else {
        // Create a new one with explicit scope sys_id
        var createResp = await unwrapSNResponse(
          client.createUpdateSet(updateSetName, scopeSysId, description),
        );
        updateSet = { sys_id: createResp.sys_id, name: updateSetName };
        logger.info(
          `[${scopeName}] Auto-created update set: ${updateSet.name}`,
        );
      }

      // Switch the active update set on the instance and verify
      try {
        await client.changeUpdateSet({ sysId: updateSet.sys_id });

        // Verify the switch was successful
        var verifyResp = await client.getCurrentUpdateSet(scopeName);
        var verifyResult = verifyResp.data;
        if (verifyResult && (verifyResult as any).result) {
          verifyResult = (verifyResult as any).result;
        }
        var currentSysId =
          verifyResult && (verifyResult as any).sysId
            ? (verifyResult as any).sysId
            : null;
        if (currentSysId !== updateSet.sys_id) {
          // Retry once
          logger.warn(
            `[${scopeName}] Update set verification failed, retrying switch...`,
          );
          await client.changeUpdateSet({ sysId: updateSet.sys_id });
          var retryResp = await client.getCurrentUpdateSet(scopeName);
          var retryResult = retryResp.data;
          if (retryResult && (retryResult as any).result) {
            retryResult = (retryResult as any).result;
          }
          var retrySysId =
            retryResult && (retryResult as any).sysId
              ? (retryResult as any).sysId
              : null;
          if (retrySysId !== updateSet.sys_id) {
            var actualName =
              retryResult && (retryResult as any).name
                ? (retryResult as any).name
                : "unknown";
            logger.error(
              `[${scopeName}] Update set ${updateSet.name} was created but could not be activated. Current update set is ${actualName}.`,
            );
            throw new Error(
              `Update set ${updateSet.name} could not be activated for scope ${scopeName}`,
            );
          }
        }
        logger.debug(
          `[${scopeName}] Update set switch verified: ${updateSet.name}`,
        );
      } catch (changeErr) {
        logger.warn(
          `[${scopeName}] Could not auto-switch update set on instance`,
        );
      }

      // Persist the mapping (serialized under scopeLock — safe from concurrent writes)
      config = this.getUpdateSetConfig(); // Re-read in case another scope wrote
      config[scopeName] = { sys_id: updateSet.sys_id, name: updateSet.name };
      this.saveUpdateSetConfig(config);

      // Verify the write persisted correctly
      var verifiedConfig = this.getUpdateSetConfig();
      if (
        !verifiedConfig[scopeName] ||
        verifiedConfig[scopeName].sys_id !== updateSet.sys_id
      ) {
        logger.error(
          `[${scopeName}] Update set config write verification failed. Expected mapping for ${scopeName} with sys_id ${
            updateSet.sys_id
          } but got: ${JSON.stringify(verifiedConfig[scopeName])}`,
        );
        throw new Error(
          `Update set config write verification failed for scope ${scopeName}`,
        );
      }
      logger.debug(
        `[${scopeName}] Update set config verified: ${updateSet.name} (${updateSet.sys_id})`,
      );

      // Also update the active task file
      if (activeTask) {
        if (!activeTask.scopes) {
          activeTask.scopes = {};
        }
        activeTask.scopes[scopeName] = {
          sys_id: updateSet.sys_id,
          name: updateSet.name,
        };
        fs.writeFileSync(
          getActiveTaskPath(),
          JSON.stringify(activeTask, null, 2),
        );
      }
    } catch (error) {
      logger.error(`[${scopeName}] Failed to auto-create update set: ${error}`);
      logger.warn(`[${scopeName}] Pushing without update set routing.`);
    }
  }

  private async processAllPendingScopes() {
    // Sort scopes by first file change timestamp (FIFO)
    var sorted = Array.from(this.pendingScopes.entries()).sort(function (a, b) {
      return a[1] - b[1];
    });
    this.pendingScopes.clear();

    for (var i = 0; i < sorted.length; i++) {
      var scopeName = sorted[i][0];
      var scopeWatcher = this.scopeWatchers.get(scopeName);
      if (scopeWatcher && scopeWatcher.pushQueue.length > 0) {
        await this.processScopeQueue(scopeWatcher);
      }
    }
  }

  private async processScopeQueue(scopeWatcher: ScopeWatcher) {
    if (scopeWatcher.pushQueue.length === 0) return;

    const toProcess = Array.from(new Set([...scopeWatcher.pushQueue]));
    scopeWatcher.pushQueue = [];

    logger.info(
      `[${scopeWatcher.scope}] Processing ${toProcess.length} file(s)...`,
    );

    try {
      await this.withScopeLock(async () => {
        // First, switch to the correct scope
        await this.switchToScope(scopeWatcher.scope);

        // Ensure an update set exists for this scope
        await this.ensureUpdateSetForScope(scopeWatcher.scope);

        // Load the manifest for this specific scope
        await this.loadScopeManifest(
          scopeWatcher.scope,
          scopeWatcher.sourceDirectory,
        );

        // Process the files — track skip reasons for summary
        const fileContexts: Sinc.FileContext[] = [];
        const skippedFiles: Array<{ filePath: string; reason: string }> = [];

        toProcess.forEach(function (filePath) {
          var result = getFileContextWithSkipReason(filePath);
          if (result.context) {
            // Scope validation: ensure the record's scope matches the watcher's scope
            if (
              result.context.scope &&
              result.context.scope !== scopeWatcher.scope
            ) {
              logger.error(
                `[${scopeWatcher.scope}] Scope mismatch: ${filePath} belongs to scope "${result.context.scope}" but was queued by watcher for "${scopeWatcher.scope}". Skipping to prevent cross-scope contamination.`,
              );
              skippedFiles.push({
                filePath: filePath,
                reason: `scope mismatch (record: ${result.context.scope}, watcher: ${scopeWatcher.scope})`,
              });
            } else {
              fileContexts.push(result.context);
            }
          } else {
            var reason = result.skipReason || "unknown";
            logger.warn(
              `[${scopeWatcher.scope}] Skipped: ${filePath} (${reason})`,
            );
            skippedFiles.push({ filePath: filePath, reason: reason });
          }
        });

        if (fileContexts.length === 0) {
          logger.warn(
            `[${scopeWatcher.scope}] No valid file contexts found. ${skippedFiles.length} file(s) skipped.`,
          );
          return;
        }

        const buildables = groupAppFiles(fileContexts);
        const updateResults = await pushFiles(buildables);

        updateResults.forEach((res, index) => {
          if (index < fileContexts.length) {
            logFilePush(fileContexts[index], res);
            if (res.success) {
              writeRecentEdit(fileContexts[index]);
            }
          }
        });

        // Push summary
        var pushedCount = updateResults.filter(function (r) {
          return r.success;
        }).length;
        var totalCount = toProcess.length;
        var summaryParts = [
          `Pushed ${pushedCount}/${totalCount} files to ${scopeWatcher.scope}.`,
        ];
        if (skippedFiles.length > 0) {
          var skippedList = skippedFiles
            .map(function (s) {
              return `${s.filePath} (${s.reason})`;
            })
            .join(", ");
          summaryParts.push(
            `${skippedFiles.length} files skipped: [${skippedList}]`,
          );
        }
        logger.info(`[${scopeWatcher.scope}] ${summaryParts.join(" ")}`);
      });
    } catch (error) {
      logger.error(`[${scopeWatcher.scope}] Error processing queue: ${error}`);
    }
  }

  private async loadScopeManifest(scopeName: string, sourceDirectory: string) {
    try {
      // The sourceDirectory is like /path/to/ServiceNow/src/x_cadso_core
      // We need to go up two levels to get to the ServiceNow directory where manifests are stored
      const projectRoot = path.dirname(path.dirname(sourceDirectory)); // Go up from src/scope to project root

      const fs = await import("fs");

      // First try to load scope-specific manifest file (prefer dove.*, fall back to sinc.*).
      const doveScopeManifestPath = path.join(
        projectRoot,
        `dove.manifest.${scopeName}.json`,
      );
      const sincScopeManifestPath = path.join(
        projectRoot,
        `sinc.manifest.${scopeName}.json`,
      );
      const scopeManifestPath = fs.existsSync(doveScopeManifestPath)
        ? doveScopeManifestPath
        : sincScopeManifestPath;
      if (fs.existsSync(scopeManifestPath)) {
        const manifestContent = await fs.promises.readFile(
          scopeManifestPath,
          "utf-8",
        );
        const scopeManifest = JSON.parse(manifestContent);
        // Ensure scope field is set
        if (!scopeManifest.scope) {
          scopeManifest.scope = scopeName;
        }
        ConfigManager.updateManifest(scopeManifest);
        logger.debug(`Loaded scope-specific manifest for: ${scopeName}`);
        return;
      }

      // Fall back to checking single manifest file (prefer dove.manifest.json, then legacy sinc.manifest.json)
      const doveManifestPath = path.join(projectRoot, "dove.manifest.json");
      const sincManifestPath = path.join(projectRoot, "sinc.manifest.json");
      const manifestPath = fs.existsSync(doveManifestPath)
        ? doveManifestPath
        : sincManifestPath;
      if (fs.existsSync(manifestPath)) {
        const manifestContent = await fs.promises.readFile(
          manifestPath,
          "utf-8",
        );
        const fullManifest = JSON.parse(manifestContent);

        // Check if this is a multi-scope manifest (has scopes as top-level keys)
        if (fullManifest[scopeName]) {
          // Multi-scope manifest - extract the specific scope's data
          const scopeManifest = fullManifest[scopeName];
          // Add the scope field for compatibility
          scopeManifest.scope = scopeName;
          ConfigManager.updateManifest(scopeManifest);
          logger.debug(
            `Loaded manifest for scope: ${scopeName} from legacy multi-scope manifest`,
          );
        } else if (fullManifest.scope === scopeName) {
          // Single-scope manifest for the correct scope
          ConfigManager.updateManifest(fullManifest);
          logger.debug(`Loaded single-scope manifest for scope: ${scopeName}`);
        } else if (fullManifest.tables) {
          // Old-style single-scope manifest without scope field - assume it's for this scope
          fullManifest.scope = scopeName;
          ConfigManager.updateManifest(fullManifest);
          logger.debug(
            `Loaded manifest for scope: ${scopeName} (legacy format)`,
          );
        } else {
          logger.warn(`[${scopeName}] Scope not found in manifest`);
        }
      } else {
        logger.warn(
          `[${scopeName}] No manifest found at ${scopeManifestPath} or ${manifestPath}`,
        );
      }
    } catch (error) {
      logger.error(`Failed to load manifest for scope ${scopeName}: ${error}`);
    }
  }

  private async switchToScope(scopeName: string) {
    // Skip if already on the correct scope
    if (this.cachedScope === scopeName) {
      logger.debug(`Already on scope ${scopeName}, skipping switch`);
      return;
    }

    try {
      var { defaultClient } = await import("./snClient");
      var client = defaultClient();

      // Use the Claude REST API changeScope endpoint to switch the session scope.
      // This uses gs.setCurrentApplicationId() server-side, which correctly changes
      // the REST API session scope. The previous approach used user preference updates
      // (apps.current_app) which only writes a DB record and does NOT affect the
      // active REST session — causing updateRecord() to operate in the wrong scope.
      await client.changeScope(scopeName);

      this.cachedScope = scopeName;
      logger.debug(`Switched to scope: ${scopeName}`);
    } catch (error) {
      // Invalidate cache on failure
      this.cachedScope = null;
      logger.error(`Failed to switch to scope ${scopeName}: ${error}`);
      throw error;
    }
  }

  private async startUpdateSetMonitoring(intervalMs: number) {
    // Check update sets immediately on start
    await this.checkAllUpdateSets();

    logger.info(
      "Update set monitoring interval: " + Math.round(intervalMs / 1000) + "s",
    );
    this.updateSetCheckInterval = setInterval(async () => {
      await this.checkAllUpdateSets();
    }, intervalMs);
  }

  private async checkAllUpdateSets() {
    // Budget: monitoring should not consume more than 5% of the 20 RPS rate limit
    // per cycle. That gives us ~1 request/second budget. Each scope check uses
    // ~6 API calls (switchToScope ~3, getUserSysId ~1, pref ~1, details ~1).
    // To stay within budget we use the local update set config file instead of
    // querying ServiceNow for each scope — 0 API calls when config is present.
    try {
      const config = ConfigManager.getConfig();
      if (!config.scopes) return;

      const scopes = Object.keys(config.scopes);
      var updateSetConfig = this.getUpdateSetConfig();

      logger.info("\n" + "=".repeat(60));
      logger.info("Update Set Status Check");
      logger.info("=".repeat(60));

      for (var i = 0; i < scopes.length; i++) {
        var scopeName = scopes[i];
        var mapping = updateSetConfig[scopeName];
        if (mapping && mapping.name) {
          var isDefault =
            mapping.name === "Default" ||
            mapping.name.toLowerCase().indexOf("default") !== -1;
          if (isDefault) {
            logger.warn(`⚠️  [${scopeName}] Currently in DEFAULT update set!`);
          } else {
            logger.info(`✅ [${scopeName}] Update Set: ${mapping.name}`);
          }
        } else {
          logger.warn(`⚠️  [${scopeName}] No update set configured`);
        }
      }

      logger.info("=".repeat(60) + "\n");
    } catch (error) {
      logger.error(`Error during update set monitoring: ${error}`);
    }
  }

  private async getUpdateSetDetails(updateSetId: string) {
    try {
      const { defaultClient } = await import("./snClient");
      const client = defaultClient();

      // Create axios client directly to get update set details
      const axios = (await import("axios")).default;
      const { SN_USER = "", SN_PASSWORD = "", SN_INSTANCE = "" } = process.env;

      const axiosClient = axios.create({
        auth: {
          username: SN_USER,
          password: SN_PASSWORD,
        },
        baseURL: SN_INSTANCE,
      });

      const response = await axiosClient.get(
        `/api/now/table/sys_update_set/${updateSetId}`,
        {
          params: {
            sysparm_fields: "name,state,sys_id",
          },
        },
      );

      if (response.data && response.data.result) {
        return response.data.result;
      }
      return null;
    } catch (error) {
      logger.warn(`Could not get update set details: ${error}`);
      return null;
    }
  }

  stopWatching() {
    // Stop all scope watchers
    for (const [scopeName, scopeWatcher] of this.scopeWatchers) {
      logger.info(`Stopping watcher for scope: ${scopeName}`);
      scopeWatcher.watcher.close();
    }
    this.scopeWatchers.clear();

    // Cancel global debounce
    if (this.globalProcessQueue) {
      this.globalProcessQueue.cancel();
      this.globalProcessQueue = null;
    }
    this.pendingScopes.clear();

    // Stop update set monitoring
    if (this.updateSetCheckInterval) {
      clearInterval(this.updateSetCheckInterval);
      this.updateSetCheckInterval = null;
    }

    logger.info("All watchers stopped");
  }
}

export const multiScopeWatcher = new MultiScopeWatcherManager();

export function startMultiScopeWatching(options?: WatcherOptions) {
  return multiScopeWatcher.startWatchingAllScopes(options);
}

export function stopMultiScopeWatching() {
  multiScopeWatcher.stopWatching();
}
