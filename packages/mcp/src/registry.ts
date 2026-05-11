/**
 * Tool registration glue. Exports TOOL_NAMES (the canonical 12-tuple) and
 * registerAllTools(), which wires every handler with telemetry + JSON
 * serialization for MCP transport.
 *
 * Dependencies are passed in by the caller — server.ts builds them from
 * loadConfig(), tests inject mocks. This split keeps registry.ts pure of
 * env access.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { withTelemetry } from "./telemetry";
import { mapToolError } from "./errors";

import {
  clickupListTasksSchema,
  clickupGetTaskSchema,
  clickupSearchTasksSchema,
  clickupGetTeamSyncSchema
} from "./schemas/clickup";
import {
  gmailGetUnreadSchema,
  gmailGetStarredSchema,
  gmailSearchSchema,
  gmailGetActionRequiredSchema
} from "./schemas/gmail";
import {
  calendarGetTodaySchema,
  calendarGetWeekSchema,
  calendarGetEventSchema
} from "./schemas/calendar";
import { servicenowQueryTableSchema } from "./schemas/servicenow";

import {
  clickupListTasks,
  clickupGetTask,
  clickupSearchTasks,
  clickupGetTeamSync
} from "./tools/clickup";
import type { ClickUpDeps } from "./tools/clickup";
import {
  gmailGetUnread,
  gmailGetStarred,
  gmailSearch,
  gmailGetActionRequired
} from "./tools/gmail";
import type { GmailDeps } from "./tools/gmail";
import {
  calendarGetToday,
  calendarGetWeek,
  calendarGetEvent
} from "./tools/calendar";
import type { CalendarDeps } from "./tools/calendar";
import { servicenowQueryTable } from "./tools/servicenow";
import type { ServiceNowDeps } from "./tools/servicenow";

export var TOOL_NAMES = [
  "clickup_list_tasks",
  "clickup_get_task",
  "clickup_search_tasks",
  "clickup_get_team_sync",
  "gmail_get_unread",
  "gmail_get_starred",
  "gmail_search",
  "gmail_get_action_required",
  "calendar_get_today",
  "calendar_get_week",
  "calendar_get_event",
  "servicenow_query_table"
] as const;

export type ToolName = typeof TOOL_NAMES[number];

export interface RegistryDeps {
  clickup?: ClickUpDeps;
  gmail?: GmailDeps;
  calendar?: CalendarDeps;
  servicenow: ServiceNowDeps;
  missingDescription?: string;
}

interface ToolDescriptor {
  name: ToolName;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: any) => Promise<any>;
}

function buildDescriptors(deps: RegistryDeps): ToolDescriptor[] {
  var clickupReady = !!deps.clickup;
  var googleReady = !!deps.gmail && !!deps.calendar;

  return [
    {
      name: "clickup_list_tasks",
      description: "List ClickUp tasks assigned to the authenticated user, grouped by status. teamId optional if CLICKUP_TEAM_ID is set.",
      shape: clickupListTasksSchema.shape,
      handler: requireConfig(clickupReady, "ClickUp", deps.missingDescription, function (args) {
        return clickupListTasks(args, deps.clickup as ClickUpDeps);
      })
    },
    {
      name: "clickup_get_task",
      description: "Fetch a single ClickUp task by ID.",
      shape: clickupGetTaskSchema.shape,
      handler: requireConfig(clickupReady, "ClickUp", deps.missingDescription, function (args) {
        return clickupGetTask(args, deps.clickup as ClickUpDeps);
      })
    },
    {
      name: "clickup_search_tasks",
      description: "Search team tasks by substring match against task name/description. teamId optional if CLICKUP_TEAM_ID is set.",
      shape: clickupSearchTasksSchema.shape,
      handler: requireConfig(clickupReady, "ClickUp", deps.missingDescription, function (args) {
        return clickupSearchTasks(args, deps.clickup as ClickUpDeps);
      })
    },
    {
      name: "clickup_get_team_sync",
      description: "Returns a structured JSON team sync with the 7-stage pipeline (Blocked, In Progress, In Review, QA, UAT, Ready for Release, Done) plus unmapped statuses and unassigned tasks.",
      shape: clickupGetTeamSyncSchema.shape,
      handler: requireConfig(clickupReady, "ClickUp", deps.missingDescription, function (args) {
        return clickupGetTeamSync(args, deps.clickup as ClickUpDeps);
      })
    },
    {
      name: "gmail_get_unread",
      description: "Fetch unread emails from the inbox.",
      shape: gmailGetUnreadSchema.shape,
      handler: requireConfig(googleReady, "Google (Gmail)", deps.missingDescription, function (args) {
        return gmailGetUnread(args, deps.gmail as GmailDeps);
      })
    },
    {
      name: "gmail_get_starred",
      description: "Fetch starred emails.",
      shape: gmailGetStarredSchema.shape,
      handler: requireConfig(googleReady, "Google (Gmail)", deps.missingDescription, function (args) {
        return gmailGetStarred(args, deps.gmail as GmailDeps);
      })
    },
    {
      name: "gmail_search",
      description: "Search emails using Gmail query syntax (e.g. 'from:alice has:attachment').",
      shape: gmailSearchSchema.shape,
      handler: requireConfig(googleReady, "Google (Gmail)", deps.missingDescription, function (args) {
        return gmailSearch(args, deps.gmail as GmailDeps);
      })
    },
    {
      name: "gmail_get_action_required",
      description: "Fetch unread action-required emails matched against subject patterns and labels (defaults: 'action required', 'urgent', 'asap', 'time sensitive').",
      shape: gmailGetActionRequiredSchema.shape,
      handler: requireConfig(googleReady, "Google (Gmail)", deps.missingDescription, function (args) {
        return gmailGetActionRequired(args, deps.gmail as GmailDeps);
      })
    },
    {
      name: "calendar_get_today",
      description: "Fetch today's calendar events.",
      shape: calendarGetTodaySchema.shape,
      handler: requireConfig(googleReady, "Google (Calendar)", deps.missingDescription, function (args) {
        return calendarGetToday(args, deps.calendar as CalendarDeps);
      })
    },
    {
      name: "calendar_get_week",
      description: "Fetch the next 7 days of calendar events.",
      shape: calendarGetWeekSchema.shape,
      handler: requireConfig(googleReady, "Google (Calendar)", deps.missingDescription, function (args) {
        return calendarGetWeek(args, deps.calendar as CalendarDeps);
      })
    },
    {
      name: "calendar_get_event",
      description: "Fetch a single calendar event by ID.",
      shape: calendarGetEventSchema.shape,
      handler: requireConfig(googleReady, "Google (Calendar)", deps.missingDescription, function (args) {
        return calendarGetEvent(args, deps.calendar as CalendarDeps);
      })
    },
    {
      name: "servicenow_query_table",
      description: "Read-only GET against the ServiceNow Table API. Required: table (lower-case identifier), sysparm_query (ServiceNow encoded query). Optional: fields[] limits the columns returned, limit caps row count (default 100, max 1000). Tables on the deny list (sys_user_password, sys_credential, etc.) are rejected unless SINC_MCP_SN_TABLE_OVERRIDE=<table> is set.",
      shape: servicenowQueryTableSchema.shape,
      handler: function (args: any) {
        return servicenowQueryTable(args, deps.servicenow);
      }
    }
  ];
}

function requireConfig(
  ready: boolean,
  label: string,
  missingDescription: string | undefined,
  fn: (args: any) => Promise<any>
): (args: any) => Promise<any> {
  if (ready) {
    return fn;
  }
  return async function () {
    var detail = missingDescription || "missing required env vars";
    throw new Error(label + " is not configured — " + detail);
  };
}

export function registerAllTools(server: McpServer, deps: RegistryDeps): void {
  var descriptors = buildDescriptors(deps);
  for (var i = 0; i < descriptors.length; i++) {
    registerOne(server, descriptors[i]);
  }
}

function registerOne(server: McpServer, desc: ToolDescriptor): void {
  // Cast at the SDK boundary: registerTool's deep generic inference over
  // ZodRawShapeCompat blows past the TypeScript instantiation depth limit
  // when a heterogeneous descriptor list feeds the same call site.
  (server.registerTool as any)(
    desc.name,
    {
      description: desc.description,
      inputSchema: desc.shape
    },
    async function (args: any) {
      try {
        var result = await withTelemetry(desc.name, args, function () {
          return desc.handler(args);
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result)
            }
          ]
        };
      } catch (err) {
        var mapped = mapToolError(err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: mapped.message,
                retryable: mapped.retryable,
                tool: desc.name
              })
            }
          ]
        };
      }
    }
  );
}

export function buildDescriptorsForTests(deps: RegistryDeps): ToolDescriptor[] {
  return buildDescriptors(deps);
}
