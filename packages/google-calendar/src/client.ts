import { calendar as calendarApi } from "@googleapis/calendar";
import { OAuth2Client } from "google-auth-library";
import { handleAuthError } from "@tenonhq/dovetail-google-auth";
import {
  CalendarEvent,
  EventDateTime,
  EventAttendee,
  EventOrganizer,
  CalendarSearchResult,
  CalendarClient,
  GetTodayEventsParams,
  GetUpcomingEventsParams,
  GetEventParams,
  SearchEventsParams,
  CreateEventParams,
  UpdateEventParams,
  DeleteEventParams,
} from "./types";

var DEFAULT_CALENDAR_ID = "primary";

// --- Client Factory ---

/**
 * @description Creates a Google Calendar API client from an authenticated OAuth2 client.
 * @param params - Object with the OAuth2Client auth instance.
 * @returns The Google Calendar API client.
 */
export function createCalendarClient(params: {
  auth: OAuth2Client;
}): CalendarClient {
  return calendarApi({ version: "v3", auth: params.auth });
}

// --- Read Operations ---

/**
 * @description Fetches today's calendar events.
 * @param params - Object with client and optional calendarId and timeZone.
 * @returns Array of calendar events for today.
 */
export async function getTodayEvents(params: {
  client: CalendarClient;
} & GetTodayEventsParams): Promise<CalendarEvent[]> {
  try {
    var now = new Date();
    var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    var response = await params.client.events.list({
      calendarId: params.calendarId || DEFAULT_CALENDAR_ID,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: params.timeZone,
    });

    var items = response.data.items || [];
    var events: CalendarEvent[] = [];
    for (var i = 0; i < items.length; i++) {
      events.push(parseEvent(items[i]));
    }
    return events;
  } catch (error) {
    return handleAuthError(error, "fetching today's events");
  }
}

/**
 * @description Fetches upcoming events for a configurable time range.
 * @param params - Object with client, optional days (default 7), maxResults, calendarId, timeZone.
 * @returns Search result with events and total count.
 */
