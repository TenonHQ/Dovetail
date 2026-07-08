import {
  createClickUpApi,
  parseClickUpIdentifier,
  formatForClaude,
  formatTaskDetail,
  formatTaskSummary,
} from "@tenonhq/dovetail-clickup";
import type { ClickUpApi, ClickUpTeam } from "@tenonhq/dovetail-clickup";
import inquirer from "inquirer";
import chalk from "chalk";
import { logger } from "./Logger";
import { setLogLevel } from "./commands";
import { writeEnvVar } from "./FileUtils";

// --- Token & API Helpers ---

function getClickUpToken(): string {
  var token = process.env.CLICKUP_API_TOKEN;
  if (!token || token === "") {
    throw new Error(
      "CLICKUP_API_TOKEN not set. Run 'dove clickup setup' or add CLICKUP_API_TOKEN to your .env file.",
    );
  }
  return token;
}

function getApi(): ClickUpApi {
  return createClickUpApi({ token: getClickUpToken() });
}

/**
 * @description Resolves the team ID automatically. Uses --team flag if provided,
 * otherwise calls getTeams() and auto-selects if there's only one.
 * Only prompts interactively when the user belongs to multiple teams.
 */
async function resolveTeamId(api: ClickUpApi, args: any): Promise<string> {
  // Explicit --team flag takes priority
  if (args.team) {
    return args.team;
  }

  var teams = await api.getTeams();
  if (teams.length === 0) {
    throw new Error("No ClickUp workspaces found. Verify your API token.");
  }
  if (teams.length === 1) {
    return teams[0].id;
  }

  // Multiple teams — must prompt
  var teamChoices = teams.map(function (t: ClickUpTeam) {
    return { name: t.name, value: t.id };
  });
  var teamAnswer = await inquirer.prompt([
    {
      type: "list",
      name: "teamId",
      message: "Select a workspace:",
      choices: teamChoices,
    },
  ]);
  return teamAnswer.teamId;
}

// --- Commands ---

/**
 * @description Lists tasks assigned to the authenticated user, grouped by status.
 */
