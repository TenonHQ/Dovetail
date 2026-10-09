import { Sinc, TSFIXME } from "@tenonhq/dovetail-types";
import fs from "fs";
import path from "path";
import inquirer from "inquirer";
import chalk from "chalk";
import {
  defaultClient,
  unwrapSNResponse,
  SNClient,
  SNReferenceValue,
} from "./snClient";
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
  refresh?: boolean;
  logLevel: string;
}

interface UpdateSetSelection {
  sys_id: string;
  name: string;
}

type UpdateSetConfig = Record<string, UpdateSetSelection>;

/**
 * Table whose rows must NOT go through the generic record insert. A plain
 * insert lets ServiceNow default `application` to the API session's current
 * app (gs.getCurrentApplicationId()), so `--scope` was silently ignored and
 * the set landed in whatever scope the session happened to be in
 * (TenonHQ/Dovetail#231). Rows for this table route through the atomic
 * `createUpdateSet` server op instead.
 */
export const UPDATE_SET_TABLE = "sys_update_set";

/** Fields `dove create` can map onto the createUpdateSet server op. */
const UPDATE_SET_OP_FIELDS: string[] = ["name", "description"];

/** Scope names are identifiers (`x_cadso_core`, `global`) — nothing else. */
const SCOPE_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

/** Outcome of a verified `sys_update_set` creation. */
export interface CreatedUpdateSet {
  sysId: string;
  name: string;
  scope: string;
  scopeSysId: string;
}

/**
 * Raised when a created update set is readable but its `application` does
 * not match the requested scope. Carries both sides so callers can print an
 * actionable message and exit non-zero instead of claiming success.
 */
export class UpdateSetScopeMismatchError extends Error {
  updateSetSysId: string;
  requestedScope: string;
  requestedScopeSysId: string;
  actualScope: string;
  actualScopeSysId: string;

  constructor(details: {
    updateSetName: string;
    updateSetSysId: string;
    requestedScope: string;
    requestedScopeSysId: string;
    actualScope: string;
    actualScopeSysId: string;
  }) {
    super(
      'Update set "' +
        details.updateSetName +
        '" (' +
        details.updateSetSysId +
        ") landed in scope " +
        details.actualScope +
        " (" +
        details.actualScopeSysId +
        ") but --scope " +
        details.requestedScope +
        " (" +
        details.requestedScopeSysId +
        ") was requested. The set is MIS-SCOPED: delete it on the instance " +
        "before it collects captures, then confirm the Dovetail " +
        "createUpdateSet REST op is installed on this instance and retry.",
    );
    this.name = "UpdateSetScopeMismatchError";
    this.updateSetSysId = details.updateSetSysId;
    this.requestedScope = details.requestedScope;
    this.requestedScopeSysId = details.requestedScopeSysId;
    this.actualScope = details.actualScope;
    this.actualScopeSysId = details.actualScopeSysId;
  }
}

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
    if (manifest && !ConfigManager.isMultiScopeManifest(manifest) && manifest.scope) {
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
 * Normalizes a Table API reference field — a bare sys_id string, or the
 * `{ value, link }` object the Table API returns without display values —
 * to its sys_id. Returns undefined for anything else (missing, empty, wrong
 * shape) so callers never compare against garbage.
 */
function referenceSysId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value.trim();
  }
  if (value !== null && typeof value === "object") {
    var inner = (value as Partial<SNReferenceValue>).value;
    if (typeof inner === "string" && inner.trim() !== "") {
      return inner.trim();
    }
  }
  return undefined;
}

/**
 * Reads the created set back and returns its `application` sys_id. Falls
 * back to the create response when the read-back fails or carries no
 * application. Returns undefined when neither source can prove the scope.
 */
async function readBackApplication(
  client: SNClient,
  updateSetSysId: string,
  createResponseApplication: unknown,
): Promise<string | undefined> {
  try {
    var rows = await unwrapSNResponse(client.getUpdateSetById(updateSetSysId));
    if (Array.isArray(rows) && rows.length > 0) {
      var fromReadBack = referenceSysId(rows[0].application);
      if (fromReadBack) {
        return fromReadBack;
      }
    }
    fileLogger.warn(
      "Update set read-back returned no application for " + updateSetSysId,
    );
  } catch (readErr) {
    fileLogger.warn(
      "Update set read-back failed for " +
        updateSetSysId +
        ": " +
        (readErr instanceof Error ? readErr.message : String(readErr)),
    );
  }
  return referenceSysId(createResponseApplication);
}

