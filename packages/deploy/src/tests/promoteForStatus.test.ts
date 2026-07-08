import { promoteForStatus } from "../promoteForStatus";
import type {
  Commenter,
  PromoteResult,
  Promoter,
  PromotionLadder,
  SnReader,
} from "../types";

function ladder(): PromotionLadder {
  return {
    taskIdPattern: "(DEV-[a-z0-9]+)",
    instances: {
      studio: { url: "tenonworkstudio", environment: "e", enabled: true },
      yard: { url: "tenonworkyard", environment: "e", enabled: true },
    },
    statusMap: {
      "push to yard": {
        clickupStatusId: "s1",
        sourceInstance: "studio",
        targetInstance: "yard",
        transport: "sawmill",
        enabled: true,
      },
      "push to mill": {
        clickupStatusId: "s2",
        sourceInstance: "yard",
        targetInstance: "mill",
        transport: "sawmill",
        enabled: false,
      },
    },
    skipPreviewErrors: [],
  };
}

var okResult: PromoteResult = {
  remoteUpdateSetSysId: "r",
  previewErrors: [],
  committed: true,
  elapsedMs: 1,
};

function sourceReaderWith(names: string[]): SnReader {
  return {
    query: function () {
      return Promise.resolve(
        names.map(function (n, idx) {
          return {
            sys_id: "id" + idx,
            name: n,
            application: { value: "scope" + idx },
            state: "complete",
          };
        }),
      );
    },
  };
}

var emptyReader: SnReader = {
  query: function () {
    return Promise.resolve([]);
  },
};

function recordingPromoter(): {
  promoter: Promoter;
  calls: Array<{ commit: boolean; name: string }>;
} {
  var calls: Array<{ commit: boolean; name: string }> = [];
  var promoter: Promoter = {
    promote: function (p) {
      calls.push({ commit: p.commit, name: p.updateSetName });
      return Promise.resolve(okResult);
    },
  };
  return { promoter: promoter, calls: calls };
}

describe("promoteForStatus", function () {
  it("promotes every scope's set — preview then commit each", async function () {
    var rec = recordingPromoter();
    var out = await promoteForStatus({
      status: "push to yard",
      taskId: "DEV-847",
      config: ladder(),
      sourceReader: sourceReaderWith(["DEV-847 — Core", "DEV-847 — Cloud"]),
      targetReader: emptyReader,
      promoter: rec.promoter,
    });
    expect(out.kind).toBe("promoted");
    if (out.kind === "promoted") {
      expect(out.outcomes.length).toBe(2);
    }
    expect(rec.calls.length).toBe(4);
    expect(
      rec.calls.filter(function (c) {
        return c.commit;
      }).length,
    ).toBe(2);
  });

  it("skips a status that is not a promotion status", async function () {
    var out = await promoteForStatus({
      status: "in qa",
      taskId: "DEV-847",
      config: ladder(),
      sourceReader: emptyReader,
      targetReader: emptyReader,
      promoter: recordingPromoter().promoter,
    });
    expect(out.kind).toBe("skipped");
  });

  it("skips a disabled edge", async function () {
    var out = await promoteForStatus({
      status: "push to mill",
      taskId: "DEV-847",
      config: ladder(),
      sourceReader: emptyReader,
      targetReader: emptyReader,
      promoter: recordingPromoter().promoter,
    });
    expect(out.kind).toBe("skipped");
  });

  it("rejects a malformed task id before any query", async function () {
    var throwing: SnReader = {
      query: function () {
        throw new Error("should not be called");
      },
    };
    var out = await promoteForStatus({
      status: "push to yard",
      taskId: "not-a-task",
      config: ladder(),
      sourceReader: throwing,
      targetReader: throwing,
      promoter: recordingPromoter().promoter,
    });
    expect(out.kind).toBe("invalid-task-id");
  });

  it("blocks on a preview error not in the allowlist and never commits", async function () {
    var calls: Array<{ commit: boolean }> = [];
    var promoter: Promoter = {
      promote: function (p) {
        calls.push({ commit: p.commit });
        if (!p.commit) {
          return Promise.resolve({
            remoteUpdateSetSysId: "r",
            previewErrors: [{ type: "DATA_LOSS", message: "boom" }],
            committed: false,
            elapsedMs: 1,
          });
        }
        return Promise.resolve(okResult);
      },
    };
    var out = await promoteForStatus({
      status: "push to yard",
      taskId: "DEV-847",
      config: ladder(),
      sourceReader: sourceReaderWith(["DEV-847 — Core"]),
      targetReader: emptyReader,
      promoter: promoter,
    });
    expect(out.kind).toBe("preview-blocked");
    expect(
      calls.some(function (c) {
        return c.commit;
      }),
    ).toBe(false);
  });

  it("is idempotent — an already-committed set is skipped", async function () {
    var rec = recordingPromoter();
    var targetReader: SnReader = {
      query: function () {
        return Promise.resolve([
          { sys_id: "t", name: "DEV-847 — Core", state: "complete" },
        ]);
      },
    };
    var out = await promoteForStatus({
      status: "push to yard",
      taskId: "DEV-847",
      config: ladder(),
      sourceReader: sourceReaderWith(["DEV-847 — Core"]),
      targetReader: targetReader,
      promoter: rec.promoter,
    });
    expect(out.kind).toBe("promoted");
    if (out.kind === "promoted") {
      expect(out.outcomes[0].status).toBe("already");
    }
    expect(rec.calls.length).toBe(0);
  });

  it("posts a confirmation comment when a commenter is supplied", async function () {
    var posted: Array<{ taskId: string; text: string }> = [];
    var commenter: Commenter = {
      postComment: function (p) {
        posted.push(p);
        return Promise.resolve();
      },
    };
    await promoteForStatus({
      status: "push to yard",
      taskId: "DEV-847",
      config: ladder(),
      sourceReader: sourceReaderWith(["DEV-847 — Core"]),
      targetReader: emptyReader,
      promoter: recordingPromoter().promoter,
      commenter: commenter,
    });
    expect(posted.length).toBe(1);
    expect(posted[0].text).toMatch(/push to yard/);
  });
});
