import { computeDrift, semverGt, eventFilename, ReleaseManifest, DocLedger } from "../knowledgeDiff";

describe("semverGt", function () {
  it("compares x.y.z numerically (not lexically)", function () {
    expect(semverGt("0.0.13", "0.0.12")).toBe(true);
    expect(semverGt("0.0.12", "0.0.12")).toBe(false);
    expect(semverGt("0.1.0", "0.0.99")).toBe(true);
    expect(semverGt("1.0.0", "0.9.9")).toBe(true);
    expect(semverGt("0.0.2", "0.0.10")).toBe(false);
  });
});

describe("eventFilename", function () {
  it("strips the npm scope and appends the version", function () {
    expect(
      eventFilename({
        event_id: "x",
        package: "@tenonhq/dovetail-clickup",
        version: "0.0.13",
        prev_version: "0.0.12",
      }),
    ).toBe("dovetail-clickup@0.0.13.json");
  });
});

describe("computeDrift", function () {
  const manifest: ReleaseManifest = {
    events: [
      {
        event_id: "dovetail-clickup@0.0.13",
        package: "@tenonhq/dovetail-clickup",
        version: "0.0.13",
        prev_version: "0.0.12",
      },
      {
        event_id: "dovetail-core@0.0.93",
        package: "@tenonhq/dovetail-core",
        version: "0.0.93",
        prev_version: "0.0.92",
      },
      {
        event_id: "dovetail-gmail@0.0.11",
        package: "@tenonhq/dovetail-gmail",
        version: "0.0.11",
        prev_version: "0.0.10",
      },
    ],
  };
  const ledger: DocLedger = {
    packages: {
      "@tenonhq/dovetail-clickup": { documented_version: "0.0.12" },
      "@tenonhq/dovetail-core": { documented_version: "0.0.93" },
    },
  };

  it("returns events newer than the ledger; undocumented packages count as drift", function () {
    const ids = computeDrift(manifest, ledger, { watch_packages: [] }).map(function (e) {
      return e.event_id;
    });
    expect(ids).toContain("dovetail-clickup@0.0.13"); // 0.0.13 > 0.0.12
    expect(ids).toContain("dovetail-gmail@0.0.11"); // not in ledger yet
    expect(ids).not.toContain("dovetail-core@0.0.93"); // equal to documented
  });

  it("limits to watch_packages when the set is non-empty", function () {
    const drift = computeDrift(manifest, ledger, {
      watch_packages: ["@tenonhq/dovetail-clickup"],
    });
    expect(drift.length).toBe(1);
    expect(drift[0].package).toBe("@tenonhq/dovetail-clickup");
  });

  it("excludes ignore_packages", function () {
    const ids = computeDrift(manifest, ledger, {
      watch_packages: [],
      ignore_packages: ["@tenonhq/dovetail-gmail"],
    }).map(function (e) {
      return e.event_id;
    });
    expect(ids).not.toContain("dovetail-gmail@0.0.11");
    expect(ids).toContain("dovetail-clickup@0.0.13");
  });

  it("is deterministically sorted by package+version", function () {
    const ids = computeDrift(manifest, ledger, {}).map(function (e) {
      return e.event_id;
    });
    expect(ids).toEqual(["dovetail-clickup@0.0.13", "dovetail-gmail@0.0.11"]);
  });
});
