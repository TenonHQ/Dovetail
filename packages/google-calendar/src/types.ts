/**
 * Google Calendar API type definitions for Dovetail integration.
 */

import { calendar_v3 } from "@googleapis/calendar";

// --- Core Entities ---

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: EventDateTime;
  end: EventDateTime;
  attendees: EventAttendee[];
  organizer: EventOrganizer;
  status: string;
  htmlLink: string;
  isAllDay: boolean;
  created: string;
  updated: string;
}

export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface EventAttendee {
  email: string;
  displayName: string;
  responseStatus: string;
  self: boolean;
}

export interface EventOrganizer {
  email: string;
  displayName: string;
  self: boolean;
}

// --- Result Types ---

export interface CalendarSearchResult {
  events: CalendarEvent[];
  total: number;
  nextPageToken?: string;
}

// --- Function Parameter Types (single-object pattern) ---

export interface GetTodayEventsParams {
  calendarId?: string;
  timeZone?: string;
}

export interface GetUpcomingEventsParams {
  calendarId?: string;
  days?: number;
  maxResults?: number;
  timeZone?: string;
}

export interface GetEventParams {
  eventId: string;
  calendarId?: string;
}

export interface SearchEventsParams {
  query: string;
  timeMin?: string;
  timeMax?: string;
  calendarId?: string;
  maxResults?: number;
}

export interface CreateEventParams {
  summary: string;
  start: EventDateTime;
  end: EventDateTime;
  description?: string;
  location?: string;
  attendees?: EventAttendee[];
  calendarId?: string;
}

export interface UpdateEventParams {
  eventId: string;
  summary?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  description?: string;
  location?: string;
  calendarId?: string;
}

export interface DeleteEventParams {
  eventId: string;
  calendarId?: string;
}

// --- Formatter Parameter Types ---

export interface FormatDailyAgendaParams {
  events: CalendarEvent[];
  date: Date;
}

export interface FormatEventParams {
  event: CalendarEvent;
}

// --- Re-export for consumers ---

export type CalendarClient = calendar_v3.Calendar;
