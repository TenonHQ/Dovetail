import { buildBaseUrl } from "../client";

describe("buildBaseUrl", function () {
  it("appends .service-now.com to a bare instance subdomain", function () {
    expect(buildBaseUrl("tenonworkyard")).toBe(
      "https://tenonworkyard.service-now.com"
    );
  });

  it("treats a full host as complete — never doubles .service-now.com", function () {
    expect(buildBaseUrl("tenonworkyard.service-now.com")).toBe(
      "https://tenonworkyard.service-now.com"
    );
  });

  it("uses an https:// URL as-is", function () {
    expect(buildBaseUrl("https://tenonworkyard.service-now.com")).toBe(
      "https://tenonworkyard.service-now.com"
    );
  });

  it("uses an http:// URL as-is", function () {
    expect(buildBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("strips trailing slashes from a URL", function () {
    expect(buildBaseUrl("https://tenonworkyard.service-now.com/")).toBe(
      "https://tenonworkyard.service-now.com"
    );
  });

  it("strips trailing slashes from a full host", function () {
    expect(buildBaseUrl("tenonworkyard.service-now.com/")).toBe(
      "https://tenonworkyard.service-now.com"
    );
  });
});
