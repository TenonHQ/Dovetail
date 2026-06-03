import { Sinc } from "@tenonhq/dovetail-types";
import inquirer from "inquirer";
import { defaultClient, unwrapSNResponse, unwrapTableAPIFirstItem } from "./snClient";
import { logger } from "./Logger";
import { setLogLevel } from "./commands";
import chalk from "chalk";
import {
  createClickUpApi,
  parseClickUpIdentifier,
  formatTaskSummary,
} from "@tenonhq/dovetail-clickup";
import { refineUpdateSetName } from "./clickupCommands";

interface UpdateSetDetails {
  sys_id: string;
  name: string;
  description?: string;
  state: string;
  application?: {
    value: string;
    display_value: string;
  };
  sys_created_on: string;
  sys_created_by: string;
}

interface UpdateSetListResponse {
  sys_id: string;
  name: string;
  description: string;
  state: string;
  application: {
    value: string;
    display_value: string;
  };
  sys_created_on: string;
  sys_created_by: string;
}

/**
 * Shows the current scope
 */
export async function showCurrentScopeCommand(args: any): Promise<void> {
  setLogLevel(args);
  
  try {
    const client = defaultClient();
    const scopeObj = await unwrapSNResponse(client.getCurrentScope());
    
    if (scopeObj && scopeObj.scope) {
      logger.info(chalk.bold("\nCurrent Scope:"));
      logger.info("─".repeat(40));
      logger.info(chalk.green(`► ${(scopeObj as any).displayName || scopeObj.scope}`));
      logger.info(`  Scope ID: ${scopeObj.scope}`);
      logger.info(`  Sys ID: ${scopeObj.sys_id}`);
      
      // Also show current update set for this scope
      const updateSet = await getCurrentUpdateSetDetails();
      if (updateSet) {
        logger.info(`  Update Set: ${updateSet.name}`);
      }
    } else {
      logger.warn("Unable to retrieve current scope information");
    }
  } catch (e) {
    logger.error("Failed to get current scope");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * Changes the current scope
 */
export async function changeScopeCommand(args: any): Promise<void> {
  setLogLevel(args);
  
  try {
    const client = defaultClient();
    
    // Get scope from args or prompt
    let scope = args.scope;
    if (!scope) {
      const inquirer = (await import("inquirer")).default;
      const answers = await inquirer.prompt([{
        type: "input",
        name: "scope",
        message: "Enter scope to switch to (e.g., x_cadso_core):",
        validate: (input: string) => {
          if (!input || input.trim() === "") {
            return "Scope is required";
          }
          return true;
        }
      }]);
      scope = answers.scope;
    }
    
    logger.info(`Switching to scope: ${scope}`);
    
    // Call the changeScope API
    const response = await client.changeScope(scope);
    let result = await response.data;
    
    // Handle wrapped response
    if (result && (result as any).result) {
      result = (result as any).result;
    }
    
    if (result && result.message === 'Success') {
      logger.success(chalk.green(`✓ Successfully switched to scope: ${scope}`));
      
      // Try to get and show the current update set for this scope
      const updateSet = await getCurrentUpdateSetDetails(scope);
      if (updateSet) {
        logger.info(`Current update set: ${updateSet.name}`);
      }
    } else if (result && result.error) {
      throw new Error(`Failed to switch scope: ${result.error}`);
    } else {
      throw new Error("Failed to switch scope - unexpected response");
    }
  } catch (e) {
    logger.error("Failed to change scope");
    if (e instanceof Error) {
      logger.error(e.message);
      if ((e as any).response) {
        logger.error(`Response status: ${(e as any).response.status}`);
        logger.error(`Response data: ${JSON.stringify((e as any).response.data)}`);
      }
    }
    throw e;
  }
}

/**
 * Shows the current active update set
 */
export async function showCurrentUpdateSetCommand(args: any): Promise<void> {
  setLogLevel(args);
  
  try {
    const client = defaultClient();
    const response = await client.getCurrentUpdateSet(args.scope);
    let result = await response.data;
    
    // Handle wrapped response
    if (result && (result as any).result) {
      result = (result as any).result;
    }
    
    logger.debug(`API Response: ${JSON.stringify(result)}`);
    
    if (result && result.sysId) {
      logger.info(chalk.bold("\nCurrent Update Set:"));
      logger.info("─".repeat(40));
      logger.info(chalk.green(`► ${result.name || 'Unknown'}`));
      logger.info(`  ID: ${result.sysId}`);
      if (args.scope) {
        logger.info(`  Scope: ${args.scope}`);
      }
    } else if (result && result.error) {
      logger.warn(`Error from API: ${result.error}`);
    } else {
      logger.warn("No update set is currently active or unable to retrieve update set information");
    }
  } catch (e) {
    logger.error("Failed to get current update set");
    if (e instanceof Error) {
      logger.error(e.message);
      if ((e as any).response) {
        logger.error(`Response status: ${(e as any).response.status}`);
        logger.error(`Response data: ${JSON.stringify((e as any).response.data)}`);
      }
    }
    throw e;
  }
}

/**
 * Creates a new update set with the given name and switches to it
 */
export async function createUpdateSetCommand(args: any): Promise<void> {
  setLogLevel(args);

  try {
    const client = defaultClient();

    // If --clickup is provided, fetch task data and generate name/description
    if (args.clickup && !args.name) {
      var clickupResult = await resolveClickUpTaskForUpdateSet(args.clickup);
      args.name = clickupResult.name;
      if (!args.description) {
        args.description = clickupResult.description;
      }
      args._clickupTaskId = clickupResult.taskId;
    }

    // Get update set details from user
    const { name, description, scope } = await promptForUpdateSetDetails(args);
    
    let scopeSysId: string | undefined;
    
    if (scope) {
      // Get scope sys_id if scope name provided
      const scopeResult = await unwrapSNResponse(client.getScopeId(scope));
      if (scopeResult.length === 0) {
        throw new Error(`Scope "${scope}" not found`);
      }
      scopeSysId = scopeResult[0].sys_id;
      
      // Switch to the target scope first
      logger.info(`Switching to scope: ${scope}`);
      await switchToScope(scopeSysId, scope);
    }
    
    // Create the update set in the correct scope. Pass scope name so the
    // server-side createRecord runs inside the target scope; see snClient.ts.
    logger.info(`Creating update set: ${name}`);
    const createResponse = client.createUpdateSet(name, scopeSysId, description, scope);
    const createResult = await unwrapSNResponse(createResponse);
    const updateSetSysId = (createResult as any).sys_id;
    
    // Switch to the new update set
    logger.info(`Activating update set: ${name}`);
    try {
      await switchToUpdateSet(updateSetSysId, name, scope);
      logger.info(chalk.green(`✓ Update set "${name}" created and activated`));
    } catch (switchError) {
      logger.warn(`Update set "${name}" created but could not be activated automatically`);
      logger.info(`You can manually switch to it using: npx dove switchUpdateSet --name "${name}"`);
      if (switchError instanceof Error) {
        logger.warn(`Switch error: ${switchError.message}`);
      }
    }
    
    logger.info(`Update Set ID: ${updateSetSysId}`);
    if (scope) {
      logger.info(`Scope: ${scope}`);
    }

    // If created from a ClickUp task, offer to post a comment back
    if (args._clickupTaskId) {
      try {
        var token = process.env.CLICKUP_API_TOKEN;
        if (token) {
          var commentAnswer = await inquirer.prompt([{
            type: "confirm",
            name: "postComment",
            message: "Post a comment to the ClickUp task linking this update set?",
            default: true,
          }]);
          if (commentAnswer.postComment) {
            var clickupApi = createClickUpApi({ token: token });
            await clickupApi.addComment({
              taskId: args._clickupTaskId,
              commentText: "ServiceNow Update Set created: " + name + " (ID: " + updateSetSysId + ")",
            });
            logger.success(chalk.green("✓ Comment posted to ClickUp task"));
          }
        }
      } catch (commentErr) {
        logger.warn("Could not post comment to ClickUp task");
        if (commentErr instanceof Error) logger.debug(commentErr.message);
      }
    }

  } catch (e) {
    logger.error("Failed to create update set");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * Switches to an existing update set
 */
export async function switchUpdateSetCommand(args: any): Promise<void> {
  setLogLevel(args);
  
  try {
    const client = defaultClient();
    
    // Get update set to switch to
    const targetUpdateSet = await selectUpdateSet(args.name, args.scope);
    
    if (!targetUpdateSet) {
      throw new Error("No update set selected");
    }
    
    // Extract the actual values from display_value objects
    const sysId = typeof targetUpdateSet.sys_id === 'object' && targetUpdateSet.sys_id !== null ? (targetUpdateSet as any).sys_id.value : targetUpdateSet.sys_id;
    const name = typeof targetUpdateSet.name === 'object' && targetUpdateSet.name !== null ? (targetUpdateSet as any).name.value : targetUpdateSet.name;
    const applicationName = (targetUpdateSet.application && targetUpdateSet.application.display_value) || (typeof targetUpdateSet.application === 'object' && targetUpdateSet.application !== null ? (targetUpdateSet as any).application.value : targetUpdateSet.application);
    const applicationScope = typeof targetUpdateSet.application === 'object' && targetUpdateSet.application !== null ? (targetUpdateSet as any).application.value : targetUpdateSet.application;
    
    // Switch to the selected update set
    await switchToUpdateSet(sysId, name, args.scope || applicationScope);
    
    logger.info(chalk.green(`✓ Switched to update set: ${name}`));
    logger.info(`Update Set ID: ${sysId}`);
    if (applicationName) {
      logger.info(`Scope: ${applicationName}`);
    }
    
  } catch (e) {
    logger.error("Failed to switch update set");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * Lists all open/in-progress update sets
 */
export async function listUpdateSetsCommand(args: any): Promise<void> {
  setLogLevel(args);
  
  try {
    const client = defaultClient();
    
    // Build query for update sets
    let query = "state=in progress";
    
    if (args.scope) {
      // Get scope sys_id if scope name provided
      const scopeResult = await unwrapSNResponse(client.getScopeId(args.scope));
      if (scopeResult.length === 0) {
        throw new Error(`Scope "${args.scope}" not found`);
      }
      query += `^application=${scopeResult[0].sys_id}`;
    }
    
    // Get list of update sets
    const updateSets = await getUpdateSets(query);
    
    if (updateSets.length === 0) {
      logger.info("No in-progress update sets found");
      return;
    }
    
    // Get current update set
    const currentUpdateSetId = await getCurrentUpdateSetId();
    
    // Display update sets
    logger.info(chalk.bold("\nIn-Progress Update Sets:"));
    logger.info("─".repeat(80));
    
    updateSets.forEach((updateSet: any) => {
      // Handle both plain values and display_value objects
      const sysId = typeof updateSet.sys_id === 'object' && updateSet.sys_id !== null ? updateSet.sys_id.value : updateSet.sys_id;
      const name = typeof updateSet.name === 'object' && updateSet.name !== null ? updateSet.name.value : updateSet.name;
      const description = typeof updateSet.description === 'object' && updateSet.description !== null ? updateSet.description.value : updateSet.description;
      const createdBy = typeof updateSet.sys_created_by === 'object' && updateSet.sys_created_by !== null ? updateSet.sys_created_by.display_value || updateSet.sys_created_by.value : updateSet.sys_created_by;
      const applicationName = (updateSet.application && updateSet.application.display_value) || (typeof updateSet.application === 'object' && updateSet.application !== null ? updateSet.application.value : updateSet.application);
      
      const isCurrent = sysId === currentUpdateSetId;
      const marker = isCurrent ? chalk.green("► ") : "  ";
      const displayName = isCurrent ? chalk.green(name) : name;
      
      console.log(`${marker}${displayName}`);
      
      if (description) {
        console.log(`    Description: ${description}`);
      }
      
      if (applicationName) {
        console.log(`    Scope: ${applicationName}`);
      }
      
      console.log(`    Created: ${formatDate(updateSet.sys_created_on)} by ${createdBy}`);
      console.log(`    ID: ${sysId}`);
      console.log("");
    });
    
    if (currentUpdateSetId) {
      logger.info(chalk.dim("► indicates current active update set"));
    }
    
  } catch (e) {
    logger.error("Failed to list update sets");
    if (e instanceof Error) logger.error(e.message);
    throw e;
  }
}

/**
 * Helper function to prompt for update set details
 */
async function promptForUpdateSetDetails(args: any): Promise<{
  name: string;
  description?: string;
  scope?: string;
}> {
  const questions: any[] = [];
  
  if (!args.name) {
    questions.push({
      type: "input",
      name: "name",
      message: "Update set name:",
      validate: (input: string) => {
        if (!input || input.trim() === "") {
          return "Update set name is required";
        }
        return true;
      }
    });
  }
  
  if (!args.description && !args.skipDescription) {
    questions.push({
      type: "input",
      name: "description",
      message: "Description (optional):"
    });
  }
  
  if (!args.scope && !args.skipScope) {
    questions.push({
      type: "input",
      name: "scope",
      message: "Scope (optional, e.g., x_company_app):"
    });
  }
  
  const answers = questions.length > 0 ? await inquirer.prompt(questions) : {};
  
  return {
    name: args.name || answers.name,
    description: args.description || answers.description,
    scope: args.scope || answers.scope
  };
}

/**
 * Helper function to switch to an update set using the new API endpoint.
 * Verifies the switch was successful by reading back the current update set.
 */
async function switchToUpdateSet(updateSetSysId: string, name?: string, scope?: string): Promise<void> {
  const client = defaultClient();

  logger.debug(`Switching to update set - sysId: ${updateSetSysId}, name: ${name}, scope: ${scope}`);

  // Use the new changeUpdateSet endpoint
  // Can use either sysId or name+scope combination
  const params: any = {};
  if (updateSetSysId) {
    params.sysId = updateSetSysId;
  }
  if (name) {
    params.name = name;
  }
  if (scope) {
    params.scope = scope;
  }

  const response = await client.changeUpdateSet(params);
  let result = await response.data;

  // Handle wrapped response
  if (result && (result as any).result) {
    result = (result as any).result;
  }

  logger.debug(`Change update set response: ${JSON.stringify(result)}`);

  if (result.error) {
    throw new Error(result.error);
  }

  // Check if the message indicates success
  if (result.message && !result.message.includes("Success") && !result.message.includes("changed")) {
    throw new Error(result.message);
  }

  // Verify the switch was successful
  var verified = await verifyActiveUpdateSet(client, updateSetSysId, scope);
  if (!verified) {
    // Retry once
    logger.warn("Update set verification failed, retrying switch...");
    var retryResponse = await client.changeUpdateSet(params);
    var retryResult = await retryResponse.data;
    if (retryResult && (retryResult as any).result) {
      retryResult = (retryResult as any).result;
    }
    if (retryResult.error) {
      throw new Error(retryResult.error);
    }

    var retryVerified = await verifyActiveUpdateSet(client, updateSetSysId, scope);
    if (!retryVerified) {
      var currentName = await getActiveUpdateSetName(client, scope);
      throw new Error(
        "Update set " + (name || updateSetSysId) + " was created but could not be activated. Current update set is " + (currentName || "unknown") + "."
      );
    }
  }
}

/**
 * Verifies the currently active update set matches the expected sys_id.
 */
async function verifyActiveUpdateSet(client: ReturnType<typeof defaultClient>, expectedSysId: string, scope?: string): Promise<boolean> {
  try {
    var response = await client.getCurrentUpdateSet(scope);
    var result = await response.data;
    if (result && (result as any).result) {
      result = (result as any).result;
    }
    if (result && result.sysId === expectedSysId) {
      return true;
    }
    logger.warn("Verification mismatch: expected " + expectedSysId + ", got " + (result && result.sysId ? result.sysId : "null"));
    return false;
  } catch (e) {
    logger.warn("Verification check failed: " + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

/**
 * Gets the name of the currently active update set for error messages.
 */
async function getActiveUpdateSetName(client: ReturnType<typeof defaultClient>, scope?: string): Promise<string | null> {
  try {
    var response = await client.getCurrentUpdateSet(scope);
    var result = await response.data;
    if (result && (result as any).result) {
      result = (result as any).result;
    }
    return (result && result.name) ? result.name : null;
  } catch (e) {
    return null;
  }
}

/**
 * Helper function to switch to a scope
 */
async function switchToScope(scopeSysId: string, scopeName: string): Promise<void> {
  const client = defaultClient();
  
  // Get current user sys_id
  const userSysId = await unwrapTableAPIFirstItem(
    client.getUserSysId(),
    "sys_id"
  );
  
  // Get or create user preference for current app
  try {
    const curAppUserPrefId = await unwrapTableAPIFirstItem(
      client.getCurrentAppUserPrefSysId(userSysId),
      "sys_id"
    );
    
    // Update existing preference
    await client.updateCurrentAppUserPref(scopeSysId, curAppUserPrefId);
  } catch (e) {
    // Create new preference if it doesn't exist
    await client.createCurrentAppUserPref(scopeSysId, userSysId);
  }
  
  logger.info(`Switched to scope: ${scopeName}`);
}

/**
 * Helper function to get update sets based on query
 */
async function getUpdateSets(query: string): Promise<UpdateSetListResponse[]> {
  const client = defaultClient();
  
  const endpoint = "api/now/table/sys_update_set";
  const response = client.client.get<Sinc.SNAPIResponse<UpdateSetListResponse[]>>(endpoint, {
    params: {
      sysparm_query: query,
      sysparm_fields: "sys_id,name,description,state,application,application.name,sys_created_on,sys_created_by",
      sysparm_limit: 100,
      sysparm_display_value: "all"
    }
  });
  
  return unwrapSNResponse(response);
}

/**
 * Helper function to get current update set ID using the new endpoint
 */
async function getCurrentUpdateSetId(scope?: string): Promise<string | null> {
  try {
    const client = defaultClient();
    const response = await client.getCurrentUpdateSet(scope);
    let result = await response.data;
    
    // Handle wrapped response
    if (result && (result as any).result) {
      result = (result as any).result;
    }
    
    if (result && result.sysId) {
      return result.sysId;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Helper function to get current update set details
 */
async function getCurrentUpdateSetDetails(scope?: string): Promise<{ sysId: string; name: string } | null> {
  try {
    const client = defaultClient();
    const response = await client.getCurrentUpdateSet(scope);
    let result = await response.data;
    
    // Handle wrapped response
    if (result && (result as any).result) {
      result = (result as any).result;
    }
    
    if (result && result.sysId) {
      return {
        sysId: result.sysId,
        name: result.name || 'Unknown'
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Helper function to select an update set from a list
 */
async function selectUpdateSet(
  nameFilter?: string,
  scopeFilter?: string
): Promise<UpdateSetListResponse | null> {
  let query = "state=in progress";
  
  if (scopeFilter) {
    const client = defaultClient();
    const scopeResult = await unwrapSNResponse(client.getScopeId(scopeFilter));
    if (scopeResult.length === 0) {
      logger.error(`Scope "${scopeFilter}" not found`);
      return null;
    }
    query += `^application=${scopeResult[0].sys_id}`;
  }
  
  const updateSets = await getUpdateSets(query);
  
  if (updateSets.length === 0) {
    logger.info("No in-progress update sets found");
    return null;
  }
  
  // Filter by name if provided
  let filteredSets = updateSets;
  if (nameFilter) {
    filteredSets = updateSets.filter(us => {
      const name = typeof us.name === 'object' && us.name !== null ? (us as any).name.value : us.name;
      return name.toLowerCase().includes(nameFilter.toLowerCase());
    });
    
    if (filteredSets.length === 0) {
      logger.error(`No update sets found matching "${nameFilter}"`);
      return null;
    }
    
    // If exact match found, use it
    const exactMatch = filteredSets.find(us => {
      const name = typeof us.name === 'object' && us.name !== null ? (us as any).name.value : us.name;
      return name.toLowerCase() === nameFilter.toLowerCase();
    });
    if (exactMatch) {
      return exactMatch;
    }
    
    // If only one match, use it
    if (filteredSets.length === 1) {
      return filteredSets[0];
    }
  }
  
  // Prompt user to select from list
  const choices = filteredSets.map(us => {
    const name = typeof us.name === 'object' && us.name !== null ? (us as any).name.value : us.name;
    const description = typeof us.description === 'object' && us.description !== null ? (us as any).description.value : us.description;
    const applicationName = (us.application && us.application.display_value) || (typeof us.application === 'object' && us.application !== null ? (us as any).application.value : us.application);
    return {
      name: `${name}${applicationName ? ` (${applicationName})` : ""} - ${description || "No description"}`,
      value: us
    };
  });
  
  const { selectedUpdateSet } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedUpdateSet",
      message: "Select an update set:",
      choices,
      pageSize: 15
    }
  ]);
  
  return selectedUpdateSet;
}

/**
 * Helper function to format date
 */
/**
 * Resolves a ClickUp task identifier into an update set name and description.
 * Uses Claude CLI for name refinement with convention-based fallback.
 */
async function resolveClickUpTaskForUpdateSet(
  clickupIdentifier: string
): Promise<{ name: string; description: string; taskId: string }> {
  var token = process.env.CLICKUP_API_TOKEN;
  if (!token || token === "") {
    throw new Error(
      "CLICKUP_API_TOKEN not set. Run 'dove clickup setup' or add it to your .env file."
    );
  }

  var parsed = parseClickUpIdentifier(clickupIdentifier);
  logger.info("Fetching ClickUp task: " + parsed.taskId + "...");

  var api = createClickUpApi({ token: token });
  var task = await api.getTask({ taskId: parsed.taskId });

  logger.success(chalk.green('✓ Found: "' + task.name + '"'));
  logger.info("");

  // Generate update set name via Claude CLI (with fallback)
  logger.info("Generating update set name...");
  var suggestedName = refineUpdateSetName({
    taskName: task.name,
    taskId: task.id,
    taskDescription: task.description || "",
  });
  logger.success(chalk.green('✓ Suggested name: "' + suggestedName + '"'));

  // Generate description from task summary
  var suggestedDescription = formatTaskSummary({ task: task });

  // Let user confirm or edit
  var confirmAnswers = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Update set name:",
      default: suggestedName,
      validate: function (input: string) {
        if (!input || input.trim() === "") return "Name is required";
        return true;
      },
    },
    {
      type: "input",
      name: "description",
      message: "Description:",
      default: suggestedDescription,
    },
  ]);

  return {
    name: confirmAnswers.name,
    description: confirmAnswers.description,
    taskId: parsed.taskId,
  };
}

function formatDate(dateString: any): string {
  try {
    const actualDateString = typeof dateString === 'object' && dateString !== null ? dateString.display_value || dateString.value : dateString;
    const date = new Date(actualDateString);
    if (isNaN(date.getTime())) {
      return actualDateString || "Unknown";
    }
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  } catch (e) {
    return typeof dateString === 'string' ? dateString : "Unknown";
  }
}