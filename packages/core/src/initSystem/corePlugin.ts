import { Sinc, SN } from "@tenonhq/dovetail-types";
import { snClient, unwrapSNResponse } from "../snClient";
import { logger } from "../Logger";
import * as ConfigManager from "../config";
import { processScope } from "../allScopesCommands";
import inquirer from "inquirer";
import chalk from "chalk";
import fs from "fs";
import path from "path";

// Read whichever project config exists (dove.config.js preferred, sinc.config.js as legacy fallback).
// Returns the parsed module or null if neither exists / cannot be required.
function readExistingProjectConfig(rootDir: string): any | null {
  var names = ["dove.config.js", "sinc.config.js"];
  for (var i = 0; i < names.length; i++) {
    var p = path.join(rootDir, names[i]);
    if (fs.existsSync(p)) {
      try { return require(p); } catch (e) { return null; }
    }
  }
  return null;
}

/**
 * @description Core init plugin — handles ServiceNow authentication, app selection, and file download.
 * This plugin is always included in `dove init` and `dove login`.
 */
export const corePlugin: Sinc.InitPlugin = {
  name: "core",
  displayName: "ServiceNow",
  description: "Connect to a ServiceNow instance and sync application files",

  login: [
    {
      envKey: "SN_INSTANCE",
      prompt: {
        type: "input",
        message: "ServiceNow instance (e.g. mycompany.service-now.com):",
      },
      required: true,
    },
    {
      envKey: "SN_USER",
      prompt: {
        type: "input",
        message: "Username:",
      },
      required: true,
    },
    {
      envKey: "SN_PASSWORD",
      prompt: {
        type: "password",
        message: "Password:",
        mask: "*",
      },
      required: true,
    },
    {
      envKey: "SN_API_KEY",
      prompt: {
        type: "password",
        message: "Inbound API key (optional, Enter to skip — becomes the default auth when set):",
        mask: "*",
      },
      required: false,
    },
  ],

  configure: [
    {
      key: "apps",
      label: "Selecting ServiceNow applications",
      run: async (context: Sinc.InitContext): Promise<string[] | null> => {
        var baseUrl = instanceBaseUrl(context.env.SN_INSTANCE);
        var client = snClient(
          baseUrl,
          context.env.SN_USER,
          context.env.SN_PASSWORD,
          context.env.SN_API_KEY,
        );

        logger.info("Fetching application list...");
        var apps: SN.App[] = await unwrapSNResponse(client.getAppList());

        if (apps.length === 0) {
          logger.warn("No applications found on this instance.");
          return null;
        }

        // Pre-check scopes that exist in the current config
        var existingScopes = new Set<string>();
        if (context.hasConfig) {
          var existingConfig = readExistingProjectConfig(context.rootDir);
          if (existingConfig && existingConfig.scopes) {
            Object.keys(existingConfig.scopes).forEach(function(s) {
              existingScopes.add(s);
            });
          }
        }

        var choices = apps.map(function(app: SN.App) {
          return {
            name: app.displayName + " (" + app.scope + ")",
            value: app.scope,
            short: app.displayName,
            checked: existingScopes.has(app.scope),
          };
        });

        var answer = await inquirer.prompt([{
          type: "checkbox",
          name: "apps",
          message: "Which apps would you like to work with? (space to select, enter to confirm)",
          choices: choices,
          validate: function(input: string[]) {
            if (input.length === 0) return "Select at least one application.";
            return true;
          },
        }]);

        var selectedScopes: string[] = answer.apps;
        context.answers.selectedScopes = selectedScopes;
        context.answers.selectedScope = selectedScopes[0]; // backward compat
        context.answers.apps = apps;

        // Prompt for source directory per selected scope
        var scopeDirectories: Record<string, string> = {};
        logger.info("");
        logger.info(chalk.bold("  Source directories:"));

        for (var i = 0; i < selectedScopes.length; i++) {
          var scope = selectedScopes[i];
          var app = apps.find(function(a: SN.App) { return a.scope === scope; });
          var displayName = app ? app.displayName : scope;

          // Check if existing config already has a sourceDirectory for this scope
          var existingDir = "";
          if (existingScopes.has(scope)) {
            var existingCfg = readExistingProjectConfig(context.rootDir);
            var cfgScopes = existingCfg && existingCfg.scopes;
            if (cfgScopes && cfgScopes[scope] && cfgScopes[scope].sourceDirectory) {
              existingDir = cfgScopes[scope].sourceDirectory;
            }
          }

          // Suggest a friendly name from displayName, or use existing
          var suggestedDir = existingDir || ("src/" + displayName.replace(/\s+/g, ""));

          var dirAnswer = await inquirer.prompt([{
            type: "input",
            name: "dir",
            message: scope + ":",
            default: suggestedDir,
          }]);

          scopeDirectories[scope] = dirAnswer.dir;
        }

        context.answers.scopeDirectories = scopeDirectories;
        return selectedScopes;
      },
    },
  ],

  initialize: async (context: Sinc.InitContext): Promise<void> => {
    var selectedScopes: string[] = context.answers.selectedScopes || [];
    if (selectedScopes.length === 0) {
      // Backward compat: single scope from old flow
      if (context.answers.selectedScope) {
        selectedScopes = [context.answers.selectedScope];
      } else {
        logger.warn("No applications selected — skipping initialization.");
        return;
      }
    }

    var rootDir = context.rootDir;
    var doveConfigPath = path.join(rootDir, "dove.config.js");
    var sincConfigPath = path.join(rootDir, "sinc.config.js");
    var scopeDirectories: Record<string, string> = context.answers.scopeDirectories || {};

    // Write or preserve config. New configs are always written as dove.config.js;
    // existing sinc.config.js files are honored as legacy until the user runs `dove migrate`.
    var configAction = context.answers.configAction || "keep";
    var existingConfigPath: string | null = null;
    if (fs.existsSync(doveConfigPath)) existingConfigPath = doveConfigPath;
    else if (fs.existsSync(sincConfigPath)) existingConfigPath = sincConfigPath;

    if (!existingConfigPath || configAction === "replace") {
      logger.info("Generating dove.config.js...");
      var scopeEntries = selectedScopes.map(function(scope) {
        return {
          scope: scope,
          sourceDirectory: scopeDirectories[scope] || ("src/" + scope),
        };
      });
      fs.writeFileSync(doveConfigPath, ConfigManager.generateConfigFile({ scopes: scopeEntries }), "utf8");
      logger.success(chalk.green("✓ Generated dove.config.js with " + selectedScopes.length + " scope(s)"));
      if (existingConfigPath === sincConfigPath) {
        logger.warn("Legacy sinc.config.js still present alongside new dove.config.js. Run 'dove migrate' or delete sinc.config.js once you're satisfied.");
      }
    } else {
      var configFileName = path.basename(existingConfigPath);
      logger.info(configFileName + " already exists — preserving configuration.");
    }

    // Reload configs so ConfigManager picks up the new/existing config
    try {
      await ConfigManager.loadConfigs();
    } catch (e) {
      logger.warn("Config reload incomplete — this is expected during first-time init.");
    }

    // Check which scopes already have manifests
    var scopesWithManifests: string[] = [];
    var scopesToDownload: string[] = [];

    for (var i = 0; i < selectedScopes.length; i++) {
      var scope = selectedScopes[i];
      var doveManifestPath = path.join(rootDir, "dove.manifest." + scope + ".json");
      var sincManifestPath = path.join(rootDir, "dove.manifest." + scope + ".json");
      var hasManifest = fs.existsSync(doveManifestPath) || fs.existsSync(sincManifestPath);

      if (hasManifest) {
        scopesWithManifests.push(scope);
      } else {
        scopesToDownload.push(scope);
      }
    }

    // Batch prompt for scopes that already have manifests
    if (scopesWithManifests.length > 0) {
      var redownload = await inquirer.prompt([{
        type: "confirm",
        name: "confirmed",
        message: scopesWithManifests.length + " scope(s) already have manifests (" + scopesWithManifests.join(", ") + "). Re-download?",
        default: false,
      }]);
      if (redownload.confirmed) {
        scopesToDownload = scopesToDownload.concat(scopesWithManifests);
      }
    }

    if (scopesToDownload.length === 0) {
      logger.info("No scopes to download — all manifests up to date.");
      return;
    }

    // Download all scopes using the battle-tested processScope pipeline
    logger.info("Downloading " + scopesToDownload.length + " scope(s)...");

    var config = ConfigManager.getConfig();
    var scopePromises = scopesToDownload.map(function(scopeName) {
      var scopeConfig = (config.scopes && config.scopes[scopeName]) || {};
      return processScope(scopeName, scopeConfig as any, 0);
    });

    var results = await Promise.allSettled(scopePromises);

    // Write per-scope manifest files and tally results
    var successCount = 0;
    var failCount = 0;

    for (var r = 0; r < results.length; r++) {
      var result = results[r];
      var scopeName = scopesToDownload[r];

      if (result.status === "fulfilled" && result.value.success) {
        successCount++;
        // Write per-scope manifest
        if (result.value.manifest) {
          var scopeManifestPath = ConfigManager.getScopeManifestPath(scopeName);
          fs.writeFileSync(scopeManifestPath, JSON.stringify(result.value.manifest, null, 2), "utf8");
        }
      } else {
        failCount++;
        var error = result.status === "rejected" ? result.reason : (result.value && result.value.error);
        logger.error("Failed to initialize " + scopeName + ": " + (error && error.message ? error.message : "Unknown error"));
      }
    }

    // Summary
    logger.info("");
    if (failCount === 0) {
      logger.success(chalk.green("✓ ServiceNow configured — " + successCount + " scope(s) initialized"));
    } else {
      logger.warn(successCount + "/" + scopesToDownload.length + " scopes initialized, " + failCount + " failed");
    }
  },
};

