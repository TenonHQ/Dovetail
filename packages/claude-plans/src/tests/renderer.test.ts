import { renderStructured, StructuredPlan } from "../renderer";

describe("renderStructured", () => {
  it("returns empty string for missing sections", () => {
    expect(renderStructured({ sections: [] })).toBe('<div class="cp-structured">\n</div>');
  });

  it("wraps output in cp-structured", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "text", content: "hello" }]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-structured");
    expect(html).toContain("hello");
  });

  it("renders header with title and subtitle", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "header", title: "My Plan", subtitle: "A subtitle" }]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-header");
    expect(html).toContain("My Plan");
    expect(html).toContain("A subtitle");
    expect(html).toContain("cp-c-header-sub");
  });

  it("renders header without subtitle", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "header", title: "Only Title" }]
    };
    var html = renderStructured(plan);
    expect(html).not.toContain("cp-c-header-sub");
  });

  it("renders meta rows with badge", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "meta",
          title: "Details",
          rows: [
            { label: "Branch", value: "main" },
            { label: "Status", value: "APPROVED", badge: "success" }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-meta");
    expect(html).toContain("Branch");
    expect(html).toContain("cp-c-badge-success");
    expect(html).toContain("APPROVED");
  });

  it("renders callout with variant and icon", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "callout", variant: "warning", title: "Heads up", message: "Be careful" }]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-callout-warning");
    expect(html).toContain("Heads up");
    expect(html).toContain("Be careful");
    expect(html).toContain("cp-c-callout-icon");
  });

  it("renders checklist with done and pending items", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "checklist",
          title: "Tasks",
          items: [
            { label: "Done task", done: true, note: "v1.2" },
            { label: "Pending task", done: false }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-checklist");
    expect(html).toContain("cp-c-check-done");
    expect(html).toContain("Done task");
    expect(html).toContain("Pending task");
    expect(html).toContain("v1.2");
  });

  it("renders pipeline steps with correct status classes", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "steps",
          title: "Pipeline",
          steps: [
            { label: "DEV", status: "done" },
            { label: "TEST", status: "active" },
            { label: "PROD", status: "pending" }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-step-done");
    expect(html).toContain("cp-c-step-active");
    expect(html).toContain("cp-c-step-pending");
    expect(html).toContain("cp-c-step-line");
  });

  it("marks step connector filled when left step is done and right is active", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "steps",
          steps: [
            { label: "DEV", status: "done" },
            { label: "TEST", status: "active" }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-step-line-filled");
  });

  it("does not mark connector filled when right step is pending", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "steps",
          steps: [
            { label: "DEV", status: "done" },
            { label: "PROD", status: "pending" }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).not.toContain("cp-c-step-line-filled");
  });

  it("marks connector filled when right step is error (error is active, not pending)", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "steps",
          steps: [
            { label: "DEV", status: "done" },
            { label: "TEST", status: "error" }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-step-line-filled");
  });

  it("renders metrics grid", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "metrics",
          items: [
            { label: "Tests", value: "142", sub: "all pass", variant: "success" },
            { label: "Coverage", value: "94%" }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-metrics");
    expect(html).toContain("cp-c-metric-success");
    expect(html).toContain("142");
    expect(html).toContain("all pass");
    expect(html).toContain("94%");
  });

  it("renders section divider", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "section", title: "Phase 2" }]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-section-divider");
    expect(html).toContain("Phase 2");
  });

  it("renders table with headers and rows", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "table",
          title: "Files",
          headers: ["File", "Status"],
          rows: [["foo.ts", "modified"], ["bar.ts", "new"]]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-table");
    expect(html).toContain("<th>File</th>");
    expect(html).toContain("foo.ts");
    expect(html).toContain("modified");
  });

  it("renders text with newlines as br", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "text", content: "line one\nline two" }]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-text");
    expect(html).toContain("line one<br>line two");
  });

  it("renders code block with lang and title", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "code", title: "Deploy script", lang: "bash", content: "npm run deploy" }]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-code-wrap");
    expect(html).toContain("cp-c-code-title");
    expect(html).toContain("bash");
    expect(html).toContain("npm run deploy");
  });

  it("escapes HTML in user-supplied strings", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "text", content: '<script>alert("xss")</script>' }]
    };
    var html = renderStructured(plan);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("silently skips unknown section types", () => {
    var plan = {
      sections: [{ type: "unknown-thing", title: "ignored" } as any]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-structured");
    expect(html).not.toContain("ignored");
  });

  it("handles multiple section types in one plan", () => {
    var plan: StructuredPlan = {
      sections: [
        { type: "header", title: "Full Plan" },
        { type: "meta", rows: [{ label: "Env", value: "prod" }] },
        { type: "callout", message: "Take care" },
        { type: "checklist", items: [{ label: "Done", done: true }] },
        { type: "metrics", items: [{ label: "Score", value: "A+" }] }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-header");
    expect(html).toContain("cp-c-meta");
    expect(html).toContain("cp-c-callout");
    expect(html).toContain("cp-c-checklist");
    expect(html).toContain("cp-c-metrics");
  });

  it("renders tags with color classes and falls back to sage", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "tags",
          title: "Labels",
          items: [
            { label: "backend", color: "blue" },
            { label: "uncolored" },
            { label: "bad", color: "chartreuse" as any }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-tag-list");
    expect(html).toContain("cp-c-tag-blue");
    expect(html).toContain("backend");
    // both the uncolored and the invalid-colored tag fall back to sage
    expect((html.match(/cp-c-tag-sage/g) || []).length).toBe(2);
  });

  it("renders timeline events with status classes and optional fields", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "timeline",
          title: "History",
          events: [
            { label: "Kickoff", time: "Mon", status: "done" },
            { label: "Build", note: "in progress", status: "active" },
            { label: "Ship" }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-timeline");
    expect(html).toContain("cp-c-tl-done");
    expect(html).toContain("cp-c-tl-active");
    expect(html).toContain("cp-c-tl-pending");
    expect(html).toContain("Kickoff");
    expect(html).toContain("in progress");
  });

  it("renders progress bars with clamped percentage width", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "progress",
          items: [
            { label: "Half", value: 5, max: 10 },
            { label: "Over", value: 200, max: 100, variant: "success" },
            { label: "Default max", value: 25 }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-progress-track");
    expect(html).toContain("width:50%");
    expect(html).toContain("width:100%"); // clamped from 200%
    expect(html).toContain("width:25%"); // default max 100
    expect(html).toContain("cp-c-progress-success");
  });

  it("renders people with derived initials and avatar color", () => {
    var plan: StructuredPlan = {
      sections: [
        {
          type: "people",
          items: [
            { name: "Daniel Cudney", sublabel: "CTO", color: "emerald" },
            { name: "Trevor", color: "weird" as any }
          ]
        }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-person");
    expect(html).toContain("cp-c-avatar-emerald");
    expect(html).toContain(">DC<"); // initials from two-word name
    expect(html).toContain(">T<"); // initials from single name
    expect(html).toContain("cp-c-avatar-earthy"); // invalid color falls back
  });

  it("renders quote with optional cite", () => {
    var plan: StructuredPlan = {
      sections: [
        { type: "quote", text: "Measure twice.", cite: "The Joinery" },
        { type: "quote", text: "No cite here" }
      ]
    };
    var html = renderStructured(plan);
    expect(html).toContain("cp-c-quote");
    expect(html).toContain("Measure twice.");
    expect(html).toContain("cp-c-quote-cite");
    expect(html).toContain("The Joinery");
  });

  it("escapes HTML in new section types", () => {
    var plan: StructuredPlan = {
      sections: [{ type: "quote", text: "<img src=x onerror=alert(1)>" }]
    };
    var html = renderStructured(plan);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
