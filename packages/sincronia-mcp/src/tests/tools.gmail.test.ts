var mockGetUnread = jest.fn();
var mockGetStarred = jest.fn();
var mockSearchEmails = jest.fn();
var mockGetActionRequired = jest.fn();

jest.mock("@tenonhq/sincronia-gmail", function () {
  return {
    createGmailClient: jest.fn(function () { return {} as any; }),
    getUnread: mockGetUnread,
    getStarred: mockGetStarred,
    searchEmails: mockSearchEmails,
    getActionRequired: mockGetActionRequired
  };
});

jest.mock("@tenonhq/sincronia-google-auth", function () {
  return {
    createGoogleAuth: jest.fn(function () { return { auth: {} as any }; })
  };
});

import {
  gmailGetUnread,
  gmailGetStarred,
  gmailSearch,
  gmailGetActionRequired
} from "../tools/gmail";

function makeDeps() {
  return {
    config: { clientId: "i", clientSecret: "s", refreshToken: "r" },
    authFactory: function () { return {} as any; },
    clientFactory: function () { return {} as any; }
  };
}

describe("gmail tools", function () {
  beforeEach(function () {
    mockGetUnread.mockReset();
    mockGetStarred.mockReset();
    mockSearchEmails.mockReset();
    mockGetActionRequired.mockReset();
  });

  it("gmail_get_unread forwards maxResults and pageToken", async function () {
    mockGetUnread.mockResolvedValue({ emails: [], total: 0 });
    await gmailGetUnread({ maxResults: 5, pageToken: "p" } as any, makeDeps());
    var args = mockGetUnread.mock.calls[0][0];
    expect(args.maxResults).toBe(5);
    expect(args.pageToken).toBe("p");
  });

  it("gmail_get_starred forwards maxResults and pageToken", async function () {
    mockGetStarred.mockResolvedValue({ emails: [], total: 0 });
    await gmailGetStarred({ maxResults: 3 } as any, makeDeps());
    expect(mockGetStarred.mock.calls[0][0].maxResults).toBe(3);
  });

  it("gmail_search forwards query, maxResults, pageToken", async function () {
    mockSearchEmails.mockResolvedValue({ emails: [], total: 0 });
    await gmailSearch(
      { query: "from:alice", maxResults: 7, pageToken: "tok" } as any,
      makeDeps()
    );
    var args = mockSearchEmails.mock.calls[0][0];
    expect(args.query).toBe("from:alice");
    expect(args.maxResults).toBe(7);
    expect(args.pageToken).toBe("tok");
  });

  it("gmail_get_action_required forwards labels, subjectPatterns, maxResults", async function () {
    mockGetActionRequired.mockResolvedValue({ emails: [], total: 0 });
    await gmailGetActionRequired(
      {
        labels: ["IMPORTANT"],
        subjectPatterns: ["urgent"],
        maxResults: 5
      } as any,
      makeDeps()
    );
    var args = mockGetActionRequired.mock.calls[0][0];
    expect(args.labels).toEqual(["IMPORTANT"]);
    expect(args.subjectPatterns).toEqual(["urgent"]);
    expect(args.maxResults).toBe(5);
  });
});
