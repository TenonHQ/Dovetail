/**
 * Gmail API type definitions for Dovetail integration.
 */

import { gmail_v1 } from "@googleapis/gmail";

// --- Core Entities ---

export interface GmailEmail {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labels: string[];
  isUnread: boolean;
  isStarred: boolean;
  body: string;
}

export interface GmailThread {
  id: string;
  messages: GmailEmail[];
  subject: string;
  participants: string[];
  messageCount: number;
  snippet: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
}

// --- Result Types ---

export interface GmailSearchResult {
  emails: GmailEmail[];
  total: number;
  nextPageToken?: string;
}

// --- Configuration ---

export interface VipConfig {
  senders: string[];
}

export interface ActionRequiredConfig {
  labels?: string[];
  subjectPatterns?: string[];
}

// --- Function Parameter Types (single-object pattern) ---

export interface GetUnreadParams {
  maxResults?: number;
  pageToken?: string;
}

export interface GetStarredParams {
  maxResults?: number;
  pageToken?: string;
}

export interface SearchEmailsParams {
  query: string;
  maxResults?: number;
  pageToken?: string;
}

export interface GetThreadParams {
  threadId: string;
}

export interface GetVipEmailsParams {
  senders: string[];
  maxResults?: number;
}

export interface GetActionRequiredParams {
  labels?: string[];
  subjectPatterns?: string[];
  maxResults?: number;
}

export interface ArchiveEmailParams {
  messageId: string;
}

export interface LabelEmailParams {
  messageId: string;
  addLabels?: string[];
  removeLabels?: string[];
}

export interface MarkAsReadParams {
  messageId: string;
}

export interface MarkAsUnreadParams {
  messageId: string;
}

export interface MoveToTrashParams {
  messageId: string;
}

export interface StarEmailParams {
  messageId: string;
}

export interface UnstarEmailParams {
  messageId: string;
}

// --- Formatter Parameter Types ---

export interface FormatDigestParams {
  unread: GmailEmail[];
  starred: GmailEmail[];
  actionRequired: GmailEmail[];
  vip: GmailEmail[];
  date: Date;
  accountLabel?: string;
}

export interface FormatThreadParams {
  thread: GmailThread;
}

export interface FormatEmailSummaryParams {
  email: GmailEmail;
}

// --- Parser Types ---

export interface ParsedGmailIdentifier {
  messageId?: string;
  threadId?: string;
  raw: string;
}

// --- Re-export for consumers ---

export type GmailClient = gmail_v1.Gmail;
