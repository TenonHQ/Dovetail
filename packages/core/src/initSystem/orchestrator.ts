import { Sinc } from "@tenonhq/dovetail-types";
import inquirer from "inquirer";
import chalk from "chalk";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { logger } from "../Logger";
import { writeEnvVars } from "../FileUtils";
import { discoverPlugins } from "./discovery";
import { corePlugin, validateCoreLogin } from "./corePlugin";

// ============================================================================
// Init Context
// ============================================================================

/**
 * @description Builds an InitContext from the current environment.
 * Reads existing .env if present. Pulls process.env fallbacks only for
 * env keys declared by the provided plugins (no hardcoded allowlist).
 */
function buildInitContext(plugins: Sinc.InitPlugin[]): Sinc.InitContext {
  const rootDir = process.cwd();
  const envPath = path.resolve(rootDir, ".env");
  const env: Record<string, string> = {};

  // Load existing .env values
  try {
    const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
    Object.assign(env, parsed);
  } catch (e) {
    // No .env yet — starting fresh
  }

  // Pull from process.env for keys declared by plugins but missing from .env
  const pluginEnvKeys = plugins.flatMap(p => (p.login || []).map(h => h.envKey));
  pluginEnvKeys.forEach(key => {
    if (process.env[key] && !env[key]) {
      env[key] = process.env[key] as string;
    }
  });

  let hasConfig = false;
  try {
    fs.accessSync(path.join(rootDir, "dove.config.js"), fs.constants.F_OK);
    hasConfig = true;
  } catch (e) {
    try {
      fs.accessSync(path.join(rootDir, "sinc.config.js"), fs.constants.F_OK);
      hasConfig = true;
    } catch (_e) {
      // No config yet
    }
  }

  return { env, answers: {}, rootDir, hasConfig, inquirer, chalk };
}

// ============================================================================
// Plugin Selection
// ============================================================================

async function promptPluginSelection(externalPlugins: Sinc.InitPlugin[]): Promise<Sinc.InitPlugin[]> {
  if (externalPlugins.length === 0) {
    return [corePlugin];
  }

  const choices = externalPlugins.map(plugin => ({
    name: plugin.displayName + " — " + plugin.description,
    value: plugin.name,
    checked: false,
  }));

  const answer = await inquirer.prompt([{
    type: "checkbox",
    name: "plugins",
    message: "Which integrations would you like to configure?",
    choices,
  }]);

  const selectedNames = new Set<string>(answer.plugins);
  const selected = externalPlugins.filter(p => selectedNames.has(p.name));
  return [corePlugin, ...selected];
}

// ============================================================================
// Phase Runners
// ============================================================================

interface InquirerPromptConfig {
  type: string;
  name: string;
  message: string;
  mask?: string;
  default?: string;
  validate?: (input: string) => boolean | string;
}

async function collectLoginHooks(hooks: Sinc.InitLoginHook[], context: Sinc.InitContext): Promise<void> {
  for (const hook of hooks) {
    const existingValue = context.env[hook.envKey] || "";

    // Show instructions if provided
    if (hook.instructions && hook.instructions.length > 0) {
      logger.info("");
      hook.instructions.forEach(line => logger.info(line));
      logger.info("");
    }

    // Build the prompt
    const promptConfig: InquirerPromptConfig = {
      type: hook.prompt.type,
      name: "value",
      message: hook.prompt.message,
    };

    if (hook.prompt.mask) {
      promptConfig.mask = hook.prompt.mask;
    }

    // Show existing value as default for non-password fields
    if (existingValue && hook.prompt.type !== "password") {
      promptConfig.default = existingValue;
    }

    // Add basic validation for required fields
    if (hook.required !== false) {
      promptConfig.validate = (input: string) => {
        if (!input || input.trim() === "") return "This field is required";
        return true;
      };
    }

    const answer = await inquirer.prompt([promptConfig]);
    context.env[hook.envKey] = answer.value.trim();
  }
}

