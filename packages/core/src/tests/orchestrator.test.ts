import { normalizeInstance } from "../initSystem/corePlugin";

describe("normalizeInstance", function () {
  it("strips https:// prefix", function () {
    expect(normalizeInstance("https://mycompany.service-now.com")).toBe(
      "mycompany.service-now.com",
    );
  });

  it("strips http:// prefix", function () {
    expect(normalizeInstance("http://mycompany.service-now.com")).toBe(
      "mycompany.service-now.com",
    );
  });

  it("returns bare hostname without trailing slash", function () {
    expect(normalizeInstance("mycompany.service-now.com")).toBe(
      "mycompany.service-now.com",
    );
  });

  it("strips trailing slash if present", function () {
    expect(normalizeInstance("mycompany.service-now.com/")).toBe(
      "mycompany.service-now.com",
    );
  });

  it("trims whitespace", function () {
    expect(normalizeInstance("  mycompany.service-now.com  ")).toBe(
      "mycompany.service-now.com",
    );
  });

  it("handles full URL with protocol and trailing slash", function () {
    expect(normalizeInstance("https://mycompany.service-now.com/")).toBe(
      "mycompany.service-now.com",
    );
  });
});
