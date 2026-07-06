import {
  resolveUpdateSets,
  nameMatchesTaskId,
  buildUpdateSetQuery,
} from "../resolveUpdateSets";
import type { PromotionLadder, SnReader } from "../types";

function ladder(): PromotionLadder {
  return {
    taskIdPattern: "(DEV-[a-z0-9]+)",
    instances: { studio: { url: "x", environment: "e", enabled: true } },
    statusMap: {},
  };
}

function readerReturning(rows: Array<Record<string, unknown>>): SnReader {
  return {
    query: function () {
      return Promise.resolve(rows);
    },
  };
}

describe("nameMatchesTaskId", function () {
  it("matches at a word boundary but not a longer id", function () {
    expect(
      nameMatchesTaskId({ name: "DEV-847 — Foo", taskId: "DEV-847" }),
    ).toBe(true);
    expect(nameMatchesTaskId({ name: "DEV-847-foo", taskId: "DEV-847" })).toBe(
      true,
    );
    expect(
      nameMatchesTaskId({ name: "DEV-8470 — Bar", taskId: "DEV-847" }),
    ).toBe(false);
    expect(nameMatchesTaskId({ name: "Foo DEV-847", taskId: "DEV-847" })).toBe(
      false,
    );
  });
});

describe("buildUpdateSetQuery", function () {
  it("anchors on STARTSWITH and defaults to complete", function () {
    expect(buildUpdateSetQuery({ taskId: "DEV-847" })).toBe(
      "nameSTARTSWITHDEV-847^state=complete",
    );
  });
});

describe("resolveUpdateSets", function () {
  it("returns one set per scope (multi-set is the norm)", async function () {
    var reader = readerReturning([
      {
        sys_id: "a",
        name: "DEV-847 — Core",
        application: { value: "scopeCore" },
        state: "complete",
      },
      {
        sys_id: "b",
        name: "DEV-847 — Cloud",
        application: { value: "scopeCloud" },
        state: "complete",
      },
    ]);
    var out = await resolveUpdateSets({
      reader: reader,
      taskId: "DEV-847",
      config: ladder(),
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.updateSets.length).toBe(2);
      expect(out.updateSets[0].scope).toBe("scopeCore");
    }
  });

  it("excludes a longer-id collision (DEV-8470 for DEV-847)", async function () {
    var reader = readerReturning([
      {
        sys_id: "a",
        name: "DEV-8470 — Other",
        application: { value: "s" },
        state: "complete",
      },
    ]);
    var out = await resolveUpdateSets({
      reader: reader,
      taskId: "DEV-847",
      config: ladder(),
    });
    expect(out.kind).toBe("not-found");
  });

  it("flags a same-scope collision as ambiguous", async function () {
    var reader = readerReturning([
      {
        sys_id: "a",
        name: "DEV-847 — one",
        application: { value: "same" },
        state: "complete",
      },
      {
        sys_id: "b",
        name: "DEV-847 — two",
        application: { value: "same" },
        state: "complete",
      },
    ]);
    var out = await resolveUpdateSets({
      reader: reader,
      taskId: "DEV-847",
      config: ladder(),
    });
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.scope).toBe("same");
      expect(out.candidates.length).toBe(2);
    }
  });

  it("returns not-found when nothing matches", async function () {
    var out = await resolveUpdateSets({
      reader: readerReturning([]),
      taskId: "DEV-847",
      config: ladder(),
    });
    expect(out.kind).toBe("not-found");
  });
});
