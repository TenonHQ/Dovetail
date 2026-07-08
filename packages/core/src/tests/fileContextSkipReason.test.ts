// Mock config module before imports
var mockManifest: any = null;
var mockIsMultiScope = false;
var mockDetectedScope: string | undefined = undefined;
var mockScopeManifest: any = null;

jest.mock("../config", function () {
  return {
    getManifest: function () {
      return mockManifest;
    },
    isMultiScopeManifest: function () {
      return mockIsMultiScope;
    },
    resolveScopeFromPath: function () {
      return mockDetectedScope;
    },
    resolveManifestForScope: function () {
      return mockScopeManifest;
    },
  };
});

jest.mock("../FileLogger", function () {
  return { fileLogger: { log: jest.fn() } };
});

import { getFileContextWithSkipReason } from "../FileUtils";

describe("getFileContextWithSkipReason", function () {
  beforeEach(function () {
    mockManifest = null;
    mockIsMultiScope = false;
    mockDetectedScope = undefined;
    mockScopeManifest = null;
  });

  it("returns 'scope not found' when scope cannot be resolved in multi-scope mode", function () {
    mockManifest = { x_test: { tables: {} } };
    mockIsMultiScope = true;
    mockDetectedScope = undefined;

    var result = getFileContextWithSkipReason(
      "/project/src/x_unknown/sys_script_include/Test/script.js",
    );
    expect(result.context).toBeUndefined();
    expect(result.skipReason).toBe("scope not found");
  });

  it("returns 'scope manifest not found' when scope manifest is missing", function () {
    mockManifest = { x_test: { tables: {} } };
    mockIsMultiScope = true;
    mockDetectedScope = "x_missing";
    mockScopeManifest = undefined;

    var result = getFileContextWithSkipReason(
      "/project/src/x_missing/sys_script_include/Test/script.js",
    );
    expect(result.context).toBeUndefined();
    expect(result.skipReason).toBe("scope manifest not found");
  });

  it("returns 'not in manifest' when table is not in manifest", function () {
    mockManifest = {
      scope: "x_test",
      tables: {},
    };
    mockIsMultiScope = false;

    var result = getFileContextWithSkipReason(
      "/project/src/sys_script_include/TestRecord/script.js",
    );
    expect(result.context).toBeUndefined();
    expect(result.skipReason).toBe("not in manifest");
  });

  it("returns 'not in manifest' when record is not in manifest tables", function () {
    mockManifest = {
      scope: "x_test",
      tables: {
        sys_script_include: {
          records: {},
        },
      },
    };
    mockIsMultiScope = false;

    var result = getFileContextWithSkipReason(
      "/project/src/sys_script_include/MissingRecord/script.js",
    );
    expect(result.context).toBeUndefined();
    expect(result.skipReason).toBe("not in manifest");
  });

  it("returns 'not in manifest' when field is not found in record files", function () {
    mockManifest = {
      scope: "x_test",
      tables: {
        sys_script_include: {
          records: {
            TestRecord: {
              sys_id: "abc123",
              files: [{ name: "other_field" }],
            },
          },
        },
      },
    };
    mockIsMultiScope = false;

    var result = getFileContextWithSkipReason(
      "/project/src/sys_script_include/TestRecord/script.js",
    );
    expect(result.context).toBeUndefined();
    expect(result.skipReason).toBe("not in manifest");
  });

  it("returns context when file is found in manifest", function () {
    mockManifest = {
      scope: "x_test",
      tables: {
        sys_script_include: {
          records: {
            TestRecord: {
              sys_id: "abc123",
              files: [{ name: "script" }],
            },
          },
        },
      },
    };
    mockIsMultiScope = false;

    var result = getFileContextWithSkipReason(
      "/project/src/sys_script_include/TestRecord/script.js",
    );
    expect(result.skipReason).toBeUndefined();
    expect(result.context).toBeDefined();
    expect(result.context!.sys_id).toBe("abc123");
    expect(result.context!.tableName).toBe("sys_script_include");
    expect(result.context!.name).toBe("TestRecord");
    expect(result.context!.scope).toBe("x_test");
  });

  it("throws when no manifest is loaded", function () {
    mockManifest = null;

    expect(function () {
      getFileContextWithSkipReason(
        "/project/src/sys_script_include/Test/script.js",
      );
    }).toThrow("No manifest has been loaded!");
  });
});
