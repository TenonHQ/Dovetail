# @tenonhq/dovetail-google-calendar

Google Calendar API client for Dovetail. Provides event management and LLM-optimized agenda formatting for the CTO morning digest (`context/calendar.md`).

## Install

```bash
npm i -D @tenonhq/dovetail-google-calendar @tenonhq/dovetail-google-auth
```

## Setup

Calendar auth is handled by [`@tenonhq/dovetail-google-auth`](../google-auth). Follow the setup in that package's README to obtain `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`. The OAuth consent screen must enable the **Google Calendar API** with the `calendar` scope.

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
  createCalendarClient,
  getTodayEvents,
  getUpcomingEvents,
  createEvent,
  formatDailyAgenda,
} from "@tenonhq/dovetail-google-calendar";

var { auth } = createGoogleAuth({ config: configFromEnv() });
var client = createCalendarClient({ auth: auth });

var today = await getTodayEvents({ client: client });
var week = await getUpcomingEvents({ client: client, days: 7 });

var agenda = formatDailyAgenda({ events: today });

await createEvent({
  client: client,
  summary: "Strategy review",
  start: "2026-04-20T09:00:00-04:00",
  end: "2026-04-20T10:00:00-04:00",
});
```

## API Surface

- **Client:** `createCalendarClient`
- **Read:** `getTodayEvents`, `getUpcomingEvents`, `getEvent`, `searchEvents`
- **Write:** `createEvent`, `updateEvent`, `deleteEvent`
- **Formatting:** `formatDailyAgenda`, `formatEvent`

See `src/types.ts` for the full type surface.

## Related

- [`@tenonhq/dovetail-google-auth`](../google-auth) — shared OAuth2 layer
- [`@tenonhq/dovetail-gmail`](../gmail) — sibling Google integration
