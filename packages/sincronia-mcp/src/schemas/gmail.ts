import { z } from "zod";

export var gmailGetUnreadSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional()
}).strict();

export var gmailGetStarredSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional()
}).strict();

export var gmailSearchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional()
}).strict();

export var gmailGetActionRequiredSchema = z.object({
  labels: z.array(z.string()).optional(),
  subjectPatterns: z.array(z.string()).optional(),
  maxResults: z.number().int().min(1).max(100).optional()
}).strict();

export type GmailGetUnreadInput = z.infer<typeof gmailGetUnreadSchema>;
export type GmailGetStarredInput = z.infer<typeof gmailGetStarredSchema>;
export type GmailSearchInput = z.infer<typeof gmailSearchSchema>;
export type GmailGetActionRequiredInput = z.infer<typeof gmailGetActionRequiredSchema>;
