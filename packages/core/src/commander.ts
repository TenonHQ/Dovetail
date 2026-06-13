import { Sinc, TSFIXME } from "@tenonhq/dovetail-types";
import {
  refreshCommand,
  pushCommand,
  downloadCommand,
  initCommand,
  buildCommand,
  deployCommand,
  statusCommand,
  taskClearCommand,
} from "./commands";

import { initScopesCommand, watchAllScopesCommand } from "./allScopesCommands";
import {
  createUpdateSetCommand,
  switchUpdateSetCommand,
  listUpdateSetsCommand,
  showCurrentUpdateSetCommand,
  changeScopeCommand,
  showCurrentScopeCommand,
} from "./updateSetCommands";
import { dashboardCommand } from "./dashboardCommand";
import {
  schemaPullCommand,
  schemaDiffCommand,
  schemaSnapshotsCommand,
} from "./schemaCommand";
import { initClaudeCommand } from "./claudeCommand";
import { createRecordCommand } from "./createRecordCommand";
import { deleteRecordCommand } from "./deleteRecordCommand";
import { reconcileCommand } from "./reconcileCommand";
import { migrateCommand } from "./migrateCommand";
import {
  clickupTasksCommand,
  clickupTaskCommand,
  clickupCreateCommand,
  clickupUpdateCommand,
  clickupCommentCommand,
  clickupSetupCommand,
  clickupTeamsCommand,
  clickupSpacesCommand,
  clickupListsCommand,
} from "./clickupCommands";
import { loginCommand } from "./loginCommand";
import { knowledgeDiffCommand } from "./knowledgeDiffCommand";
import yargs from "yargs";
export async function initCommands() {
  const sharedOptions = {
    logLevel: {
      default: "info",
    },
  };

  yargs
    .option("env", {
      alias: "e",
      type: "string",
      describe:
        "Path to a .env file to load for this command (default: .env in the project root). Lets one checkout target multiple instances.",
    })
    .global("env")
    .command(
      ["watch", "w", "watchAllScopes"],
      "Watch all scopes for file changes and sync to ServiceNow",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          noDashboard: {
            type: "boolean",
            default: false,
            describe: "Skip launching the dashboard web UI",
          },
          port: {
            alias: "p",
            type: "number",
            describe: "Dashboard port (default: DASHBOARD_PORT env or 3456)",
          },
          monitorInterval: {
            type: "number",
            default: 120,
            describe: "Update set monitoring interval in seconds (default: 120)",
          },
          noMonitoring: {
            type: "boolean",
            default: false,
            describe: "Disable background update set monitoring",
          },
        });
        return cmdArgs;
      },
      async (args: TSFIXME) => {
        await watchAllScopesCommand(args as Sinc.WatchCmdArgs);
      },
    )
    .command(
      ["refresh", "r"],
      "Pull latest manifest and file contents from the ServiceNow instance",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          force: {
            alias: "f",
            type: "boolean",
            default: false,
            describe: "Overwrite local files even when content matches the instance",
          },
          scope: {
            alias: "s",
            type: "string",
            describe: "Refresh a single scope (default: all declared scopes)",
          },
          benchmark: {
            alias: "b",
            type: "boolean",
            default: false,
            describe: "Log per-scope and aggregate HTTP latency, bytes, and file counts",
          },
        });
        return cmdArgs;
      },
      async (args: TSFIXME) => {
        await refreshCommand(args as Sinc.SharedCmdArgs & {
          force?: boolean;
          scope?: string;
          benchmark?: boolean;
        });
      },
    )
    .command(
      ["push [target]"],
      "[DESTRUCTIVE] Push all files from current local files to ServiceNow instance.",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          diff: {
            alias: "d",
            type: "string",
            default: "",
            describe: "Specify branch to do git diff against",
          },
          updateSet: {
            alias: "us",
            type: "string",
            default: "",
            describe:
              "Will create a new update set with the provided anme to store all changes into",
          },
          clickup: {
            alias: "cu",
            type: "string",
            describe:
              "ClickUp task ID or URL — creates update set from ClickUp task data",
          },
          ci: {
            type: "boolean",
            default: false,
            describe: "Will skip confirmation prompts during the push process",
          },
        });
        return cmdArgs;
      },
      async (args: TSFIXME) => {
        await pushCommand(args as Sinc.PushCmdArgs);
      },
    )
    .command(
      "download <scope>",
      "Downloads a scoped application's files from ServiceNow. Must specify a scope prefix for a scoped app.",
      sharedOptions,
      async (args: TSFIXME) => {
        await downloadCommand(args as Sinc.CmdDownloadArgs);
      },
    )
    .command(
      "init",
      "Set up Dovetail — discovers installed packages, authenticates, and configures your project",
      sharedOptions,
      initCommand,
    )
    .command(
      "login [plugin]",
      "Authenticate with ServiceNow and other integrations",
      function (cmdArgs: TSFIXME) {
        cmdArgs.positional("plugin", {
          describe: "Plugin name to login (e.g., clickup). Omit for ServiceNow only.",
          type: "string",
        });
        cmdArgs.options({
          ...sharedOptions,
          all: {
            type: "boolean",
            default: false,
            describe: "Login to all detected integrations",
          },
          instance: {
            type: "string",
            describe: "ServiceNow instance URL (non-interactive)",
          },
          user: {
            type: "string",
            describe: "ServiceNow username (non-interactive)",
          },
          password: {
            type: "string",
            describe: "ServiceNow password (non-interactive)",
          },
        });
        return cmdArgs;
      },
      loginCommand,
    )
    .command(
      "initScopes",
      "Provisions an initial project for the scopes defined in the config",
      {
        ...sharedOptions,
        delay: {
          alias: "d",
          type: "number",
          default: 0,
          describe:
            "Delay in milliseconds between API calls (to prevent server overload)",
        },
      },
      initScopesCommand,
    )
    .command(
      "build",
      "Build application files locally",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          diff: {
            alias: "d",
            type: "string",
            default: "",
            describe: "Specify branch to do git diff against",
          },
        });
        return cmdArgs;
      },
      async (args: TSFIXME) => {
        await buildCommand(args);
      },
    )
    .command(
      "deploy",
      "Deploy local build files to the scoped application",
      sharedOptions,
      deployCommand,
    )
    .command(
      "create <table>",
      "Create a new record on the ServiceNow instance",
      (cmdArgs: TSFIXME) => {
        cmdArgs.positional("table", {
          describe: "ServiceNow table name (e.g., sys_script_include)",
          type: "string",
        });
        cmdArgs.options({
          ...sharedOptions,
          name: {
            alias: "n",
            type: "string",
            describe: "Record name",
          },
          scope: {
            alias: "s",
            type: "string",
            describe: "Target scope (e.g., x_cadso_core)",
          },
          from: {
            alias: "f",
            type: "string",
            describe: "Path to JSON file with field values",
          },
          field: {
            type: "array",
            describe:
              "Field values as key=value pairs (e.g., --field active=true)",
          },
          ci: {
            type: "boolean",
            default: false,
            describe: "Skip interactive prompts",
          },
        });
        return cmdArgs;
      },
      createRecordCommand,
    )
    .command(
      "delete <table> [name]",
      "Delete a record from the ServiceNow instance",
      (cmdArgs: TSFIXME) => {
        cmdArgs.positional("table", {
          describe: "ServiceNow table name (e.g., sys_script_include)",
          type: "string",
        });
        cmdArgs.positional("name", {
          describe: "Record name to delete",
          type: "string",
        });
        cmdArgs.options({
          ...sharedOptions,
          scope: {
            alias: "s",
            type: "string",
            describe: "Target scope (e.g., x_cadso_core)",
          },
          sysid: {
            type: "string",
            describe: "Delete by sys_id directly (skip manifest lookup)",
          },
          ci: {
            type: "boolean",
            default: false,
            describe: "Skip confirmation prompt",
          },
          keepLocal: {
            type: "boolean",
            default: false,
            describe: "Keep local files after deleting from instance",
          },
        });
        return cmdArgs;
      },
      deleteRecordCommand,
    )
    .command(
      "status",
      "Get information about the connected instance",
      sharedOptions,
      statusCommand,
    )
    .command(
      "createUpdateSet",
      "Create a new update set and switch to it",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          name: {
            alias: "n",
            type: "string",
            describe: "Name of the update set to create",
          },
          description: {
            alias: "d",
            type: "string",
            describe: "Description of the update set",
          },
          scope: {
            alias: "s",
            type: "string",
            describe: "Scope for the update set (e.g., x_company_app)",
          },
          skipDescription: {
            type: "boolean",
            default: false,
            describe: "Skip prompting for description",
          },
          skipScope: {
            type: "boolean",
            default: false,
            describe: "Skip prompting for scope",
          },
          clickup: {
            alias: "cu",
            type: "string",
            describe:
              "ClickUp task ID or URL to generate update set name and description from",
          },
        });
        return cmdArgs;
      },
      createUpdateSetCommand,
    )
    .command(
      "switchUpdateSet",
      "Switch to an existing update set",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          name: {
            alias: "n",
            type: "string",
            describe: "Name or partial name of the update set to switch to",
          },
          scope: {
            alias: "s",
            type: "string",
            describe: "Filter update sets by scope",
          },
        });
        return cmdArgs;
      },
      switchUpdateSetCommand,
    )
    .command(
      "listUpdateSets",
      "List all in-progress update sets",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          scope: {
            alias: "s",
            type: "string",
            describe: "Filter update sets by scope",
          },
        });
        return cmdArgs;
      },
      listUpdateSetsCommand,
    )
    .command(
      "currentUpdateSet",
      "Show the current active update set",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          scope: {
            alias: "s",
            type: "string",
            describe: "Scope to check update set for",
          },
        });
        return cmdArgs;
      },
      showCurrentUpdateSetCommand,
    )
    .command(
      "changeScope",
      "Change to a different scope",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          scope: {
            alias: "s",
            type: "string",
            describe: "Scope to switch to (e.g., x_cadso_core)",
          },
        });
        return cmdArgs;
      },
      changeScopeCommand,
    )
    .command(
      "currentScope",
      "Show the current active scope",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
        });
        return cmdArgs;
      },
      showCurrentScopeCommand,
    )
    .command(
      "dashboard",
      "Launch the Update Set Dashboard web UI",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          port: {
            alias: "p",
            type: "number",
            describe: "Dashboard port (default: DASHBOARD_PORT env or 3456)",
          },
        });
        return cmdArgs;
      },
      async (args: TSFIXME) => {
        await dashboardCommand(args);
      },
    )
    .command(
      "schema <subcommand>",
      "Manage ServiceNow table schemas (subcommands: pull, diff, snapshots)",
      (cmdArgs: TSFIXME) => {
        cmdArgs.positional("subcommand", {
          describe: "Schema subcommand to run",
          choices: ["pull", "diff", "snapshots"],
        });
        cmdArgs.options({
          ...sharedOptions,
          output: {
            alias: "o",
            type: "string",
            describe: "Output directory for schema files (default: schema/)",
          },
          scope: {
            alias: "s",
            type: "string",
            describe:
              "Single scope (default: all scopes from dove.config.js)",
          },
          snapshot: {
            type: "string",
            describe:
              "pull: also save an immutable snapshot with this label (timestamp-only if no label)",
          },
          from: {
            type: "string",
            describe:
              "diff: baseline ref — a snapshot label, snapshot dir name, or directory path (default: newest snapshot)",
          },
          to: {
            type: "string",
            describe:
              'diff: comparison ref — "live" for a fresh pull, or a snapshot ref (default: live)',
          },
          format: {
            type: "string",
            choices: ["text", "json"],
            describe: "diff: output format (default: text)",
          },
        });
        return cmdArgs;
      },
      async (args: TSFIXME) => {
        if (args.subcommand === "pull") {
          await schemaPullCommand(args);
        } else if (args.subcommand === "diff") {
          await schemaDiffCommand(args);
        } else if (args.subcommand === "snapshots") {
          await schemaSnapshotsCommand(args);
        }
      },
    )
    .command(
      "reconcile",
      "Make your personal instance match the checked-out branch (diff/report by default; --apply to apply CREATE + UPDATE + DELETE)",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          scope: {
            alias: "s",
            type: "string",
            describe: "Single scope (default: all scopes from dove.config.js)",
          },
          schema: {
            type: "boolean",
            default: true,
            describe:
              "Include schema drift (report-only). --no-schema to skip. Requires a `dove schema pull --snapshot`.",
          },
          "write-baseline": {
            type: "boolean",
            default: false,
            describe:
              "Establish the per-instance baseline (merge-base) from current live state. Run once before --apply.",
          },
          apply: {
            type: "boolean",
            default: false,
            describe:
              "Apply records branch -> instance: CREATE + UPDATE + tracked DELETE. Refuses on drift unless --force.",
          },
          force: {
            type: "boolean",
            default: false,
            describe:
              "With --apply: discard instance drift (edits to tracked records since baseline). Never deletes the dev's own local records.",
          },
        });
        return cmdArgs;
      },
      async (args: TSFIXME) => {
        await reconcileCommand(args);
      },
    )
    .command(
      "init-claude",
      "Install Dovetail Claude Code skills to .claude/commands/",
      (cmdArgs) => {
        cmdArgs.options({
          ...sharedOptions,
          force: {
            alias: "f",
            type: "boolean",
            default: false,
            describe: "Overwrite existing skill files",
          },
        });
        return cmdArgs;
      },
      async (args: TSFIXME) => {
        await initClaudeCommand(args);
      },
    )
    .command(
      "clickup",
      "ClickUp task management commands",
      function (cmdArgs: TSFIXME) {
        return cmdArgs
          .command(
            "tasks",
            "List my tasks grouped by status",
            function (sub: TSFIXME) {
              sub.options({
                ...sharedOptions,
                team: {
                  type: "string",
                  describe: "ClickUp team/workspace ID",
                },
                status: {
                  type: "array",
                  describe: "Filter by status(es)",
                },
              });
              return sub;
            },
            clickupTasksCommand,
          )
          .command(
            "task <id>",
            "Get task details",
            function (sub: TSFIXME) {
              sub.positional("id", {
                describe: "ClickUp task ID or URL",
                type: "string",
              });
              sub.options(sharedOptions);
              return sub;
            },
            clickupTaskCommand,
          )
          .command(
            "create <list-id>",
            "Create a task (interactive)",
            function (sub: TSFIXME) {
              sub.positional("listId", {
                describe: "ClickUp list ID to create the task in",
                type: "string",
              });
              sub.options(sharedOptions);
              return sub;
            },
            clickupCreateCommand,
          )
          .command(
            "update <task-id>",
            "Update a task (interactive)",
            function (sub: TSFIXME) {
              sub.positional("taskId", {
                describe: "ClickUp task ID or URL",
                type: "string",
              });
              sub.options(sharedOptions);
              return sub;
            },
            clickupUpdateCommand,
          )
          .command(
            "comment <task-id> <msg>",
            "Add comment to task",
            function (sub: TSFIXME) {
              sub.positional("taskId", {
                describe: "ClickUp task ID or URL",
                type: "string",
              });
              sub.positional("msg", {
                describe: "Comment message",
                type: "string",
              });
              sub.options(sharedOptions);
              return sub;
            },
            clickupCommentCommand,
          )
          .command(
            "teams",
            "List workspaces/teams your token belongs to",
            sharedOptions,
            clickupTeamsCommand,
          )
          .command(
            "setup",
            "Configure ClickUp API token and default workspace",
            sharedOptions,
            clickupSetupCommand,
          )
          .command(
            "spaces",
            "List available spaces in a workspace",
            function (sub: TSFIXME) {
              sub.options({
                ...sharedOptions,
                team: {
                  type: "string",
                  describe: "ClickUp team/workspace ID",
                },
              });
              return sub;
            },
            clickupSpacesCommand,
          )
          .command(
            "lists <space-or-folder>",
            "List available lists in a folder or space",
            function (sub: TSFIXME) {
              sub.positional("spaceOrFolder", {
                describe: "Space ID or folder ID",
                type: "string",
              });
              sub.options(sharedOptions);
              return sub;
            },
            clickupListsCommand,
          )
          .demandCommand(1, "Please specify a clickup subcommand");
      },
      function () {
        /* subcommands handle execution */
      },
    )
    .command(
      "migrate",
      "Migrate a project from Sincronia to Dovetail (renames sinc.* artifacts, updates package.json deps and scripts)",
      {
        ...sharedOptions,
        apply: {
          type: "boolean",
          default: false,
          describe: "Actually perform the migration. Without this flag, only the plan is printed.",
        },
      },
      migrateCommand,
    )
    .command(
      "task",
      "Manage the active ClickUp task for update set routing",
      function (cmdArgs: TSFIXME) {
        return cmdArgs
          .command(
            "clear",
            "Clear the active task (removes .dove-active-task.json)",
            sharedOptions,
            taskClearCommand,
          )
          .demandCommand(1, "Please specify a task subcommand (e.g., clear)");
      },
      function () {
        /* subcommands handle execution */
      },
    )
    .command(
      ["knowledge-diff"],
      "Report Dovetail releases this repo has not documented yet (stages pending events for /dovetail-features-sync)",
      function (cmdArgs: TSFIXME) {
        cmdArgs.options({
          ...sharedOptions,
          manifest: {
            type: "string",
            describe: "Path to the Dovetail release manifest (defaults to the bundled one)",
          },
          config: {
            type: "string",
            describe: "Path to the consumer knowledge-sync config.json",
          },
          ledger: {
            type: "string",
            describe: "Path to the documented-state ledger.json",
          },
          out: {
            type: "string",
            describe: "Directory to write pending release-event files",
          },
          json: {
            type: "boolean",
            default: false,
            describe: "Print the diff as JSON instead of writing pending files",
          },
        });
        return cmdArgs;
      },
      async function (args: TSFIXME) {
        await knowledgeDiffCommand(
          args as Sinc.SharedCmdArgs & {
            manifest?: string;
            config?: string;
            ledger?: string;
            out?: string;
            json?: boolean;
          },
        );
      },
    )
    .help().argv;
}