async function runLoginPhase(plugin: Sinc.InitPlugin, context: Sinc.InitContext): Promise<void> {
  const hooks = plugin.login;
  if (!hooks || hooks.length === 0) return;

  // Core plugin: retry loop with specific error messages
  if (plugin.name === "core") {
    // If .env already has all required credentials, offer to skip login
    const hasAllCreds = context.env.SN_INSTANCE && context.env.SN_USER && context.env.SN_PASSWORD;

    if (hasAllCreds) {
      logger.info("Found existing credentials:");
      logger.info("  Instance: " + context.env.SN_INSTANCE);
      logger.info("  User:     " + context.env.SN_USER);
      logger.info("");

      const useExisting = await inquirer.prompt([{
        type: "confirm",
        name: "confirmed",
        message: "Use these credentials?",
        default: true,
      }]);

      if (useExisting.confirmed) {
        logger.info("Validating credentials...");
        const result = await validateCoreLogin(context);

        if (result === true) {
          logger.success(chalk.green("✓ Connected to " + context.env.SN_INSTANCE));
          return;
        }

        logger.error(chalk.red("✗ " + result));
        logger.info("Please re-enter your credentials.");
        context.env.SN_PASSWORD = "";
      }
    }

    while (true) {
      await collectLoginHooks(hooks, context);

      // Run per-hook validation
      let hookFailed = false;
      for (const hook of hooks) {
        if (hook.validate) {
          const result = await hook.validate(context.env[hook.envKey], context);
          if (result !== true) {
            logger.error(chalk.red("✗ " + result));
            hookFailed = true;
            break;
          }
        }
      }

      if (hookFailed) {
        const retry = await inquirer.prompt([{
          type: "confirm",
          name: "again",
          message: "Try again?",
          default: true,
        }]);
        if (!retry.again) {
          throw new Error("Login cancelled");
        }
        context.env.SN_PASSWORD = "";
        continue;
      }

      logger.info("Validating credentials...");
      const coreResult = await validateCoreLogin(context);

      if (coreResult === true) {
        logger.success(chalk.green("✓ Connected to " + context.env.SN_INSTANCE));
        return;
      }

      logger.error(chalk.red("✗ " + coreResult));
      logger.info("");

      const retry = await inquirer.prompt([{
        type: "confirm",
        name: "again",
        message: "Try again?",
        default: true,
      }]);

      if (!retry.again) {
        throw new Error("Login cancelled");
      }

      // Clear password so it re-prompts; instance and user show as defaults
      context.env.SN_PASSWORD = "";
    }
  }

  // Non-core plugins: original behavior (no retry loop)
  await collectLoginHooks(hooks, context);

  for (const hook of hooks) {
    if (hook.validate) {
      const result = await hook.validate(context.env[hook.envKey], context);
      if (result !== true) {
        logger.error(chalk.red("✗ " + result));
        throw new Error("Validation failed for " + hook.envKey);
      }
    }
  }
}

async function runConfigPhase(context: Sinc.InitContext): Promise<void> {
  if (context.hasConfig) {
    var answer = await inquirer.prompt([{
      type: "list",
      name: "configAction",
      message: "Existing config (dove.config.js or legacy sinc.config.js) found:",
      choices: [
        { name: "Use current config", value: "keep" },
        { name: "Replace config (regenerate after scope selection)", value: "replace" },
      ],
    }]);

    context.answers.configAction = answer.configAction;

    if (answer.configAction === "keep") {
      logger.info(chalk.green("  ✓ Using existing config"));
    }
    return;
  }

  // No config — will be generated in initialize phase after scopes are selected
  context.answers.configAction = "generate";
}

async function runConfigurePhase(plugin: Sinc.InitPlugin, context: Sinc.InitContext): Promise<void> {
  const hooks = plugin.configure;
  if (!hooks || hooks.length === 0) return;

  for (const hook of hooks) {
    logger.debug("Running configure hook: " + hook.label);
    const result = await hook.run(context);
    if (result !== null && result !== undefined) {
      context.answers[hook.key] = result;
    }
  }
}

/**
 * @description Saves env vars declared by plugins to .env (merge-style).
 * Only writes keys that plugins explicitly declared via login hooks or
 * configure hooks — never writes transient context values.
 */
function saveEnvVars(context: Sinc.InitContext, plugins: Sinc.InitPlugin[]): void {
  const pluginKeys = new Set<string>();

  plugins.forEach(plugin => {
    (plugin.login || []).forEach(hook => pluginKeys.add(hook.envKey));
    (plugin.configure || []).forEach(hook => {
      if (context.env[hook.key]) pluginKeys.add(hook.key);
    });
  });

  const vars = Array.from(pluginKeys)
    .filter(key => context.env[key])
    .map(key => ({ key, value: context.env[key] }));

  if (vars.length > 0) {
    writeEnvVars({ vars });
    // Also set on process.env for immediate use
    vars.forEach(({ key, value }) => { process.env[key] = value; });
    logger.success(chalk.green("✓ Saved to .env (existing values preserved)"));
  }
}

// ============================================================================
// Public API
// ============================================================================

export interface RunInitOptions {
  logLevel?: string;
}

export interface RunLoginOptions {
  logLevel?: string;
  pluginName?: string;
  all?: boolean;
  instance?: string;
  user?: string;
  password?: string;
}

