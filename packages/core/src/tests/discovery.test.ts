// --- Mock setup (must be before imports) ---

var mockReaddirSync = jest.fn();

jest.mock("fs", function () {
  var actual = jest.requireActual("fs");
  return Object.assign({}, actual, {
    readdirSync: mockReaddirSync,
  });
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

import { discoverPlugins } from "../initSystem/discovery";
import { logger } from "../Logger";

describe("discoverPlugins", function () {
  beforeEach(function () {
    mockReaddirSync.mockReset();
    // Default: no directories found
    mockReaddirSync.mockImplementation(function () {
      throw new Error("ENOENT");
    });
  });

  it("returns empty array when no node_modules found", function () {
    const plugins = discoverPlugins();
    expect(plugins).toEqual([]);
  });

  it("skips sincronia-core and sincronia-types", function () {
    mockReaddirSync.mockReturnValue(["sincronia-core", "sincronia-types"]);

    const plugins = discoverPlugins();
    expect(plugins).toEqual([]);
  });

  it("warns on plugin load failure", function () {
    mockReaddirSync.mockReturnValue(["sincronia-nonexistent"]);

    discoverPlugins();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips packages without sincPlugin export", function () {
    mockReaddirSync.mockReturnValue(["sincronia-sass-plugin"]);

    // sass-plugin exists but doesn't export sincPlugin — it just won't be added
    const plugins = discoverPlugins();
    const names = plugins.map(function (p) {
      return p.name;
    });
    expect(names).not.toContain("sass-plugin");
  });

  it("skips sincronia-dashboard and sincronia-schema", function () {
    (logger.warn as jest.Mock).mockClear();
    mockReaddirSync.mockReturnValue([
      "sincronia-dashboard",
      "sincronia-schema",
    ]);

    const plugins = discoverPlugins();
    expect(plugins).toEqual([]);
    // No require() attempted, so no warn from load failure
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
