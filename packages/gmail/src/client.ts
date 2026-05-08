import { gmail as gmailApi } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import { handleAuthError } from "@tenonhq/dovetail-google-auth";
import sanitizeHtml from "sanitize-html";
import {
  GmailEmail,
  GmailThread,
  GmailSearchResult,
  GmailClient,
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
} from "./types";

var USER_ID = "me";

// --- Client Factory ---

/**
 * @description Creates a Gmail API client from an authenticated OAuth2 client.
 * @param params - Object with the OAuth2Client auth instance.
 * @returns The Gmail API client.
 */
export function createGmailClient(params: {
  auth: OAuth2Client;
}): GmailClient {
  return gmailApi({ version: "v1", auth: params.auth });
}

// --- Read Operations ---

/**
 * @description Fetches unread emails from the inbox.
 * @param params - Object with client and optional maxResults.
 * @returns Search result with unread emails.
 */
export async function getUnread(params: {
  client: GmailClient;
} & GetUnreadParams): Promise<GmailSearchResult> {
  return searchEmails({
    client: params.client,
    query: "is:unread in:inbox",
    maxResults: params.maxResults || 20,
    pageToken: params.pageToken,
  });
}

/**
 * @description Fetches starred emails.
 * @param params - Object with client and optional maxResults.
 * @returns Search result with starred emails.
 */
export async function getStarred(params: {
  client: GmailClient;
} & GetStarredParams): Promise<GmailSearchResult> {
  return searchEmails({
    client: params.client,
    query: "is:starred",
    maxResults: params.maxResults || 10,
    pageToken: params.pageToken,
  });
}

/**
 * @description Searches emails using Gmail query syntax.
 * @param params - Object with client, query string, optional maxResults and pageToken.
 * @returns Search result with matching emails.
 */