export async function getUpcomingEvents(params: {
  client: CalendarClient;
} & GetUpcomingEventsParams): Promise<CalendarSearchResult> {
  try {
    var days = params.days !== undefined ? params.days : 7;
    var now = new Date();
    var end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    var response = await params.client.events.list({
      calendarId: params.calendarId || DEFAULT_CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: params.maxResults || 50,
      timeZone: params.timeZone,
    });

    var items = response.data.items || [];
    var events: CalendarEvent[] = [];
    for (var i = 0; i < items.length; i++) {
      events.push(parseEvent(items[i]));
    }

    return {
      events: events,
      total: events.length,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  } catch (error) {
    return handleAuthError(error, "fetching upcoming events");
  }
}

/**
 * @description Fetches a single calendar event by ID.
 * @param params - Object with client, eventId, and optional calendarId.
 * @returns The calendar event.
 */
export async function getEvent(params: {
  client: CalendarClient;
} & GetEventParams): Promise<CalendarEvent> {
  try {
    var response = await params.client.events.get({
      calendarId: params.calendarId || DEFAULT_CALENDAR_ID,
      eventId: params.eventId,
    });
    return parseEvent(response.data);
  } catch (error) {
    return handleAuthError(error, "fetching event '" + params.eventId + "'");
  }
}

/**
 * @description Searches calendar events by title or description.
 * @param params - Object with client, query string, optional time range and calendarId.
 * @returns Search result with matching events.
 */
export async function searchEvents(params: {
  client: CalendarClient;
} & SearchEventsParams): Promise<CalendarSearchResult> {
  try {
    var listParams: Record<string, any> = {
      calendarId: params.calendarId || DEFAULT_CALENDAR_ID,
      q: params.query,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: params.maxResults || 25,
    };
    if (params.timeMin) {
      listParams.timeMin = params.timeMin;
    }
    if (params.timeMax) {
      listParams.timeMax = params.timeMax;
    }

    var response = await params.client.events.list(listParams);
    var items = response.data.items || [];
    var events: CalendarEvent[] = [];
    for (var i = 0; i < items.length; i++) {
      events.push(parseEvent(items[i]));
    }

    return {
      events: events,
      total: events.length,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  } catch (error) {
    return handleAuthError(error, "searching events for '" + params.query + "'");
  }
}

// --- Write Operations ---

/**
 * @description Creates a new calendar event.
 * @param params - Object with client, summary, start, end, and optional fields.
 * @returns The created event.
 */
export async function createEvent(params: {
  client: CalendarClient;
} & CreateEventParams): Promise<CalendarEvent> {
  try {
    var body: Record<string, any> = {
      summary: params.summary,
      start: params.start,
      end: params.end,
    };
    if (params.description !== undefined) {
      body.description = params.description;
    }
    if (params.location !== undefined) {
      body.location = params.location;
    }
    if (params.attendees !== undefined) {
      body.attendees = params.attendees.map(function (a) {
        return { email: a.email, displayName: a.displayName };
      });
    }

    var response = await params.client.events.insert({
      calendarId: params.calendarId || DEFAULT_CALENDAR_ID,
      requestBody: body,
    });
    return parseEvent(response.data);
  } catch (error) {
    return handleAuthError(error, "creating event '" + params.summary + "'");
  }
}

/**
 * @description Updates an existing calendar event (partial update).
 * @param params - Object with client, eventId, and fields to update.
 * @returns The updated event.
 */
export async function updateEvent(params: {
  client: CalendarClient;
} & UpdateEventParams): Promise<CalendarEvent> {
  try {
    var body: Record<string, any> = {};
    if (params.summary !== undefined) {
      body.summary = params.summary;
    }
    if (params.start !== undefined) {
      body.start = params.start;
    }
    if (params.end !== undefined) {
      body.end = params.end;
    }
    if (params.description !== undefined) {
      body.description = params.description;
    }
    if (params.location !== undefined) {
      body.location = params.location;
    }

    var response = await params.client.events.patch({
      calendarId: params.calendarId || DEFAULT_CALENDAR_ID,
      eventId: params.eventId,
      requestBody: body,
    });
    return parseEvent(response.data);
  } catch (error) {
    return handleAuthError(error, "updating event '" + params.eventId + "'");
  }
}

/**
 * @description Deletes a calendar event.
 * @param params - Object with client, eventId, and optional calendarId.
 */
export async function deleteEvent(params: {
  client: CalendarClient;
} & DeleteEventParams): Promise<void> {
  try {
    await params.client.events.delete({
      calendarId: params.calendarId || DEFAULT_CALENDAR_ID,
      eventId: params.eventId,
    });
  } catch (error) {
    return handleAuthError(error, "deleting event '" + params.eventId + "'");
  }
}

// --- Internal Helpers ---

function parseEvent(event: Record<string, any>): CalendarEvent {
  var start = event.start || {};
  var end = event.end || {};
  var isAllDay = !start.dateTime && !!start.date;

  var attendees: EventAttendee[] = [];
  if (event.attendees && Array.isArray(event.attendees)) {
    for (var i = 0; i < event.attendees.length; i++) {
      var a = event.attendees[i];
      attendees.push({
        email: a.email || "",
        displayName: a.displayName || "",
        responseStatus: a.responseStatus || "needsAction",
        self: a.self === true,
      });
    }
  }

  var organizer: EventOrganizer = { email: "", displayName: "", self: false };
  if (event.organizer) {
    organizer = {
      email: event.organizer.email || "",
      displayName: event.organizer.displayName || "",
      self: event.organizer.self === true,
    };
  }

  return {
    id: event.id || "",
    summary: event.summary || "(No title)",
    description: event.description || "",
    location: event.location || "",
    start: {
      dateTime: start.dateTime || undefined,
      date: start.date || undefined,
      timeZone: start.timeZone || undefined,
    },
    end: {
      dateTime: end.dateTime || undefined,
      date: end.date || undefined,
      timeZone: end.timeZone || undefined,
    },
    attendees: attendees,
    organizer: organizer,
    status: event.status || "confirmed",
    htmlLink: event.htmlLink || "",
    isAllDay: isAllDay,
    created: event.created || "",
    updated: event.updated || "",
  };
}
