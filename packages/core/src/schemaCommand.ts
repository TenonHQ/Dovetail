import {
  pullSchema,
  writeSnapshot,
  listSnapshots,
  resolveSnapshotDir,
  readSchemaTree,
  diffSchemas,
  formatDiff,
} from "@tenonhq/dovetail-schema";
import { logger } from "./Logger";
import * as ConfigManager from "./config";
import path from "path";
import os from "os";
import { promises as fsp } from "fs";

interface SchemaCommandArgs {
  logLevel: string;
  output?: string;
  scope?: string;
  // pull
  snapshot?: string | boolean;
  // diff
  from?: string;
  to?: string;
  format?: string;
}

interface Creds {
  SN_USER: string;
  SN_PASSWORD: string;
  SN_INSTANCE: string;
  SN_API_KEY: string;
}

function requireCreds(): Creds {
  const {
    SN_USER = "",
    SN_PASSWORD = "",
    SN_INSTANCE = "",
    SN_API_KEY = "",
  } = process.env;
  // SN_USER stays required even in API-key mode (acting-user resolution);
  // the password becomes optional once an inbound API key is set.
  if (!SN_USER || !SN_INSTANCE || (!SN_PASSWORD && !SN_API_KEY)) {
    throw new Error(
      "Missing ServiceNow credentials. Ensure SN_INSTANCE, SN_USER, and SN_PASSWORD (or SN_API_KEY) are set in your .env file or environment."
    );
  }
  return { SN_USER, SN_PASSWORD, SN_INSTANCE, SN_API_KEY };
}

function normalizeInstance(instance: string): string {
  return instance.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function resolveScopes(args: SchemaCommandArgs): string[] {
  const config = ConfigManager.getConfig();
  const configScopes = config.scopes ? Object.keys(config.scopes) : [];
  if (configScopes.length === 0) {
    throw new Error(
      "No scopes configured in dove.config.js. Add scopes to the 'scopes' object in your configuration."
    );
  }
  if (args.scope) {
    if (!configScopes.includes(args.scope)) {
      throw new Error(
        `Scope "${args.scope}" is not configured in dove.config.js. Available scopes: ${configScopes.join(", ")}`
      );
    }
    return [args.scope];
  }
  return configScopes;
}

function outputDirFor(args: SchemaCommandArgs): string {
  const rootDir = ConfigManager.getRootDir();
  return args.output ? path.resolve(args.output) : path.join(rootDir, "schema");
}

export async function schemaPullCommand(args: SchemaCommandArgs) {
  const { SN_USER, SN_PASSWORD, SN_INSTANCE, SN_API_KEY } = requireCreds();
  const scopes = resolveScopes(args);
  const outputDir = outputDirFor(args);

  try {
    const index = await pullSchema({
      instance: SN_INSTANCE,
      username: SN_USER,
      password: SN_PASSWORD,
      apiKey: SN_API_KEY,
      outputDir,
      scopes,
    });

    logger.success(
      `Schema pull complete! ${index.total_tables} tables across ${index.applications.length} applications written to ${outputDir}`
    );

    if (args.snapshot !== undefined && args.snapshot !== false) {
      const label =
        typeof args.snapshot === "string" && args.snapshot.length > 0
          ? args.snapshot
          : null;
      const info = await writeSnapshot({
        outputDir,
        index,
        label,
        now: new Date().toISOString(),
      });
      logger.success(
        "Snapshot saved" + (label ? ` (${label})` : "") + ": " + info.dir
      );
    }
  } catch (e) {
    let message;
    if (e instanceof Error) message = e.message;
    else message = String(e);
    logger.error("Schema pull failed: " + message);
    throw e;
  }
}

// Resolve a diff ref to a directory of schema files. `live` triggers a fresh
// pull into a temp dir; everything else resolves to a snapshot/baseline dir.
async function resolveRefDir(options: {
  ref: string;
  outputDir: string;
  instance: string;
  scopes: string[];
  creds: Creds;
}): Promise<string> {
  const { ref, outputDir, instance, scopes, creds } = options;
  if (ref === "live") {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dove-schema-live-"));
    await pullSchema({
      instance: creds.SN_INSTANCE,
      username: creds.SN_USER,
      password: creds.SN_PASSWORD,
      apiKey: creds.SN_API_KEY,
      outputDir: tmpDir,
      scopes,
    });
    return tmpDir;
  }
  return resolveSnapshotDir({ ref, outputDir, instance });
}

export async function schemaDiffCommand(args: SchemaCommandArgs) {
  const creds = requireCreds();
  const instance = normalizeInstance(creds.SN_INSTANCE);
  const outputDir = outputDirFor(args);
  const scopes = resolveScopes(args);
  const scope = args.scope || null;
  const format = args.format === "json" ? "json" : "text";

  // Default `from` = newest snapshot for this instance; default `to` = live.
  let fromRef = args.from;
  if (!fromRef) {
    const snapshots = await listSnapshots({ outputDir, instance });
    if (snapshots.length === 0) {
      throw new Error(
        "No --from given and no snapshots found for " +
          instance +
          ". Create one with `dove schema pull --snapshot <label>`, or pass --from <path>."
      );
    }
    fromRef = path.basename(snapshots[0].dir);
  }
  const toRef = args.to || "live";

  const fromDir = await resolveRefDir({ ref: fromRef, outputDir, instance, scopes, creds });
  const toDir = await resolveRefDir({ ref: toRef, outputDir, instance, scopes, creds });

  const from = await readSchemaTree({ dir: fromDir, scope });
  const to = await readSchemaTree({ dir: toDir, scope });

  const diff = diffSchemas({ from, to, fromRef, toRef, scope });
  // Print with console.log so formatDiff's own severity colors survive (the
  // winston logger re-wraps every line in a single color).
  console.log(formatDiff(diff, { format }));

  // Non-zero exit on breaking drift, for CI gating.
  process.exitCode = diff.exit_code;
}

export async function schemaSnapshotsCommand(args: SchemaCommandArgs) {
  const creds = requireCreds();
  const instance = normalizeInstance(creds.SN_INSTANCE);
  const outputDir = outputDirFor(args);

  const snapshots = await listSnapshots({ outputDir, instance });
  if (snapshots.length === 0) {
    logger.info(
      "No snapshots for " +
        instance +
        ". Create one with `dove schema pull --snapshot <label>`."
    );
    return;
  }

  logger.info("Snapshots for " + instance + ":");
  for (const snap of snapshots) {
    console.log(
      "  " +
        path.basename(snap.dir) +
        "  " +
        snap.total_tables +
        " tables" +
        (snap.label ? "  [" + snap.label + "]" : "")
    );
  }
}
