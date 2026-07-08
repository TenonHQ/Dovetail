/**
 * Regression: the refresh path must write filesystem-SAFE folder names.
 *
 * normalizeManifestKeys() (PR #117) re-keys the manifest object so a record
 * with a Windows-illegal display name (e.g. a table-wildcard ACL named
 * `x_cadso_work_campaign.*`) maps to its sys_id. But the refresh writer
 * (`refreshAllFiles`) builds folders from the raw `getMissingFiles`
 * (bulkDownload) server response, whose `.name` is the unmodified display
 * name — so it recreated the illegal `<table>.*` folders on every refresh,
 * silently breaking the folder ≡ manifest-key invariant and aborting
 * `git clone` on Windows.
 *
 * These tests assert the writer routes through toSafeFolderName: a `.*` ACL
 * record lands in a sys_id folder, while a safe name stays human-readable.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------- mocks (must come before importing the module under test) ----------

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  getLogLevel: function () {
    return "warn";
  },
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

jest.mock("../Logger", function () {
  return { logger: mockLogger };
});
jest.mock("../FileLogger", function () {
  return { fileLogger: mockFileLogger };
});
jest.mock("../snClient", function () {
  return {
    defaultClient: function () {
      return mockClient;
    },
    unwrapSNResponse: function (p: any) {
      return Promise.resolve(p).then(function (r: any) {
        return r;
      });
    },
    processPushResponse: jest.fn(),
    retryOnErr: jest.fn(),
    retryOnHttpErr: jest.fn(),
    unwrapTableAPIFirstItem: jest.fn(),
  };
});

var mockConfig: any = {
  getConfig: jest.fn().mockReturnValue({
    scopes: { x_cadso_work: {} },
    tableOptions: {},
  }),
  getManifest: jest.fn().mockResolvedValue({
    x_cadso_work: { scope: "x_cadso_work", tables: {} },
  }),
  getSourcePathForScope: jest.fn(),
  getSourcePath: jest.fn(),
  getManifestPath: jest.fn().mockReturnValue("/tmp/dove.manifest.json"),
  resolveConfigForScope: jest.fn().mockImplementation(function () {
    return {
      tables: ["sys_security_acl"],
      fieldOverrides: {},
      apiIncludes: {},
      apiExcludes: {},
    };
  }),
  isMultiScopeManifest: jest.fn().mockReturnValue(true),
  updateManifest: jest.fn(),
};

jest.mock("../config", function () {
  return mockConfig;
});

jest.mock("progress", function () {
  return jest.fn().mockImplementation(function () {
    return { tick: jest.fn() };
  });
});

// Keep real FileUtils so we assert against the actual file system; stub only
// writeScopeManifest so no manifest file is written.
jest.mock("../FileUtils", function () {
  var actual = jest.requireActual("../FileUtils");
  return Object.assign({}, actual, {
    writeScopeManifest: jest.fn().mockResolvedValue(undefined),
  });
});

import * as AppUtils from "../appUtils";

// ---------- helpers ----------

var tmpRoot: string;
var ACL_SYS_ID = "bc91c2a5f334621048dff31590812771";

function listAclFolders(): string[] {
  var dir = path.join(tmpRoot, "sys_security_acl");
  try {
    return fs.readdirSync(dir).sort();
  } catch (e) {
    return [];
  }
}

describe("refresh — folder names are filesystem-safe (sys_id fallback)", function () {
  beforeEach(function () {
    jest.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dove-safe-folder-"));
    mockConfig.getSourcePathForScope.mockReturnValue(tmpRoot);
    mockConfig.getSourcePath.mockReturnValue(tmpRoot);
  });

  afterEach(function () {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (e) {}
  });

  test("a `<table>.*` ACL record is written to its sys_id folder, never `.*`", async function () {
    // Manifest as the server returns it: keyed by the illegal display name.
    // normalizeManifestKeys re-keys this to sys_id inside syncManifest.
    mockClient.getManifest.mockResolvedValue({
      scope: "x_cadso_work",
      tables: {
        sys_security_acl: {
          records: {
            "x_cadso_work_campaign.*": {
              name: "x_cadso_work_campaign.*",
              sys_id: ACL_SYS_ID,
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    });

    // bulkDownload echoes the RAW display name back — the bug source. The
    // writer must not trust it for the folder path.
    mockClient.getMissingFiles.mockResolvedValue({
      sys_security_acl: {
        records: {
          "x_cadso_work_campaign.*": {
            name: "x_cadso_work_campaign.*",
            sys_id: ACL_SYS_ID,
            files: [{ name: "script", type: "js", content: "// acl" }],
          },
        },
      },
    });

    await AppUtils.syncManifest("x_cadso_work");

    var folders = listAclFolders();
    expect(folders).toContain(ACL_SYS_ID);
    expect(folders).not.toContain("x_cadso_work_campaign.*");
    // The file landed inside the sys_id folder.
    expect(
      fs.readFileSync(
        path.join(tmpRoot, "sys_security_acl", ACL_SYS_ID, "script.js"),
        "utf8",
      ),
    ).toBe("// acl");
  });

  test("a filesystem-safe ACL name stays human-readable (no needless sys_id fallback)", async function () {
    var SAFE_SYS_ID = "aa11bb22cc33dd44ee55ff6600112233";
    mockClient.getManifest.mockResolvedValue({
      scope: "x_cadso_work",
      tables: {
        sys_security_acl: {
          records: {
            x_cadso_work_campaign: {
              name: "x_cadso_work_campaign",
              sys_id: SAFE_SYS_ID,
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    });
    mockClient.getMissingFiles.mockResolvedValue({
      sys_security_acl: {
        records: {
          x_cadso_work_campaign: {
            name: "x_cadso_work_campaign",
            sys_id: SAFE_SYS_ID,
            files: [{ name: "script", type: "js", content: "// safe" }],
          },
        },
      },
    });

    await AppUtils.syncManifest("x_cadso_work");

    var folders = listAclFolders();
    expect(folders).toContain("x_cadso_work_campaign");
    expect(folders).not.toContain(SAFE_SYS_ID);
  });
});
