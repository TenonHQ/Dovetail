import { redactArgs } from "../redact";

describe("redactArgs", function () {
  it("returns primitives untouched", function () {
    expect(redactArgs(null)).toBeNull();
    expect(redactArgs(undefined)).toBeUndefined();
    expect(redactArgs(42)).toBe(42);
    expect(redactArgs(false)).toBe(false);
    expect(redactArgs("hello")).toBe("hello");
  });

  it("masks email-shaped strings", function () {
    var out = redactArgs({ from: "alice@example.com" }) as Record<string, string>;
    expect(out.from).toBe("ali***@example.com");
  });

  it("uses the full local part for emails with <=3 chars before @", function () {
    var out = redactArgs({ from: "ab@x.com" }) as Record<string, string>;
    expect(out.from).toBe("ab***@x.com");
  });

  it("redacts token-shaped keys regardless of value length", function () {
    var out = redactArgs({
      token: "abc",
      password: "shorty",
      refresh_token: "x",
      api_key: "y",
      authorization: "Bearer z"
    }) as Record<string, string>;
    expect(out.token).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.refresh_token).toBe("[REDACTED]");
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
  });

  it("redacts email-body keys", function () {
    var out = redactArgs({ body: "anything" }) as Record<string, string>;
    expect(out.body).toBe("[REDACTED:body]");
  });

  it("preserves operational query strings verbatim", function () {
    var out = redactArgs({
      query: "from:alice has:attachment subject:URGENT",
      sysparm_query: "active=true^stateIN1,2,3",
      q: "is:unread"
    }) as Record<string, string>;
    expect(out.query).toBe("from:alice has:attachment subject:URGENT");
    expect(out.sysparm_query).toBe("active=true^stateIN1,2,3");
    expect(out.q).toBe("is:unread");
  });

  it("hashes long free-form strings", function () {
    var long = "x".repeat(250);
    var out = redactArgs({ note: long }) as Record<string, string>;
    expect(out.note).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it("walks arrays and nested objects", function () {
    var out = redactArgs({
      items: [
        { from: "a@b.com", body: "hello" },
        { from: "c@d.com", token: "secret" }
      ]
    }) as { items: Array<Record<string, string>> };
    expect(out.items[0].from).toBe("a***@b.com");
    expect(out.items[0].body).toBe("[REDACTED:body]");
    expect(out.items[1].from).toBe("c***@d.com");
    expect(out.items[1].token).toBe("[REDACTED]");
  });

  it("does not mutate the original input", function () {
    var input = { from: "alice@example.com", body: "hi" };
    redactArgs(input);
    expect(input.from).toBe("alice@example.com");
    expect(input.body).toBe("hi");
  });
});
