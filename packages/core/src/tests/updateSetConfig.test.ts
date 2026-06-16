/**
 * TenonHQ/Dovetail#182: readUpdateSetConfig / writeUpdateSetRouting
 *
 * The push-routing file (.dove-update-sets.json) is the source of truth for
 * `dove push`. These tests pin the read/merge/write contract that keeps it in
 * sync with createUpdateSet / switchUpdateSet.
 */

var mockFsStore: Record<string, string> = {};

jest.mock("fs", function () {
  return {
    existsSync: jest.fn(function (p: string) {
      return p in mockFsStore;
    }),
    readFileSync: jest.fn(function (p: string) {
      if (p in mockFsStore) return mockFsStore[p];
      throw new Error("ENOENT: " + p);
    }),
    writeFileSync: jest.fn(function (p: string, data: string) {
      mockFsStore[p] = data;
    }),
  };
});

var CONFIG_PATH = "/repo/.dove-update-sets.json";

jest.mock("../projectFiles", function () {
  return {
    getUpdateSetsConfigPath: jest.fn(function () {
      return CONFIG_PATH;
    }),
  };
});

jest.mock("../Logger", function () {
  return {
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      success: jest.fn(),
    },
  };
});

import {
  readUpdateSetConfig,
  writeUpdateSetRouting,
} from "../updateSetConfig";
import { logger } from "../Logger";

describe("updateSetConfig", function () {
  beforeEach(function () {
    for (var k in mockFsStore) delete mockFsStore[k];
    jest.clearAllMocks();
  });

  describe("readUpdateSetConfig", function () {
    test("returns {} when the file is absent", function () {
      expect(readUpdateSetConfig()).toEqual({});
    });

    test("parses an existing routing file", function () {
      mockFsStore[CONFIG_PATH] = JSON.stringify({
        x_cadso_core: { sys_id: "abc", name: "Set A" },
      });
      expect(readUpdateSetConfig()).toEqual({
        x_cadso_core: { sys_id: "abc", name: "Set A" },
      });
    });

    test("returns {} and warns on unparseable JSON", function () {
      mockFsStore[CONFIG_PATH] = "{ not json";
      expect(readUpdateSetConfig()).toEqual({});
      expect(logger.warn).toHaveBeenCalled();
    });

    test("returns {} and warns when the file is a non-object (array)", function () {
      mockFsStore[CONFIG_PATH] = JSON.stringify(["nope"]);
      expect(readUpdateSetConfig()).toEqual({});
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("writeUpdateSetRouting", function () {
    test("writes a fresh routing entry and returns the path", function () {
      var written = writeUpdateSetRouting({
        scope: "x_cadso_core",
        sysId: "new123",
        name: "New Set",
      });
      expect(written).toBe(CONFIG_PATH);
      expect(JSON.parse(mockFsStore[CONFIG_PATH])).toEqual({
        x_cadso_core: { sys_id: "new123", name: "New Set" },
      });
    });

    test("merges without clobbering other scopes", function () {
      mockFsStore[CONFIG_PATH] = JSON.stringify({
        x_cadso_automate: { sys_id: "keep", name: "Keep Me" },
      });
      writeUpdateSetRouting({
        scope: "x_cadso_core",
        sysId: "new123",
        name: "New Set",
      });
      expect(JSON.parse(mockFsStore[CONFIG_PATH])).toEqual({
        x_cadso_automate: { sys_id: "keep", name: "Keep Me" },
        x_cadso_core: { sys_id: "new123", name: "New Set" },
      });
    });

    test("overwrites the same scope's stale entry", function () {
      mockFsStore[CONFIG_PATH] = JSON.stringify({
        x_cadso_core: { sys_id: "old", name: "Old Set" },
      });
      writeUpdateSetRouting({
        scope: "x_cadso_core",
        sysId: "fresh",
        name: "Fresh Set",
      });
      expect(JSON.parse(mockFsStore[CONFIG_PATH])).toEqual({
        x_cadso_core: { sys_id: "fresh", name: "Fresh Set" },
      });
    });

    test("returns null and writes nothing when scope is missing", function () {
      var written = writeUpdateSetRouting({ sysId: "x", name: "y" });
      expect(written).toBeNull();
      expect(mockFsStore[CONFIG_PATH]).toBeUndefined();
    });

    test("returns null when sys_id or name is blank", function () {
      expect(
        writeUpdateSetRouting({ scope: "x_cadso_core", sysId: "  ", name: "y" }),
      ).toBeNull();
      expect(
        writeUpdateSetRouting({ scope: "x_cadso_core", sysId: "x", name: "" }),
      ).toBeNull();
      expect(mockFsStore[CONFIG_PATH]).toBeUndefined();
    });
  });
});
