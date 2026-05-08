import { z } from "zod";

export var calendarGetTodaySchema = z.object({
  calendarId: z.string().optional(),
  timeZone: z.string().optional()
}).strict();

export var calendarGetWeekSchema = z.object({
  maxResults: z.number().int().min(1).max(250).optional(),
  calendarId: z.string().optional(),
  timeZone: z.string().optional()
}).strict();

export var calendarGetEventSchema = z.object({
  eventId: z.string().min(1),
  calendarId: z.string().optional()
}).strict();

export type CalendarGetTodayInput = z.infer<typeof calendarGetTodaySchema>;
export type CalendarGetWeekInput = z.infer<typeof calendarGetWeekSchema>;
export type CalendarGetEventInput = z.infer<typeof calendarGetEventSchema>;
