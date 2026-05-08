# @tenonhq/dovetail-gmail

Gmail API client for Dovetail. Provides inbox operations and LLM-optimized formatting for the CTO morning digest (`context/email-digest.md`).

## Install

```bash
npm i -D @tenonhq/dovetail-gmail @tenonhq/dovetail-google-auth
```

## Setup

Gmail auth is handled by [`@tenonhq/dovetail-google-auth`](../google-auth). Follow the setup in that package's README to obtain `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`. The OAuth consent screen must enable the **Gmail API** with the `gmail.modify` scope.

```bash
# .env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

## Usage

```typescript
import { createGoogleAuth, configFromEnv } from "@tenonhq/dovetail-google-auth";
import {
  createGmailClient,
  getUnread,
  getStarred,
  getVipEmails,
  getActionRequired,
  formatDigest,
} from "@tenonhq/dovetail-gmail";

var { auth } = createGoogleAuth({ config: configFromEnv() });
var client = createGmailClient({ auth: auth });

var unread = await getUnread({ client: client, maxResults: 25 });
var starred = await getStarred({ client: client });
var vip = await getVipEmails({
  client: client,
  config: { senders: ["daniel@tenonhq.com"] },
});
var action = await getActionRequired({ client: client });

var digest = formatDigest({
  unread: unread,
  starred: starred,
  vip: vip,
  actionRequired: action,
});
```

## API Surface

- **Client:** `createGmailClient`
- **Read:** `getUnread`, `getStarred`, `searchEmails`, `getThread`, `getVipEmails`, `getActionRequired`
- **Write:** `archiveEmail`, `labelEmail`, `markAsRead`, `markAsUnread`, `moveToTrash`, `starEmail`, `unstarEmail`
- **Formatting:** `formatDigest`, `formatThread`, `formatEmailSummary`
- **Parsing:** `parseGmailIdentifier` — extracts message/thread IDs from Gmail URLs

See `src/types.ts` for the full type surface including `VipConfig` and `ActionRequiredConfig`.

## Related

- [`@tenonhq/dovetail-google-auth`](../google-auth) — shared OAuth2 layer
- [`@tenonhq/dovetail-google-calendar`](../google-calendar) — sibling Google integration
