/**
 * Calendar read-only MCP tools.
 *
 * Imports only read functions. createEvent, updateEvent, deleteEvent are
 * forbidden by ESLint and asserted absent by readonly-imports test.
 */

import type { OAuth2Client } from "google-auth-library";
import { createGoogleAuth } from "@tenonhq/sincronia-google-auth";
import {
  createCalendarClient,
  getTodayEvents,
  getUpcomingEvents,
  getEvent
} from "@tenonhq/sincronia-google-calendar";
import type { CalendarClient } from "@tenonhq/sincronia-google-calendar";
import type { GoogleConfig } from "../config";
import {
  CalendarGetTodayInput,
  CalendarGetWeekInput,
  CalendarGetEventInput
} from "../schemas/calendar";

export interface CalendarDeps {
  config: GoogleConfig;
  authFactory?: (config: GoogleConfig) => OAuth2Client;
  clientFactory?: (auth: OAuth2Client) => CalendarClient;
}

function resolveClient(deps: CalendarDeps): CalendarClient {
  var auth: OAuth2Client;
  if (deps.authFactory) {
    auth = deps.authFactory(deps.config);
  } else {
    auth = createGoogleAuth({ config: deps.config }).auth;
  }
  if (deps.clientFactory) {
    return deps.clientFactory(auth);
  }
  return createCalendarClient({ auth: auth });
}

export async function calendarGetToday(
  args: CalendarGetTodayInput,
  deps: CalendarDeps
): Promise<any> {
  var client = resolveClient(deps);
  return await getTodayEvents({
    client: client,
    calendarId: args.calendarId,
    timeZone: args.timeZone
  });
}

export async function calendarGetWeek(
  args: CalendarGetWeekInput,
  deps: CalendarDeps
): Promise<any> {
  var client = resolveClient(deps);
  return await getUpcomingEvents({
    client: client,
    days: 7,
    maxResults: args.maxResults,
    calendarId: args.calendarId,
    timeZone: args.timeZone
  });
}

export async function calendarGetEvent(
  args: CalendarGetEventInput,
  deps: CalendarDeps
): Promise<any> {
  var client = resolveClient(deps);
  return await getEvent({
    client: client,
    eventId: args.eventId,
    calendarId: args.calendarId
  });
}