export async function runInit(options?: RunInitOptions): Promise<void> {
  let failed = false;

  try {
    logger.info("");
    logger.info(chalk.bold("  Dovetail Setup"));
    logger.info("  " + "═".repeat(40));
    logger.info("");

    // 1. Discover plugins
    const externalPlugins = discoverPlugins();

    if (externalPlugins.length > 0) {
      logger.info("  Detected packages:");
      logger.info("    ● dovetail-core (" + chalk.cyan("ServiceNow") + ")");
      externalPlugins.forEach(p => {
        logger.info("    ● dovetail-" + p.name + " (" + chalk.cyan(p.displayName) + ")");
      });
      logger.info("");
    }

    // 2. Select plugins
    const selectedPlugins = await promptPluginSelection(externalPlugins);

    // 3. Build context (passes plugins so env fallback uses their declared keys)
    const context = buildInitContext(selectedPlugins);

    // 4. Login phase
    logger.info("");
    logger.info(chalk.bold("  ── Login " + "─".repeat(30)));
    logger.info("");

    for (const plugin of selectedPlugins) {
      await runLoginPhase(plugin, context);
    }

    // 5. Save env vars after login
    saveEnvVars(context, selectedPlugins);

    // 5.5 Config phase
    logger.info("");
    logger.info(chalk.bold("  ── Config " + "─".repeat(29)));
    logger.info("");

    await runConfigPhase(context);

    // 6. Configure phase
    logger.info("");
    logger.info(chalk.bold("  ── Configure " + "─".repeat(26)));
    logger.info("");

    for (const plugin of selectedPlugins) {
      await runConfigurePhase(plugin, context);
    }

    // 7. Initialize phase
    logger.info("");
    logger.info(chalk.bold("  ── Initialize " + "─".repeat(25)));
    logger.info("");

    for (const plugin of selectedPlugins) {
      if (plugin.initialize) {
        try {
          await plugin.initialize(context);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error("Initialization failed for " + plugin.displayName + ": " + msg);
          failed = true;
        }
      }
    }

    // 8. Summary
    logger.info("");
    logger.info("  " + "═".repeat(40));
    if (failed) {
      logger.warn("  Setup completed with errors. Review the output above.");
    } else {
      logger.success(chalk.green("  Setup complete!") + " Run " + chalk.cyan("dove watch") + " to start.");
    }
    logger.info("");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Init failed: " + message);
  }
}

export async function runLogin(options?: RunLoginOptions): Promise<void> {
  try {
    const opts = options || {};

    // Determine which plugins to log in to
    let pluginsToLogin: Sinc.InitPlugin[];
    const coreAliases = new Set(["core", "servicenow", "sn"]);

    if (opts.pluginName) {
      if (coreAliases.has(opts.pluginName)) {
        pluginsToLogin = [corePlugin];
      } else {
        const externalPlugins = discoverPlugins();
        const match = externalPlugins.find(p => p.name === opts.pluginName);
        if (!match) {
          logger.error("Plugin '" + opts.pluginName + "' not found. Available plugins:");
          externalPlugins.forEach(p => logger.info("  - " + p.name + " (" + p.displayName + ")"));
          return;
        }
        pluginsToLogin = [match];
      }
    } else if (opts.all) {
      pluginsToLogin = [corePlugin, ...discoverPlugins()];
    } else {
      pluginsToLogin = [corePlugin];
    }

    // Build context with discovered plugins for env key resolution
    const context = buildInitContext(pluginsToLogin);

    // Apply CLI flag overrides for non-interactive mode
    if (opts.instance) context.env.SN_INSTANCE = opts.instance;
    if (opts.user) context.env.SN_USER = opts.user;
    if (opts.password) context.env.SN_PASSWORD = opts.password;

    // Dynamic header based on which plugins are being logged in
    const pluginNames = pluginsToLogin.map(p => p.displayName).join(" + ");
    logger.info("");
    logger.info(chalk.bold("  " + pluginNames + " Login"));
    logger.info("  " + "─".repeat(40));
    logger.info("");

    // Check if all core credentials provided via flags (non-interactive mode)
    const hasAllCoreFlags = opts.instance && opts.user && opts.password;
    if (hasAllCoreFlags && pluginsToLogin.length === 1 && pluginsToLogin[0].name === "core") {
      logger.info("Validating credentials...");
      const result = await validateCoreLogin(context);
      if (result !== true) {
        logger.error(chalk.red("✗ " + result));
        return;
      }
      logger.success(chalk.green("✓ Connected to " + context.env.SN_INSTANCE));
    } else {
      for (const plugin of pluginsToLogin) {
        await runLoginPhase(plugin, context);
      }
    }

    // Save env vars
    saveEnvVars(context, pluginsToLogin);

    logger.info("");
    logger.info("You can now use:");
    logger.info("  dove init              — Initialize a new project");
    logger.info("  dove watch             — Watch for changes");
    logger.info("  dove status            — Check instance connection");
    logger.info("");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Login failed: " + message);
  }
}
