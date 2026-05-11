/**
 * Unit tests for the --benchmark flag on `sinc refresh`.
 *
 * Two layers:
 *   1. BenchmarkCollector in isolation — covers p50/p95/max math and the
 *      formatSummary string the CLI prints.
 *   2. refreshAllFiles wired to a collector — asserts startScope/endScope
 *      bookends the scope and that filesWritten/filesUnchanged match what
 *      refresh actually did.
 *
 * The axios interceptor hook (snClient.setBenchmarkSink) is exercised by the
 * real-run integration against workstudio — not here. This suite covers the
 * collector contract and the appUtils lifecycle.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { BenchmarkCollector } from "../benchmark";

// ---------- mocks for refreshAllFiles test (must come before importing) ----

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  getLogLevel: function () { return "warn"; },
};

var mockFileLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

var mockClient = {
  getManifest: jest.fn(),
  getMissingFiles: jest.fn(),
};

jest.mock("../Logger", function () { return { logger: mockLogger }; });
jest.mock("../FileLogger", function () { return { fileLogger: mockFileLogger }; });
jest.mock("../snClient", function () {
  return {
    defaultClient: function () { return mockClient; },
    unwrapSNResponse: function (p: any) { return Promise.resolve(p).then(function (r: any) { return r; }); },
    processPushResponse: jest.fn(),
    retryOnErr: jest.fn(),
    retryOnHttpErr: jest.fn(),
    unwrapTableAPIFirstItem: jest.fn(),
    setBenchmarkSink: jest.fn(),
  };
});

var mockConfig: any = {
  getConfig: jest.fn().mockReturnValue({ scopes: { x_cadso_core: {} }, tableOptions: {} }),
  getManifest: jest.fn().mockResolvedValue({
    x_cadso_core: { scope: "x_cadso_core", tables: {} },
  }),
  getSourcePathForScope: jest.fn(),
  getSourcePath: jest.fn(),
  getManifestPath: jest.fn().mockReturnValue("/tmp/dove.manifest.json"),
  resolveConfigForScope: jest.fn().mockImplementation(function () {
    return { tables: ["sys_script_include"], fieldOverrides: {}, apiIncludes: {}, apiExcludes: {} };
  }),
  isMultiScopeManifest: jest.fn().mockReturnValue(true),
  updateManifest: jest.fn(),
};
jest.mock("../config", function () { return mockConfig; });

jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () { return { tick: jest.fn() }; });
});

jest.mock("../FileUtils", function () {
  var actual = jest.requireActual("../FileUtils");
  return Object.assign({}, actual, {
    writeScopeManifest: jest.fn().mockResolvedValue(undefined),
  });
});

import * as AppUtils from "../appUtils";

// ---------- collector unit tests ----------

describe("BenchmarkCollector", function () {
  test("formatSummary reports empty state when nothing recorded", function () {
    var collector = new BenchmarkCollector();
    var summary = collector.formatSummary();
    expect(summary).toContain("Refresh Benchmark");
    expect(summary).toContain("(no samples recorded)");
  });

  test("percentiles reflect the recorded latencies", function () {
    var collector = new BenchmarkCollector();
    // 10, 20, 30, ..., 100 — p50 at index 5 = 60, p95 at index 9 = 100.
    for (var i = 1; i <= 10; i++) {
      collector.recordHttp({
        path: "/api/test",
        tableCount: 1,
        durationMs: i * 10,
        statusCode: 200,
        responseBytes: 100,
      });
    }
    var summary = collector.formatSummary();
    expect(summary).toContain("p50 60ms");
    expect(summary).toContain("p95 100ms");
    expect(summary).toContain("max 100ms");
    expect(summary).toContain("10 HTTP requests");
  });

  test("scope samples record wall time, request counts, and file counts", function () {
    var collector = new BenchmarkCollector();
    collector.startScope("x_cadso_core");
    collector.recordHttp({
      path: "/api/bulkDownload",
      tableCount: 3,
      durationMs: 50,
      statusCode: 200,
      responseBytes: 2048,
    });
    collector.recordHttp({
      path: "/api/bulkDownload",
      tableCount: 3,
      durationMs: 80,
      statusCode: 200,
      responseBytes: 4096,
    });
    collector.endScope(7, 42);

    var scopes = collector.getScopeSamples();
    expect(scopes).toHaveLength(1);
    expect(scopes[0].scopeName).toBe("x_cadso_core");
    expect(scopes[0].httpRequests).toBe(2);
    expect(scopes[0].totalResponseBytes).toBe(2048 + 4096);
    expect(scopes[0].filesWritten).toBe(7);
    expect(scopes[0].filesUnchanged).toBe(42);
    expect(scopes[0].wallTimeMs).toBeGreaterThanOrEqual(0);

    var summary = collector.formatSummary();
    expect(summary).toContain("x_cadso_core:");
    expect(summary).toContain("7 written / 42 unchanged");
  });

  test("formatBytes switches units at KB and MB thresholds", function () {
    var collector = new BenchmarkCollector();
    collector.recordHttp({ path: "/a", tableCount: 1, durationMs: 1, statusCode: 200, responseBytes: 500 });
    expect(collector.formatSummary()).toContain("500B received");

    var collector2 = new BenchmarkCollector();
    collector2.recordHttp({ path: "/a", tableCount: 1, durationMs: 1, statusCode: 200, responseBytes: 2048 });
    expect(collector2.formatSummary()).toContain("2.0KB received");

    var collector3 = new BenchmarkCollector();
    collector3.recordHttp({ path: "/a", tableCount: 1, durationMs: 1, statusCode: 200, responseBytes: 2 * 1024 * 1024 });
    expect(collector3.formatSummary()).toContain("2.00MB received");
  });

  test("endScope is a no-op when no scope is active", function () {
    var collector = new BenchmarkCollector();
    collector.endScope(5, 5);
    expect(collector.getScopeSamples()).toHaveLength(0);
  });
});

// ---------- refreshAllFiles integration with collector ----------

describe("refreshAllFiles — benchmarkCollector lifecycle", function () {
  var tmpRoot: string;

  beforeEach(function () {
    jest.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sinc-bench-test-"));
    mockConfig.getSourcePathForScope.mockReturnValue(tmpRoot);
    mockConfig.getSourcePath.mockReturnValue(tmpRoot);
  });

  afterEach(function () {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  test("endScope captures filesWritten and filesUnchanged for a refresh pass", async function () {
    // "Stale" file — content diverges from what the mock returns → will be written.
    fs.mkdirSync(path.join(tmpRoot, "sys_script_include", "StaleRec"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "sys_script_include", "StaleRec", "script.js"),
      "var x = 1;",
    );
    // "Matching" file — content matches → counted as unchanged.
    fs.mkdirSync(path.join(tmpRoot, "sys_script_include", "SameRec"), { recursive: true });
    var matching = "var same = true;";
    fs.writeFileSync(
      path.join(tmpRoot, "sys_script_include", "SameRec", "script.js"),
      matching,
    );

    var manifest = {
      scope: "x_cadso_core",
      tables: {
        sys_script_include: {
          records: {
            StaleRec: { name: "StaleRec", sys_id: "sysid_Stale", files: [{ name: "script", type: "js" }] },
            SameRec: { name: "SameRec", sys_id: "sysid_Same", files: [{ name: "script", type: "js" }] },
          },
        },
      },
    };
    mockClient.getManifest.mockResolvedValue(manifest);
    mockClient.getMissingFiles.mockResolvedValue({
      sys_script_include: {
        records: {
          StaleRec: {
            name: "StaleRec", sys_id: "sysid_Stale",
            files: [{ name: "script", type: "js", content: "var x = 99; // new from instance" }],
          },
          SameRec: {
            name: "SameRec", sys_id: "sysid_Same",
            files: [{ name: "script", type: "js", content: matching }],
          },
        },
      },
    });

    var collector = new BenchmarkCollector();
    collector.startScope("x_cadso_core");

    await AppUtils.refreshAllFiles(manifest as any, tmpRoot, {
      benchmarkCollector: collector,
    });

    var scopes = collector.getScopeSamples();
    expect(scopes).toHaveLength(1);
    expect(scopes[0].scopeName).toBe("x_cadso_core");
    // One file had divergent content → written. One matched → unchanged.
    expect(scopes[0].filesWritten).toBe(1);
    expect(scopes[0].filesUnchanged).toBe(1);
  });

  test("endScope(0, 0) on error path so the collector still closes cleanly", async function () {
    mockClient.getMissingFiles.mockRejectedValue(new Error("boom"));

    var manifest = {
      scope: "x_cadso_core",
      tables: {
        sys_script_include: {
          records: {
            Rec: { name: "Rec", sys_id: "sysid_Rec", files: [{ name: "script", type: "js" }] },
          },
        },
      },
    };

    var collector = new BenchmarkCollector();
    collector.startScope("x_cadso_core");

    await expect(
      AppUtils.refreshAllFiles(manifest as any, tmpRoot, { benchmarkCollector: collector }),
    ).rejects.toThrow("boom");

    var scopes = collector.getScopeSamples();
    expect(scopes).toHaveLength(1);
    expect(scopes[0].filesWritten).toBe(0);
    expect(scopes[0].filesUnchanged).toBe(0);
  });
});