export async function clickupTasksCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    var api = getApi();
    var teamId = await resolveTeamId(api, args);

    logger.info("Fetching your tasks...");

    var statusFilters: string[] | undefined;
    if (args.status && Array.isArray(args.status)) {
      statusFilters = args.status;
    }

    var result = await api.listMyTasks({
      teamId: teamId,
      statuses: statusFilters,
    });

    if (result.total === 0) {
      logger.info("No tasks assigned to you.");
      return;
    }

    var output = formatForClaude({ tasks: result.tasks });
    console.log(output);
  } catch (e) {
    logger.error("Failed to list tasks");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * @description Gets details for a single ClickUp task.
 */
export async function clickupTaskCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    var api = getApi();
    var parsed = parseClickUpIdentifier(args.id);

    logger.info("Fetching task " + parsed.taskId + "...");
    var task = await api.getTask({ taskId: parsed.taskId });

    var output = formatTaskDetail({ task: task });
    console.log(output);
  } catch (e) {
    logger.error("Failed to get task");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * @description Creates a new task in a ClickUp list (interactive).
 */
export async function clickupCreateCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    var api = getApi();
    var listId = args.listId;

    var answers = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Task name:",
        validate: function (input: string) {
          if (!input || input.trim() === "") return "Task name is required";
          return true;
        },
      },
      {
        type: "input",
        name: "description",
        message: "Description (optional):",
      },
      {
        type: "input",
        name: "status",
        message: "Status (optional, e.g., 'to do'):",
      },
      {
        type: "list",
        name: "priority",
        message: "Priority:",
        choices: [
          { name: "None", value: undefined },
          { name: "Urgent", value: 1 },
          { name: "High", value: 2 },
          { name: "Normal", value: 3 },
          { name: "Low", value: 4 },
        ],
      },
    ]);

    logger.info("Creating task...");

    var task = await api.createTask({
      listId: listId,
      name: answers.name,
      description: answers.description || undefined,
      status: answers.status || undefined,
      priority: answers.priority,
    });

    logger.success(chalk.green("✓ Task created: " + task.name));
    logger.info("  ID: " + task.id);
    logger.info("  URL: " + task.url);
  } catch (e) {
    logger.error("Failed to create task");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * @description Updates an existing ClickUp task (interactive).
 */
export async function clickupUpdateCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    var api = getApi();
    var parsed = parseClickUpIdentifier(args.taskId);

    logger.info("Fetching current task state...");
    var task = await api.getTask({ taskId: parsed.taskId });

    var currentStatus =
      task.status && task.status.status ? task.status.status : "";

    var answers = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Name:",
        default: task.name,
      },
      {
        type: "input",
        name: "status",
        message: "Status:",
        default: currentStatus,
      },
      {
        type: "list",
        name: "priority",
        message: "Priority:",
        choices: [
          { name: "No change", value: undefined },
          { name: "Urgent", value: 1 },
          { name: "High", value: 2 },
          { name: "Normal", value: 3 },
          { name: "Low", value: 4 },
          { name: "None", value: 0 },
        ],
      },
    ]);

    var updates: Record<string, any> = { taskId: parsed.taskId };
    if (answers.name !== task.name) {
      updates.name = answers.name;
    }
    if (answers.status !== currentStatus) {
      updates.status = answers.status;
    }
    if (answers.priority !== undefined) {
      updates.priority = answers.priority;
    }

    // Check if anything changed
    if (Object.keys(updates).length <= 1) {
      logger.info("No changes made.");
      return;
    }

    logger.info("Updating task...");
    var updated = await api.updateTask(updates as any);

    logger.success(chalk.green("✓ Task updated: " + updated.name));
  } catch (e) {
    logger.error("Failed to update task");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * @description Adds a comment to a ClickUp task.
 */
export async function clickupCommentCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    var api = getApi();
    var parsed = parseClickUpIdentifier(args.taskId);
    var msg: string = args.msg;

    if (!msg || msg.trim() === "") {
      throw new Error("Comment message is required.");
    }

    logger.info("Adding comment to task " + parsed.taskId + "...");
    await api.addComment({ taskId: parsed.taskId, commentText: msg });

    logger.success(chalk.green("✓ Comment added"));
  } catch (e) {
    logger.error("Failed to add comment");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * @description Interactive setup wizard for ClickUp API token and team configuration.
 */
export async function clickupSetupCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    logger.info(chalk.bold("\nClickUp Setup"));
    logger.info("─".repeat(40));
    logger.info("");
    logger.info("To get your ClickUp API token:");
    logger.info("  1. Go to ClickUp → Settings (bottom-left) → Apps");
    logger.info('  2. Under "API Token", click Generate');
    logger.info("  3. Copy the token and paste it below");
    logger.info("");

    var answers = await inquirer.prompt([
      {
        type: "password",
        name: "token",
        message: "ClickUp API Token:",
        mask: "*",
        validate: function (input: string) {
          if (!input || input.trim() === "") return "API token is required";
          return true;
        },
      },
    ]);

    var token = answers.token.trim();

    // Validate the token by fetching teams
    logger.info("Validating token...");
    var api = createClickUpApi({ token: token });

    var teams = await api.getTeams();
    if (teams.length === 0) {
      throw new Error(
        "Token is valid but no workspaces found. Check your ClickUp permissions.",
      );
    }

    logger.success(chalk.green("✓ Token valid"));

    // Show discovered workspaces
    for (var i = 0; i < teams.length; i++) {
      var memberCount = teams[i].members ? teams[i].members.length : 0;
      logger.info(
        "  Workspace: " + teams[i].name + " (" + memberCount + " members)",
      );
    }

    // Write token to .env file
    writeEnvVar({ key: "CLICKUP_API_TOKEN", value: token });

    logger.info("");
    logger.success(chalk.green("✓ ClickUp configured! Token saved to .env"));
    logger.info("");
    logger.info("You can now use:");
    logger.info("  dove clickup tasks        — List your tasks");
    logger.info("  dove clickup task <id>     — Get task details");
    logger.info(
      "  dove createUpdateSet -cu <task-id> — Create update set from task",
    );
  } catch (e) {
    logger.error("ClickUp setup failed");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * @description Lists all ClickUp workspaces/teams the token has access to.
 */
export async function clickupTeamsCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    var api = getApi();

    logger.info("Fetching teams...");
    var teams = await api.getTeams();

    if (teams.length === 0) {
      logger.info("No workspaces found for this token.");
      return;
    }

    logger.info(chalk.bold("\nWorkspaces / Teams:"));
    logger.info("─".repeat(40));

    for (var i = 0; i < teams.length; i++) {
      var team = teams[i];
      var memberCount = team.members ? team.members.length : 0;

      console.log(
        "  " +
          team.name +
          " — ID: " +
          team.id +
          " (" +
          memberCount +
          " members)",
      );
    }
    console.log("");
  } catch (e) {
    logger.error("Failed to list teams");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * @description Lists available ClickUp spaces in a workspace.
 */
export async function clickupSpacesCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    var api = getApi();
    var teamId = await resolveTeamId(api, args);

    logger.info("Fetching spaces...");
    var spaces = await api.getSpaces({ teamId: teamId });

    if (spaces.length === 0) {
      logger.info("No spaces found in this workspace.");
      return;
    }

    logger.info(chalk.bold("\nSpaces:"));
    logger.info("─".repeat(40));

    for (var i = 0; i < spaces.length; i++) {
      var space = spaces[i];
      var visibility = space.private ? "(private)" : "(public)";
      console.log("  " + space.name + " — ID: " + space.id + " " + visibility);
    }
    console.log("");
  } catch (e) {
    logger.error("Failed to list spaces");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * @description Lists available ClickUp lists in a folder or folderless lists in a space.
 */
export async function clickupListsCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    var api = getApi();
    var id = args.spaceOrFolder;

    // Try as folder first, fall back to space
    logger.info("Fetching lists...");

    var lists;
    try {
      lists = await api.getLists({ folderId: id });
    } catch (folderErr) {
      // If folder fails, try getting folders from a space
      logger.debug("Not a folder ID, trying as space...");
      var folders = await api.getFolders({ spaceId: id });

      if (folders.length === 0) {
        logger.info("No folders or lists found for ID: " + id);
        return;
      }

      logger.info(chalk.bold("\nFolders & Lists:"));
      logger.info("─".repeat(50));

      for (var f = 0; f < folders.length; f++) {
        var folder = folders[f];
        console.log("\n  📁 " + folder.name + " (ID: " + folder.id + ")");

        if (folder.lists && folder.lists.length > 0) {
          for (var l = 0; l < folder.lists.length; l++) {
            var fList = folder.lists[l];
            var countLabel =
              fList.task_count !== null
                ? " (" + fList.task_count + " tasks)"
                : "";
            console.log(
              "     " + fList.name + " — ID: " + fList.id + countLabel,
            );
          }
        }
      }
      console.log("");
      return;
    }

    if (lists.length === 0) {
      logger.info("No lists found.");
      return;
    }

    logger.info(chalk.bold("\nLists:"));
    logger.info("─".repeat(40));

    for (var i = 0; i < lists.length; i++) {
      var list = lists[i];
      var taskCount =
        list.task_count !== null ? " (" + list.task_count + " tasks)" : "";
      console.log("  " + list.name + " — ID: " + list.id + taskCount);
    }
    console.log("");
  } catch (e) {
    logger.error("Failed to list");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

// --- Claude CLI Refiner ---

/**
 * @description Generates a refined update set name using Claude CLI, with fallback.
 * @param params - Object with taskName, taskId, and taskDescription.
 * @returns The refined or convention-based update set name.
 */
export function refineUpdateSetName(params: {
  taskName: string;
  taskId: string;
  taskDescription: string;
}): string {
  var execSync = require("child_process").execSync;

  // Sanitize inputs for shell safety
  var safeName = params.taskName.replace(/['"\\]/g, "");
  var safeDesc = params.taskDescription
    .replace(/['"\\]/g, "")
    .substring(0, 200);

  try {
    var prompt =
      "Generate a concise ServiceNow update set name (under 80 chars) for this ClickUp task. " +
      "The name should be descriptive and professional. " +
      "Task: " +
      safeName +
      ". " +
      "Description: " +
      safeDesc +
      ". " +
      "Return ONLY the update set name, nothing else.";

    var result = execSync(
      'claude -p "' + prompt.replace(/"/g, '\\"') + '" --output-format text',
      { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] },
    );

    var refined = result.trim();
    if (refined && refined.length > 0 && refined.length <= 100) {
      return refined;
    }
  } catch (e) {
    // Claude CLI not available or failed — fall back to convention
  }

  // Fallback: clean up the task name for use as an update set name
  return params.taskName
    .replace(/[^a-zA-Z0-9\s\-_]/g, "")
    .trim()
    .substring(0, 80);
}
