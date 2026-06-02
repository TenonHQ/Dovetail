import dotenv from "dotenv";
import * as ConfigManager from "./config";
import { logger } from "./Logger";
import { parseEnvArg, resolveEnvArgPath } from "./envArg";

export async function init() {
  // Honor a per-command `--env <path>` override before config/env load so
  // dotenv reads the requested file. Resolved here (not in loadConfigs) because
  // the override must be set before loadEnvPath runs inside loadConfigs.
  const envArg = parseEnvArg(process.argv.slice(2));
  if (envArg) {
    ConfigManager.setEnvPathOverride(resolveEnvArgPath(envArg));
  }

  let configLoaded = false;
  try {
    await ConfigManager.loadConfigs();
    configLoaded = true;
  } catch (e) {
    logger.error("Failed to load configuration: " + String(e));
  }

  if (configLoaded) {
    try {
      let path = ConfigManager.getEnvPath();
      dotenv.config({ path });
    } catch (e) {
      logger.error("Failed to load environment: " + String(e));
    }
  }

  (await import("./commander")).initCommands();
}
