/**
 * @tenonhq/dovetail-gmail
 *
 * Gmail API client for Dovetail.
 * Provides email management, inbox operations, and LLM-optimized formatting.
 */

// Client and API functions
export {
  createGmailClient,
  getUnread,
  getStarred,
  searchEmails,
  getThread,
  getVipEmails,
  getActionRequired,
  archiveEmail,
  labelEmail,
  markAsRead,
  markAsUnread,
  moveToTrash,
  starEmail,
  unstarEmail,
} from "./client";

// Formatting utilities
export {
  formatDigest,
  formatThread,
  formatEmailSummary,
} from "./formatter";

// URL/ID parsing
export { parseGmailIdentifier } from "./parser";

// Type definitions
export type {
  GmailEmail,
  GmailThread,
  GmailLabel,
  GmailSearchResult,
  GmailClient,
  VipConfig,
  ActionRequiredConfig,
  ParsedGmailIdentifier,
  GetUnreadParams,
  GetStarredParams,
  SearchEmailsParams,
  GetThreadParams,
  GetVipEmailsParams,
  GetActionRequiredParams,
  ArchiveEmailParams,
  LabelEmailParams,
  MarkAsReadParams,
  MarkAsUnreadParams,
  MoveToTrashParams,
  StarEmailParams,
  UnstarEmailParams,
  FormatDigestParams,
  FormatThreadParams,
  FormatEmailSummaryParams,
} from "./types";
