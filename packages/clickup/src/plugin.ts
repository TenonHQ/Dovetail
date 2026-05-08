import { createClickUpApi } from "./client";
import type { ClickUpTeam } from "./types";

/**
 * Structural type matching Sinc.InitContext from dovetail-types.
 * Defined locally so this package doesn't need a runtime dependency on dovetail-types.
 */
interface PluginContext {
  env: Record<string, string>;
  answers: Record<string, any>;
  rootDir: string;
  hasConfig: boolean;
  inquirer: { prompt: (questions: any[]) => Promise<any> };
  chalk: { green: (str: string) => string };
}

/**
 * @description ClickUp init plugin for Dovetail.
 * Discovered automatically by dovetail-core when this package is installed.
 * Adds ClickUp API token login and workspace selection to `dove init`.
 */
export const sincPlugin = {
  name: "clickup",
  displayName: "ClickUp",
  description: "Task management and PR linking",

  login: [
    {
      envKey: "CLICKUP_API_TOKEN",
      prompt: {
        type: "password" as const,
        message: "ClickUp API Token:",
        mask: "*",
      },
      instructions: [
        "To get your ClickUp API token:",
        "  1. Go to ClickUp → Settings (bottom-left) → Apps",
        '  2. Under "API Token", click Generate',
        "  3. Copy the token and paste it below",
      ],
      required: true,
      validate: async (value: string, context: PluginContext): Promise<true | string> => {
        const api = createClickUpApi({ token: value });
        try {
          const teams = await api.getTeams();
          if (teams.length === 0) {
            return "Token is valid but no workspaces found. Check your ClickUp permissions.";
          }
          // Stash teams in context for the configure phase
          context.answers._clickup_teams = teams;
          return true;
        } catch (e) {
          return "Invalid ClickUp API token — could not connect.";
        }
      },
    },
  ],

  configure: [
    {
      key: "CLICKUP_TEAM_ID",
      label: "Selecting ClickUp workspace",
      run: async (context: PluginContext): Promise<string | null> => {
        const teams: ClickUpTeam[] = context.answers._clickup_teams;
        if (!teams || teams.length === 0) {
          return null;
        }

        // Auto-select if only one workspace
        if (teams.length === 1) {
          context.env.CLICKUP_TEAM_ID = teams[0].id;
          console.log(context.chalk.green("✓ ClickUp workspace auto-selected: " + teams[0].name));
          return teams[0].id;
        }

        // Multiple workspaces — prompt user to select
        const choices = teams.map((t: ClickUpTeam) => {
          const memberCount = t.members ? t.members.length : 0;
          return {
            name: t.name + " (" + memberCount + " members)",
            value: t.id,
          };
        });

        const answer = await context.inquirer.prompt([{
          type: "list",
          name: "teamId",
          message: "Select a ClickUp workspace:",
          choices,
        }]);

        context.env.CLICKUP_TEAM_ID = answer.teamId;
        return answer.teamId;
      },
    },
  ],
};
