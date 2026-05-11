var mockGetTodayEvents = jest.fn();
var mockGetUpcomingEvents = jest.fn();
var mockGetEvent = jest.fn();

jest.mock("@tenonhq/dovetail-google-calendar", function () {
  return {
    createCalendarClient: jest.fn(function () { return {} as any; }),
    getTodayEvents: mockGetTodayEvents,
    getUpcomingEvents: mockGetUpcomingEvents,
    getEvent: mockGetEvent
  };
});

jest.mock("@tenonhq/dovetail-google-auth", function () {
  return {
    createGoogleAuth: jest.fn(function () { return { auth: {} as any }; })
  };
});

import {
  calendarGetToday,
  calendarGetWeek,
  calendarGetEvent
} from "../tools/calendar";

function makeDeps() {
  return {
    config: { clientId: "i", clientSecret: "s", refreshToken: "r" },
    authFactory: function () { return {} as any; },
    clientFactory: function () { return {} as any; }
  };
}

describe("calendar tools", function () {
  beforeEach(function () {
    mockGetTodayEvents.mockReset();
    mockGetUpcomingEvents.mockReset();
    mockGetEvent.mockReset();
  });

  it("calendar_get_today forwards calendarId and timeZone", async function () {
    mockGetTodayEvents.mockResolvedValue([]);
    await calendarGetToday(
      { calendarId: "primary", timeZone: "America/Los_Angeles" } as any,
      makeDeps()
    );
    var args = mockGetTodayEvents.mock.calls[0][0];
    expect(args.calendarId).toBe("primary");
    expect(args.timeZone).toBe("America/Los_Angeles");
  });

  it("calendar_get_week pins days=7 and forwards optional fields", async function () {
    mockGetUpcomingEvents.mockResolvedValue({ events: [], total: 0 });
    await calendarGetWeek(
      { maxResults: 25, calendarId: "c1", timeZone: "UTC" } as any,
      makeDeps()
    );
    var args = mockGetUpcomingEvents.mock.calls[0][0];
    expect(args.days).toBe(7);
    expect(args.maxResults).toBe(25);
    expect(args.calendarId).toBe("c1");
    expect(args.timeZone).toBe("UTC");
  });

  it("calendar_get_event forwards eventId and calendarId", async function () {
    mockGetEvent.mockResolvedValue({ id: "E1" } as any);
    var out = await calendarGetEvent(
      { eventId: "E1", calendarId: "c1" } as any,
      makeDeps()
    );
    expect(out.id).toBe("E1");
    var args = mockGetEvent.mock.calls[0][0];
    expect(args.eventId).toBe("E1");
    expect(args.calendarId).toBe("c1");
  });
});