export async function searchEmails(params: {
  client: GmailClient;
} & SearchEmailsParams): Promise<GmailSearchResult> {
  try {
    var response = await params.client.users.messages.list({
      userId: USER_ID,
      q: params.query,
      maxResults: params.maxResults || 20,
      pageToken: params.pageToken,
    });

    var messages = response.data.messages || [];
    var emails: GmailEmail[] = [];

    for (var i = 0; i < messages.length; i++) {
      var msgResponse = await params.client.users.messages.get({
        userId: USER_ID,
        id: messages[i].id as string,
        format: "full",
      });
      emails.push(parseMessage(msgResponse.data));
    }

    return {
      emails: emails,
      total: response.data.resultSizeEstimate || emails.length,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  } catch (error) {
    return handleAuthError(error, "searching emails with query '" + params.query + "'");
  }
}

/**
 * @description Fetches a full email thread with all messages.
 * @param params - Object with client and threadId.
 * @returns The email thread with all messages.
 */
export async function getThread(params: {
  client: GmailClient;
} & GetThreadParams): Promise<GmailThread> {
  try {
    var response = await params.client.users.threads.get({
      userId: USER_ID,
      id: params.threadId,
      format: "full",
    });

    var threadData = response.data;
    var threadMessages = threadData.messages || [];
    var emails: GmailEmail[] = [];
    var participants: string[] = [];
    var seen: Record<string, boolean> = {};

    for (var i = 0; i < threadMessages.length; i++) {
      var email = parseMessage(threadMessages[i]);
      emails.push(email);

      if (email.from && !seen[email.from]) {
        seen[email.from] = true;
        participants.push(email.from);
      }
    }

    var subject = emails.length > 0 ? emails[0].subject : "(No subject)";
    var snippet = threadData.snippet || "";

    return {
      id: threadData.id || params.threadId,
      messages: emails,
      subject: subject,
      participants: participants,
      messageCount: emails.length,
      snippet: snippet,
    };
  } catch (error) {
    return handleAuthError(error, "fetching thread '" + params.threadId + "'");
  }
}

/**
 * @description Fetches unread emails from VIP senders.
 * @param params - Object with client, senders list, and optional maxResults.
 * @returns Search result with VIP emails.
 */
export async function getVipEmails(params: {
  client: GmailClient;
} & GetVipEmailsParams): Promise<GmailSearchResult> {
  if (!params.senders || params.senders.length === 0) {
    return { emails: [], total: 0 };
  }

  var fromClauses: string[] = [];
  for (var i = 0; i < params.senders.length; i++) {
    fromClauses.push("from:" + params.senders[i]);
  }

  var query = "is:unread (" + fromClauses.join(" OR ") + ")";
  return searchEmails({
    client: params.client,
    query: query,
    maxResults: params.maxResults || 10,
  });
}

/**
 * @description Fetches action-required emails based on subject patterns and labels.
 * @param params - Object with client, optional labels, subjectPatterns, and maxResults.
 * @returns Search result with action-required emails.
 */
export async function getActionRequired(params: {
  client: GmailClient;
} & GetActionRequiredParams): Promise<GmailSearchResult> {
  var parts: string[] = [];

  // Default subject patterns if none provided
  var patterns = params.subjectPatterns || ["action required", "urgent", "asap", "time sensitive"];
  var subjectClauses: string[] = [];
  for (var i = 0; i < patterns.length; i++) {
    subjectClauses.push("subject:(" + patterns[i] + ")");
  }
  if (subjectClauses.length > 0) {
    parts.push("(" + subjectClauses.join(" OR ") + ")");
  }

  // Label filters
  if (params.labels && params.labels.length > 0) {
    var labelClauses: string[] = [];
    for (var l = 0; l < params.labels.length; l++) {
      labelClauses.push("label:" + params.labels[l]);
    }
    parts.push("(" + labelClauses.join(" OR ") + ")");
  }

  var query = "is:unread " + parts.join(" ");
  return searchEmails({
    client: params.client,
    query: query,
    maxResults: params.maxResults || 10,
  });
}

// --- Write Operations ---

/**
 * @description Archives an email by removing the INBOX label.
 * @param params - Object with client and messageId.
 */
export async function archiveEmail(params: {
  client: GmailClient;
} & ArchiveEmailParams): Promise<void> {
  try {
    await params.client.users.messages.modify({
      userId: USER_ID,
      id: params.messageId,
      requestBody: {
        removeLabelIds: ["INBOX"],
      },
    });
  } catch (error) {
    return handleAuthError(error, "archiving email '" + params.messageId + "'");
  }
}

/**
 * @description Adds or removes labels from an email.
 * @param params - Object with client, messageId, and labels to add/remove.
 */
export async function labelEmail(params: {
  client: GmailClient;
} & LabelEmailParams): Promise<void> {
  try {
    var body: Record<string, any> = {};
    if (params.addLabels && params.addLabels.length > 0) {
      body.addLabelIds = params.addLabels;
    }
    if (params.removeLabels && params.removeLabels.length > 0) {
      body.removeLabelIds = params.removeLabels;
    }

    await params.client.users.messages.modify({
      userId: USER_ID,
      id: params.messageId,
      requestBody: body,
    });
  } catch (error) {
    return handleAuthError(error, "labeling email '" + params.messageId + "'");
  }
}

/**
 * @description Marks an email as read by removing the UNREAD label.
 * @param params - Object with client and messageId.
 */
export async function markAsRead(params: {
  client: GmailClient;
} & MarkAsReadParams): Promise<void> {
  try {
    await params.client.users.messages.modify({
      userId: USER_ID,
      id: params.messageId,
      requestBody: {
        removeLabelIds: ["UNREAD"],
      },
    });
  } catch (error) {
    return handleAuthError(error, "marking email '" + params.messageId + "' as read");
  }
}

/**
 * @description Marks an email as unread by adding the UNREAD label.
 * @param params - Object with client and messageId.
 */
export async function markAsUnread(params: {
  client: GmailClient;
} & MarkAsUnreadParams): Promise<void> {
  try {
    await params.client.users.messages.modify({
      userId: USER_ID,
      id: params.messageId,
      requestBody: {
        addLabelIds: ["UNREAD"],
      },
    });
  } catch (error) {
    return handleAuthError(error, "marking email '" + params.messageId + "' as unread");
  }
}

/**
 * @description Moves an email to trash.
 * @param params - Object with client and messageId.
 */
export async function moveToTrash(params: {
  client: GmailClient;
} & MoveToTrashParams): Promise<void> {
  try {
    await params.client.users.messages.trash({
      userId: USER_ID,
      id: params.messageId,
    });
  } catch (error) {
    return handleAuthError(error, "trashing email '" + params.messageId + "'");
  }
}

/**
 * @description Stars an email by adding the STARRED label.
 * @param params - Object with client and messageId.
 */
export async function starEmail(params: {
  client: GmailClient;
} & StarEmailParams): Promise<void> {
  try {
    await params.client.users.messages.modify({
      userId: USER_ID,
      id: params.messageId,
      requestBody: {
        addLabelIds: ["STARRED"],
      },
    });
  } catch (error) {
    return handleAuthError(error, "starring email '" + params.messageId + "'");
  }
}

/**
 * @description Unstars an email by removing the STARRED label.
 * @param params - Object with client and messageId.
 */
export async function unstarEmail(params: {
  client: GmailClient;
} & UnstarEmailParams): Promise<void> {
  try {
    await params.client.users.messages.modify({
      userId: USER_ID,
      id: params.messageId,
      requestBody: {
        removeLabelIds: ["STARRED"],
      },
    });
  } catch (error) {
    return handleAuthError(error, "unstarring email '" + params.messageId + "'");
  }
}

// --- Internal Helpers ---

/**
 * Parses a Gmail API message into a GmailEmail object.
 * Handles header extraction, base64url body decoding, and multipart MIME.
 */
function parseMessage(message: Record<string, any>): GmailEmail {
  var headers = message.payload && message.payload.headers
    ? message.payload.headers
    : [];

  var subject = getHeader(headers, "Subject") || "(No subject)";
  var from = getHeader(headers, "From") || "Unknown";
  var to = getHeader(headers, "To") || "";
  var date = getHeader(headers, "Date") || "";

  var labels: string[] = message.labelIds || [];
  var isUnread = labels.indexOf("UNREAD") !== -1;
  var isStarred = labels.indexOf("STARRED") !== -1;

  var body = extractBody(message.payload || {});

  return {
    id: message.id || "",
    threadId: message.threadId || "",
    subject: subject,
    from: from,
    to: to,
    date: date,
    snippet: message.snippet || "",
    labels: labels,
    isUnread: isUnread,
    isStarred: isStarred,
    body: body,
  };
}

function getHeader(headers: any[], name: string): string {
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].name && headers[i].name.toLowerCase() === name.toLowerCase()) {
      return headers[i].value || "";
    }
  }
  return "";
}

