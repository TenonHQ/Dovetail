/**
 * Gmail read-only MCP tools.
 *
 * Imports only read functions from @tenonhq/sincronia-gmail. archiveEmail,
 * labelEmail, markAsRead, markAsUnread, moveToTrash, starEmail, unstarEmail
 * are forbidden by ESLint and asserted absent by readonly-imports test.
 */

import type { OAuth2Client } from "google-auth-library";
import { createGoogleAuth } from "@tenonhq/sincronia-google-auth";
import {
  createGmailClient,
  getUnread,
  getStarred,
  searchEmails,
  getActionRequired
} from "@tenonhq/sincronia-gmail";
import type { GmailClient } from "@tenonhq/sincronia-gmail";
import type { GoogleConfig } from "../config";
import {
  GmailGetUnreadInput,
  GmailGetStarredInput,
  GmailSearchInput,
  GmailGetActionRequiredInput
} from "../schemas/gmail";

export interface GmailDeps {
  config: GoogleConfig;
  authFactory?: (config: GoogleConfig) => OAuth2Client;
  clientFactory?: (auth: OAuth2Client) => GmailClient;
}

function resolveClient(deps: GmailDeps): GmailClient {
  var auth: OAuth2Client;
  if (deps.authFactory) {
    auth = deps.authFactory(deps.config);
  } else {
    auth = createGoogleAuth({ config: deps.config }).auth;
  }
  if (deps.clientFactory) {
    return deps.clientFactory(auth);
  }
  return createGmailClient({ auth: auth });
}

export async function gmailGetUnread(
  args: GmailGetUnreadInput,
  deps: GmailDeps
): Promise<any> {
  var client = resolveClient(deps);
  return await getUnread({
    client: client,
    maxResults: args.maxResults,
    pageToken: args.pageToken
  });
}

export async function gmailGetStarred(
  args: GmailGetStarredInput,
  deps: GmailDeps
): Promise<any> {
  var client = resolveClient(deps);
  return await getStarred({
    client: client,
    maxResults: args.maxResults,
    pageToken: args.pageToken
  });
}

export async function gmailSearch(
  args: GmailSearchInput,
  deps: GmailDeps
): Promise<any> {
  var client = resolveClient(deps);
  return await searchEmails({
    client: client,
    query: args.query,
    maxResults: args.maxResults,
    pageToken: args.pageToken
  });
}

export async function gmailGetActionRequired(
  args: GmailGetActionRequiredInput,
  deps: GmailDeps
): Promise<any> {
  var client = resolveClient(deps);
  return await getActionRequired({
    client: client,
    labels: args.labels,
    subjectPatterns: args.subjectPatterns,
    maxResults: args.maxResults
  });
}