/**
 * Resolves a scope sys_id back to its name for error messages. Never throws —
 * falls back to the sys_id itself so a lookup failure can't mask the
 * mismatch we are about to report.
 */
async function scopeNameForSysId(
  client: SNClient,
  scopeSysId: string,
): Promise<string> {
  try {
    var rows = await unwrapSNResponse(client.getScopeById(scopeSysId));
    if (Array.isArray(rows) && rows.length > 0 && rows[0].scope) {
      return rows[0].scope;
    }
  } catch (e) {
    // fall through to the sys_id
  }
  return scopeSysId;
}

/**
 * Creates a `sys_update_set` through the scope-correct `createUpdateSet`
 * server op and PROVES it landed in the requested scope. Throws on a
 * mis-scoped or unverifiable set — the caller must never report success.
 */
export async function createUpdateSetRecord(
  client: SNClient,
  scope: string,
  fields: Record<string, string>,
): Promise<CreatedUpdateSet> {
  if (typeof scope !== "string" || !SCOPE_NAME_PATTERN.test(scope)) {
    throw new Error(
      "Invalid scope name " +
        JSON.stringify(scope) +
        ": expected an application scope such as x_cadso_core.",
    );
  }
  var name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (name === "") {
    throw new Error("Update set name is required.");
  }
  var description =
    typeof fields.description === "string" && fields.description.trim() !== ""
      ? fields.description
      : undefined;

  var unsupported = Object.keys(fields).filter(function (key) {
    return UPDATE_SET_OP_FIELDS.indexOf(key) === -1;
  });
  if (unsupported.length > 0) {
    logger.warn(
      "sys_update_set is created through the scope-correct createUpdateSet " +
        "op, which accepts only " +
        UPDATE_SET_OP_FIELDS.join(", ") +
        ". Ignoring field(s): " +
        unsupported.join(", "),
    );
  }

  // Resolve the scope name to the application sys_id the op needs.
  var scopeRows = await unwrapSNResponse(client.getScopeId(scope));
  if (!Array.isArray(scopeRows) || scopeRows.length === 0) {
    throw new Error('Scope "' + scope + '" not found on the instance.');
  }
  var scopeSysId = scopeRows[0].sys_id;
  if (typeof scopeSysId !== "string" || scopeSysId.trim() === "") {
    throw new Error('Scope "' + scope + '" resolved without a sys_id.');
  }

  // Refuse a duplicate: a second in-progress set with the same name in the
  // same scope (e.g. a retry after a timeout that had already succeeded) makes
  // every later activate-by-name ambiguous.
  var existingSets = await unwrapSNResponse(
    client.getInProgressUpdateSetsByName(name, scopeSysId),
  );
  if (Array.isArray(existingSets) && existingSets.length > 0) {
    var existingIds = existingSets
      .map(function (row) {
        return row && typeof row.sys_id === "string" ? row.sys_id : "?";
      })
      .join(", ");
    throw new Error(
      'An in-progress update set named "' +
        name +
        '" already exists in scope ' +
        scope +
        " (" +
        existingIds +
        "). Refusing to create a duplicate — reuse it with " +
        "npx dove switchUpdateSet --sysId <sys_id> -s " +
        scope +
        ", or pick a different name.",
    );
  }

  fileLogger.debug(
    "createUpdateSet op:",
    JSON.stringify({ name: name, scope: scope, application: scopeSysId }),
  );
  var created = await unwrapSNResponse(
    client.createUpdateSet(name, scopeSysId, description),
  );
  var createdSysId =
    created && typeof created.sys_id === "string" ? created.sys_id : "";
  if (createdSysId === "") {
    throw new Error("createUpdateSet returned no sys_id for " + name);
  }

  // Verify on the way out: the whole point of this path is that the set is
  // in the requested scope, so prove it rather than trust the op.
  var actualScopeSysId = await readBackApplication(
    client,
    createdSysId,
    (created as { application?: unknown }).application,
  );
  if (!actualScopeSysId) {
    throw new Error(
      'Update set "' +
        name +
        '" (' +
        createdSysId +
        ") was created but its application scope could not be verified " +
        "(requested " +
        scope +
        " / " +
        scopeSysId +
        "). Inspect the set on the instance before using it.",
    );
  }
  if (actualScopeSysId !== scopeSysId) {
    var actualScope = await scopeNameForSysId(client, actualScopeSysId);
    throw new UpdateSetScopeMismatchError({
      updateSetName: name,
      updateSetSysId: createdSysId,
      requestedScope: scope,
      requestedScopeSysId: scopeSysId,
      actualScope: actualScope,
      actualScopeSysId: actualScopeSysId,
    });
  }

  var createdName = (created as { name?: unknown }).name;
  return {
    sysId: createdSysId,
    name: typeof createdName === "string" && createdName !== "" ? createdName : name,
    scope: scope,
    scopeSysId: scopeSysId,
  };
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

    var isUpdateSet = table === UPDATE_SET_TABLE;

    fileLogger.debug("Create record: table=" + table);

    // An update set's application is decided by --scope alone. In CI there is
    // no human to confirm a manifest-inferred scope, so require it explicitly
    // rather than let an inherited scope mis-route every later capture.
    if (isUpdateSet && typedArgs.ci && !typedArgs.scope) {
      logger.error(
        "--scope is required when creating sys_update_set in --ci mode: " +
          "the scope decides the update set's application.",
      );
      process.exit(1);
    }

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

    // 4. Check update set configuration. An update set is not itself captured
    // in an update set, so skip the lookup for sys_update_set.
    var updateSet: UpdateSetSelection | undefined;
    var updateSetSysId: string | undefined;

    if (!isUpdateSet) {
      var updateSetConfig = getUpdateSetConfig();
      updateSet = updateSetConfig[scope];
      if (updateSet) {
        logger.info("Update set: " + chalk.cyan(updateSet.name));
        updateSetSysId = updateSet.sys_id;
      }
    }

    // 5. Confirmation prompt
    if (!typedArgs.ci) {
      logger.info("");
      logger.info(chalk.bold("Create Record Summary:"));
      logger.info("  Table: " + chalk.cyan(table));
      logger.info("  Name: " + chalk.cyan(fields.name));
      logger.info("  Scope: " + chalk.cyan(scope));
      if (isUpdateSet) {
        logger.info(
          "  Via: Dovetail createUpdateSet op (application = scope above)",
        );
      }
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

    var client = defaultClient();

    // 6a. sys_update_set: the scope-correct server op, verified on the way out.
    if (isUpdateSet) {
      logger.info("Creating update set via the Dovetail createUpdateSet op...");
      var createdSet = await createUpdateSetRecord(client, scope, fields);
      logger.success(
        chalk.green("Update set created: ") +
          chalk.bold(createdSet.name) +
          " (" +
          createdSet.sysId +
          ") in scope " +
          chalk.cyan(createdSet.scope),
      );
      logger.info(
        "Verified application = " +
          createdSet.scope +
          " (" +
          createdSet.scopeSysId +
          ").",
      );
      logger.info(
        "Not activated. To route pushes to it: npx dove switchUpdateSet --sysId " +
          createdSet.sysId +
          " -s " +
          createdSet.scope,
      );
      return;
    }

    // 6b. Every other table: the generic create endpoint
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

    // 7. Round-trip: pull ONLY the new record's files back locally. Scoped to
    // { table, sysId } so creating one record no longer refreshes the entire
    // scope (the whole-scope-churn footgun). --no-refresh skips it entirely.
    if (typedArgs.refresh === false) {
      logger.info(
        "Skipping local sync (--no-refresh). Run 'npx dove refresh' to pull the record locally.",
      );
    } else {
      logger.info("Syncing record to local files...");
      fileLogger.debug("Starting single-record sync for scope:", scope);

      try {
        var syncResult = await AppUtils.syncManifest(scope, {
          record: { table: table, sysId: newSysId },
        });
        // syncManifest reports a failed scope in its result instead of
        // throwing; route it to the catch below so we never claim the local
        // files were created when the refresh failed.
        if (syncResult && syncResult.failedScopes && syncResult.failedScopes.length > 0) {
          throw new Error(syncResult.failedScopes[0].error);
        }
        // Resolve the scope's own source directory — syncManifest writes into
        // getSourcePathForScope(scope), which a scope config can override. Using
        // the top-level getSourcePath() here would print a wrong path in
        // multi-scope setups even though the files landed correctly.
        var sourcePath = ConfigManager.getSourcePathForScope(scope);
        var localPath = path.join(sourcePath, table, recordName);
        logger.success(chalk.green("Local files created at: ") + localPath);
      } catch (syncErr) {
        logger.warn("Record created on instance but local sync failed.");
        logger.warn("Run 'npx dove refresh' to pull the record locally.");
        if (syncErr instanceof Error) {
          fileLogger.error("Sync error:", syncErr.message);
        }
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
        fileLogger.error("Create failed — status: " + respStatus + ", response: " + JSON.stringify(respData));
      }
    }
    process.exit(1);
  }
}
