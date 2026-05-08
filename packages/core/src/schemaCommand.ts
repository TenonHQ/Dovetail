import { pullSchema } from "@tenonhq/dovetail-schema";
import { logger } from "./Logger";
import * as ConfigManager from "./config";
import path from "path";

interface SchemaCommandArgs {
  logLevel: string;
  output?: string;
  scope?: string;
}

export async function schemaPullCommand(args: SchemaCommandArgs) {
  const { SN_USER = "", SN_PASSWORD = "", SN_INSTANCE = "" } = process.env;

  if (!SN_USER || !SN_PASSWORD || !SN_INSTANCE) {
    throw new Error(
      "Missing ServiceNow credentials. Ensure SN_INSTANCE, SN_USER, and SN_PASSWORD are set in your .env file or environment."
    );
  }

  const config = ConfigManager.getConfig();
  const configScopes = config.scopes ? Object.keys(config.scopes) : [];

  if (configScopes.length === 0) {
    throw new Error(
      "No scopes configured in dove.config.js. Add scopes to the 'scopes' object in your configuration."
    );
  }

  // If --scope flag is provided, filter to that single scope
  let scopes = configScopes;
  if (args.scope) {
    if (!configScopes.includes(args.scope)) {
      throw new Error(
        `Scope "${args.scope}" is not configured in dove.config.js. Available scopes: ${configScopes.join(", ")}`
      );
    }
    scopes = [args.scope];
  }

  const rootDir = ConfigManager.getRootDir();
  const outputDir = args.output
    ? path.resolve(args.output)
    : path.join(rootDir, "schema");

  try {
    const index = await pullSchema({
      instance: SN_INSTANCE,
      username: SN_USER,
      password: SN_PASSWORD,
      outputDir,
      scopes,
    });

    logger.success(
      `Schema pull complete! ${index.total_tables} tables across ${index.applications.length} applications written to ${outputDir}`
    );
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    logger.error("Schema pull failed: " + message);
    throw e;
  }
}
