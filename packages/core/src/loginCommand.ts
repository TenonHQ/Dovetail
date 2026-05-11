import { setLogLevel } from "./commands";
import { runLogin } from "./initSystem/orchestrator";

/**
 * @description Command handler for `dove login`.
 * Authenticates with ServiceNow and other integrations, saves credentials to .env.
 */
export async function loginCommand(args: any): Promise<void> {
  setLogLevel(args);

  await runLogin({
    logLevel: args.logLevel,
    pluginName: args.plugin || undefined,
    all: args.all || false,
    instance: args.instance || undefined,
    user: args.user || undefined,
    password: args.password || undefined,
  });
}
