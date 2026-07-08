import { aggregateCategories, extractCategories } from "../categories";

describe("extractCategories — curated vocabulary", function () {
  it("detects ServiceNow from slug-style title", function () {
    var out = extractCategories({ title: "sn-cert-stability-triage" });
    expect(out).toContain("ServiceNow");
  });

  it("detects Mortise + Journey from title", function () {
    var out = extractCategories({
      title: "Mortise Journey component refactor",
    });
    expect(out).toContain("Mortise");
    expect(out).toContain("Journey");
  });

  it("detects Mailgun + Email", function () {
    var out = extractCategories({
      title: "Mailgun alerts email-spok integration",
    });
    expect(out).toContain("Mailgun");
    expect(out).toContain("Email");
  });

  it("detects SMS via textspoke / dlr / optin", function () {
    var out = extractCategories({ title: "fix-textspoke-dlr-handler" });
    expect(out).toContain("SMS");
  });

  it("detects ServiceNow from content_md when title is generic", function () {
    var out = extractCategories({
      title: "Generic fix",
      content_md:
        "Patch the x_cadso_core sys_script_include for the update set.",
    });
    expect(out).toContain("ServiceNow");
  });

  it("detects Dovetail from content_html (HTML stripped before match)", function () {
    var out = extractCategories({
      title: "Untitled",
      content_html:
        "<div class='cp-c'><p>Dovetail watch picks up changes.</p></div>",
    });
    expect(out).toContain("Dovetail");
  });

  it("detects Prompting via improve-prompt phrase", function () {
    var out = extractCategories({
      title: "improve-prompt skill — Daniel's playbook",
    });
    expect(out).toContain("Prompting");
  });

  it("detects DEV ticket pattern", function () {
    var out = extractCategories({
      title: "DEV-228 — Mid-Journey Split Insertion",
    });
    expect(out).toContain("DEV ticket");
    expect(out).toContain("Journey");
  });

  it("deduplicates labels even when title + content both hit the same pattern", function () {
    var out = extractCategories({
      title: "Mailgun email-spok",
      content_md: "Mailgun and email-spok and email-spok again",
    });
    var occurrences = out.filter(function (l) {
      return l === "Mailgun";
    }).length;
    expect(occurrences).toBe(1);
  });
});

describe("extractCategories — frequency fallback", function () {
  it("does NOT fire when curated returns >= 3 labels", function () {
    var out = extractCategories({
      title: "Mortise Journey ServiceNow Mailgun overhaul",
      content_md: "snowflake snowflake snowflake snowflake snowflake",
    });
    expect(out).not.toContain("snowflake");
  });

  it("fires when curated returns < 3 labels — surfaces frequent novel tokens", function () {
    var out = extractCategories({
      title: "Untitled work item",
      content_md:
        "snowflake schema snowflake schema snowflake bigquery bigquery",
    });
    expect(out).toEqual(expect.arrayContaining(["snowflake"]));
  });

  it("drops stop words from the fallback", function () {
    var out = extractCategories({
      title: "Untitled",
      content_md:
        "the the the the and and and and that that that that snowflake snowflake",
    });
    expect(out).not.toContain("the");
    expect(out).not.toContain("and");
    expect(out).not.toContain("that");
  });

  it("drops plan-noise words from the fallback", function () {
    var out = extractCategories({
      title: "Untitled",
      content_md: "plan plan plan plan step step step phase phase done done",
    });
    expect(out).not.toContain("plan");
    expect(out).not.toContain("step");
    expect(out).not.toContain("phase");
    expect(out).not.toContain("done");
  });

  it("ignores tokens with frequency < 2", function () {
    var out = extractCategories({
      title: "Untitled",
      content_md: "uniqueword onlyonce singleton mention",
    });
    expect(out).not.toContain("uniqueword");
  });
});

describe("extractCategories — output shape", function () {
  it("caps total labels at the maxCategories option (default 8)", function () {
    var out = extractCategories({
      title:
        "ServiceNow Mortise Sashimono Journey Dovetail ClickUp Mailgun Email SMS Sinch Sawmill React MCP Prompting Tooling Dashboard",
    });
    expect(out.length).toBeLessThanOrEqual(8);
  });

  it("honors a custom maxCategories", function () {
    var out = extractCategories(
      {
        title: "ServiceNow Mortise Dovetail Journey React MCP",
      },
      { maxCategories: 3 },
    );
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("orders curated labels by CURATED_VOCAB position (ServiceNow before Mortise)", function () {
    var out = extractCategories({
      title: "Mortise Journey ServiceNow",
    });
    expect(out.indexOf("ServiceNow")).toBeLessThan(out.indexOf("Mortise"));
  });

  it("returns an empty array for empty input", function () {
    expect(extractCategories({ title: "" })).toEqual([]);
  });

  it("returns at least 1 label for a clear single-topic title", function () {
    expect(extractCategories({ title: "Journey component bug" })).toContain(
      "Journey",
    );
  });
});

describe("aggregateCategories", function () {
  it("sums counts across plans, sorted desc by count then label", function () {
    var plans = [
      { categories: ["ServiceNow", "Mortise"] },
      { categories: ["ServiceNow"] },
      { categories: ["Mailgun", "ServiceNow"] },
      { categories: ["Mortise"] },
    ];
    var out = aggregateCategories(plans);
    expect(out).toEqual([
      { label: "ServiceNow", count: 3 },
      { label: "Mortise", count: 2 },
      { label: "Mailgun", count: 1 },
    ]);
  });

  it("handles plans missing the categories field", function () {
    var plans = [
      { categories: ["A"] },
      {},
      { categories: undefined },
      { categories: ["A", "B"] },
    ];
    var out = aggregateCategories(plans);
    expect(out).toEqual([
      { label: "A", count: 2 },
      { label: "B", count: 1 },
    ]);
  });

  it("returns an empty array when no plans have categories", function () {
    expect(aggregateCategories([{}, {}])).toEqual([]);
  });

  it("sorts ties alphabetically", function () {
    var plans = [
      { categories: ["B"] },
      { categories: ["A"] },
      { categories: ["C"] },
    ];
    var out = aggregateCategories(plans);
    expect(
      out.map(function (h) {
        return h.label;
      }),
    ).toEqual(["A", "B", "C"]);
  });
});
