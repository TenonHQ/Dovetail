import { resolveDevInstance, toSubdomain } from "../resolveDevInstance";
import type { SnReader } from "../types";

var PATTERN = "^tenonwork[a-z0-9-]+$";

function sourcesReader(urls: string[]): SnReader {
  return {
    query: function () {
      return Promise.resolve(
        urls.map(function (u, i) {
          return { name: "src" + i, url: u, active: "true" };
        }),
      );
    },
  };
}

var throwingReader: SnReader = {
  query: function () {
    throw new Error("reader should not be queried");
  },
};

describe("toSubdomain", function () {
  it("reduces a full url to its subdomain", function () {
    expect(toSubdomain("https://tenonworkdev-will.service-now.com/x")).toBe(
      "tenonworkdev-will",
    );
  });
  it("lowercases and passes a bare subdomain through", function () {
    expect(toSubdomain("TenonWorkStudio")).toBe("tenonworkstudio");
  });
});

describe("resolveDevInstance", function () {
  it("resolves an instance registered on the target", async function () {
    var out = await resolveDevInstance({
      raw: "tenonworkdev-will",
      hostPattern: PATTERN,
      targetReader: sourcesReader(["https://tenonworkdev-will.service-now.com"]),
    });
    expect(out).toEqual({ ok: true, instance: "tenonworkdev-will" });
  });

  it("normalizes a URL-shaped value before matching", async function () {
    var out = await resolveDevInstance({
      raw: "https://tenonworkdev-will.service-now.com/nav_to.do",
      hostPattern: PATTERN,
      targetReader: sourcesReader(["tenonworkdev-will"]),
    });
    expect(out.ok).toBe(true);
  });

  it("rejects a missing value without querying", async function () {
    var out = await resolveDevInstance({
      raw: "",
      hostPattern: PATTERN,
      targetReader: throwingReader,
    });
    expect(out).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a value failing the host pattern without querying", async function () {
    var out = await resolveDevInstance({
      raw: "evil; DROP TABLE",
      hostPattern: PATTERN,
      targetReader: throwingReader,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("invalid-format");
    }
  });

  it("rejects an instance not registered on the target", async function () {
    var out = await resolveDevInstance({
      raw: "tenonworkrogue",
      hostPattern: PATTERN,
      targetReader: sourcesReader(["https://tenonworkdev-will.service-now.com"]),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("unregistered");
    }
  });
});