/**
 * @description Validates ServiceNow credentials by testing the connection.
 * Called by the orchestrator after all core login hooks are collected.
 */
export async function validateCoreLogin(context: Sinc.InitContext): Promise<true | string> {
  const instance = context.env.SN_INSTANCE;
  const user = context.env.SN_USER;
  const password = context.env.SN_PASSWORD;
  const apiKey = context.env.SN_API_KEY;

  // SN_USER stays required even in API-key mode — the client's user-preference
  // logic (current app / update set pinning) resolves the acting user from it.
  if (!instance || !user || (!password && !apiKey)) {
    return "Missing required credentials";
  }

  const instanceUrl = normalizeInstance(instance);
  const baseUrl = instanceBaseUrl(instance);

  try {
    const client = snClient(baseUrl, user, password, apiKey);
    await unwrapSNResponse(client.getAppList());
    context.env.SN_INSTANCE = instanceUrl;
    return true;
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e && e.response && e.response.status;

    if (msg.includes("Invalid URL") || msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
      return "Instance not found — check the URL (got: " + instanceUrl + ")";
    }
    if (status === 401 || msg.includes("401")) {
      return "Invalid credentials — check the username/password (or the API key and its REST API access policies).";
    }
    if (status === 403 || msg.includes("403")) {
      return "Access denied — user may lack required roles.";
    }
    if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET")) {
      return "Could not reach " + instanceUrl + " — check network connectivity.";
    }
    return "Connection failed: " + msg;
  }
}

export function normalizeInstance(instance: string): string {
  let url = instance.trim().replace("https://", "").replace("http://", "");
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
  return url;
}

function instanceBaseUrl(instance: string): string {
  return "https://" + normalizeInstance(instance) + "/";
}