/**
 * Extracts the email body from a Gmail message payload.
 * Handles multipart MIME, preferring text/plain over text/html.
 */
function extractBody(payload: Record<string, any>): string {
  // Direct body on payload
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — look for text/plain first, then text/html
  if (payload.parts && Array.isArray(payload.parts)) {
    var plainText = "";
    var htmlText = "";

    for (var i = 0; i < payload.parts.length; i++) {
      var part = payload.parts[i];
      var mimeType = part.mimeType || "";

      if (mimeType === "text/plain" && part.body && part.body.data) {
        plainText = decodeBase64Url(part.body.data);
      } else if (mimeType === "text/html" && part.body && part.body.data) {
        htmlText = decodeBase64Url(part.body.data);
      } else if (mimeType.indexOf("multipart") === 0 && part.parts) {
        // Nested multipart — recurse
        var nested = extractBody(part);
        if (nested) {
          if (!plainText) {
            plainText = nested;
          }
        }
      }
    }

    // Prefer plain text
    if (plainText) {
      return plainText;
    }
    if (htmlText) {
      return stripHtml(htmlText);
    }
  }

  return "";
}

function decodeBase64Url(data: string): string {
  try {
    // Replace URL-safe chars with standard base64
    var base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch (e) {
    return "";
  }
}

function stripHtml(html: string): string {
  // Basic HTML stripping — remove tags, decode common entities
  return sanitizeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n"),
    { allowedTags: [], allowedAttributes: {} },
  )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
