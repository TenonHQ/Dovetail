/**
 * @tenonhq/dovetail-google-calendar
 *
 * Google Calendar API client for Dovetail.
 * Provides event management, agenda queries, and LLM-optimized formatting.
 */

// Client and API functions
export {
  createCalendarClient,
  getTodayEvents,
  getUpcomingEvents,
  getEvent,
  searchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from "./client";

// Formatting utilities
export {
  formatDailyAgenda,
  formatEvent,
} from "./formatter";

// Type definitions
export type {
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
  FormatDailyAgendaParams,
  FormatEventParams,
} from "./types";
