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
    ConfigManager.setEnvPathOverride(
      resolveEnvArgPath(envArg, undefined, {
        onParentMatch: function (foundPath) {
          // stderr, never stdout (stdout carries --json / format json output).
          // The path only — never anything from the file. Same notice as dove-sn.
          process.stderr.write(
            "dove: --env " +
              envArg +
              ": using " +
              foundPath +
              " (found in a parent directory)\n",
          );
        },
      }),
    );
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
