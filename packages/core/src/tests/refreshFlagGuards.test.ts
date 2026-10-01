/**
 * Coverage for the `dove refresh` flag guards and the filesystem predicate the
 * `--metadata-only` skip depends on.
 *
 * Both were gaps found reviewing the metaData work after it shipped:
 *
 *   1. `--metadata-only` + `--force` is contradictory (one writes no field file,
 *      the other overwrites every field file). refreshCommand refuses the
 *      combination, but that refusal was user-facing behaviour with zero tests.
 *
 *   2. `isDirectory` REJECTS on a missing path rather than returning false, and
 *      `processBatched` propagates — which aborted an entire scope on the first
 *      record present on the instance but absent from the branch. That is the
 *      common case for `--metadata-only`, not an edge one. `isExistingDirectory`
 *      is the guarded predicate; these tests pin the contract of all three so
 *      the next caller picks the right one deliberately.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  setLogLevel: jest.fn(),
  getLogLevel: function () { return "warn"; },
};

jest.mock("../Logger", function () { return { logger: mockLogger }; });
jest.mock("../FileLogger", function () {
  return { fileLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
});
jest.mock("../snClient", function () {
  return {
    defaultClient: function () { return { getManifest: jest.fn(), getMissingFiles: jest.fn() }; },
    unwrapSNResponse: function (p: any) { return Promise.resolve(p); },
    processPushResponse: jest.fn(),
    retryOnErr: jest.fn(),
    retryOnHttpErr: jest.fn(),
    unwrapTableAPIFirstItem: jest.fn(),
  };
});
jest.mock("../config", function () {
  return {
    getConfig: jest.fn().mockReturnValue({ scopes: { x_cadso_core: {} }, tableOptions: {} }),
    getManifest: jest.fn().mockResolvedValue({}),
    getSourcePath: jest.fn(),
    getSourcePathForScope: jest.fn(),
    getManifestPath: jest.fn().mockReturnValue("/tmp/dove.manifest.json"),
    getScopeManifestPath: jest.fn().mockReturnValue("/tmp/dove.manifest.json"),
    resolveConfigForScope: jest.fn().mockReturnValue({
      tables: ["sys_script_include"],
      fieldOverrides: {},
      apiIncludes: {},
      apiExcludes: {},
    }),
    isMultiScopeManifest: jest.fn().mockReturnValue(true),
    updateManifest: jest.fn(),
  };
});
jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () { return { tick: jest.fn() }; });
});

import * as AppUtils from "../appUtils";
import * as fUtils from "../FileUtils";
import { refreshCommand } from "../commands";

describe("refresh — --metadata-only and --force are mutually exclusive", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    jest.spyOn(AppUtils, "syncManifest").mockResolvedValue(undefined as never);
  });

  afterEach(function () {
    jest.restoreAllMocks();
  });

  test("rejects the combination instead of silently picking one", async function () {
    // Silently honouring --force here would overwrite every field file from the
    // instance for someone who explicitly asked to touch nothing but metaData.
    await expect(
      refreshCommand({ metadataOnly: true, force: true } as never),
    ).rejects.toThrow(/--metadata-only cannot be combined with --force/);
  });

  test("does not reach syncManifest when the combination is refused", async function () {
    await expect(
      refreshCommand({ metadataOnly: true, force: true } as never),
    ).rejects.toThrow();
    expect(AppUtils.syncManifest).not.toHaveBeenCalled();
  });

  test("each flag on its own is accepted", async function () {
    await refreshCommand({ metadataOnly: true } as never);
    await refreshCommand({ force: true } as never);
    expect(AppUtils.syncManifest).toHaveBeenCalledTimes(2);
    expect((AppUtils.syncManifest as jest.Mock).mock.calls[0][1]).toMatchObject({
      metadataOnly: true,
      force: false,
    });
    expect((AppUtils.syncManifest as jest.Mock).mock.calls[1][1]).toMatchObject({
      metadataOnly: false,
      force: true,
    });
  });
});

describe("FileUtils directory predicates — pick the right one deliberately", function () {
  var tmpRoot: string;
  var dir: string;
  var file: string;
  var missing: string;

  beforeEach(function () {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dove-dirpred-"));
    dir = path.join(tmpRoot, "a-directory");
    file = path.join(tmpRoot, "a-file");
    missing = path.join(tmpRoot, "does-not-exist");
    fs.mkdirSync(dir);
    fs.writeFileSync(file, "x");
  });

  afterEach(function () {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  test("isExistingDirectory: true only for a real directory, never throws", async function () {
    expect(await fUtils.isExistingDirectory(dir)).toBe(true);
    expect(await fUtils.isExistingDirectory(file)).toBe(false);
    expect(await fUtils.isExistingDirectory(missing)).toBe(false);
  });

  test("isDirectory still REJECTS on a missing path (documented, relied on)", async function () {
    // getPathsInPath treats a missing path as an error rather than a file, so
    // this rejection is deliberate. Pinning it stops a well-meaning "fix" from
    // changing that behaviour silently.
    expect(await fUtils.isDirectory(dir)).toBe(true);
    expect(await fUtils.isDirectory(file)).toBe(false);
    await expect(fUtils.isDirectory(missing)).rejects.toThrow();
  });

  test("pathExists is true for a plain file — why it is the wrong write-target check", async function () {
    expect(await fUtils.pathExists(file)).toBe(true);
    expect(await fUtils.isExistingDirectory(file)).toBe(false);
  });
});
