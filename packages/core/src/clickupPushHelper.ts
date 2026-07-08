import {
  createClickUpApi,
  parseClickUpIdentifier,
} from "@tenonhq/dovetail-clickup";
import { refineUpdateSetName } from "./clickupCommands";
import { logger } from "./Logger";
import chalk from "chalk";

/**
 * @description Resolves a ClickUp task identifier into an update set name for the push command.
 * @param clickupIdentifier - A ClickUp task ID or URL.
 * @returns The resolved update set name.
 */
export async function resolveClickUpForPush(
  clickupIdentifier: string,
): Promise<string> {
  var token = process.env.CLICKUP_API_TOKEN;
  if (!token || token === "") {
    throw new Error(
      "CLICKUP_API_TOKEN not set. Run 'dove clickup setup' or add it to your .env file.",
    );
  }

  var parsed = parseClickUpIdentifier(clickupIdentifier);
  logger.info("Fetching ClickUp task: " + parsed.taskId + "...");

  var api = createClickUpApi({ token: token });
  var task = await api.getTask({ taskId: parsed.taskId });

  logger.success(chalk.green('✓ Found: "' + task.name + '"'));

  var name = refineUpdateSetName({
    taskName: task.name,
    taskId: task.id,
    taskDescription: task.description || "",
  });

  logger.success(chalk.green('✓ Update set name: "' + name + '"'));
  return name;
}
