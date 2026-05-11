// Tests for the `dove migrate` command (migrateCommand.ts). Covers: dry-run
// no-op, --apply renames files and rewrites package.json deps + scripts,
// collision safety (existing target skips rename), and the widened script
// rewrite that catches mid-string sinc invocations (e.g. `&& sinc push`).

var mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  getLogLevel: function () { return "debug"; },
};

jest.mock("../Logger", function () {
  return { logger: mockLogger };
});

jest.mock("../commands", function () {
  return { setLogLevel: jest.fn() };
});

import fs from "fs";
import os from "os";
import path from "path";
import { migrateCommand } from "../migrateCommand";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dove-migrate-test-"));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("migrateCommand", function () {
  var origCwd = process.cwd();
  var tmp = "";

  beforeEach(function () {
    jest.clearAllMocks();
    tmp = makeTempDir();
    process.chdir(tmp);
  });

  afterEach(function () {
    process.chdir(origCwd);
    rmrf(tmp);
  });

  it("dry-run makes zero filesystem changes", async function () {
    fs.writeFileSync(path.join(tmp, "sinc.config.js"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { build: "sinc push" }, devDependencies: { "@tenonhq/sincronia-core": "^1.0.0" } }, null, 2),
    );

    await migrateCommand({} as any);

    expect(fs.existsSync(path.join(tmp, "sinc.config.js"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "dove.config.js"))).toBe(false);
    var pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"));
    expect(pkg.scripts.build).toBe("sinc push");
    expect(pkg.devDependencies["@tenonhq/sincronia-core"]).toBe("^1.0.0");
  });

  it("--apply renames sinc.* artifacts and rewrites package.json", async function () {
    fs.writeFileSync(path.join(tmp, "sinc.config.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(tmp, "sinc.manifest.json"), "{}\n");
    fs.writeFileSync(path.join(tmp, ".sinc-active-task.json"), "{}\n");
    fs.writeFileSync(path.join(tmp, "sinc.manifest.x_cadso_core.json"), "{}\n");
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify(
        {
          scripts: { build: "sinc push", watch: "npx sinc watch" },
          devDependencies: {
            "@tenonhq/sincronia-core": "^1.0.0",
            "@tenonhq/sincronia-types": "^1.0.0",
          },
        },
        null,
        2,
      ),
    );

    await migrateCommand({ apply: true } as any);

    expect(fs.existsSync(path.join(tmp, "sinc.config.js"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "dove.config.js"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "dove.manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".dove-active-task.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "dove.manifest.x_cadso_core.json"))).toBe(true);

    var pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"));
    expect(pkg.scripts.build).toBe("dove push");
    expect(pkg.scripts.watch).toBe("npx dove watch");
    expect(pkg.devDependencies["@tenonhq/dovetail-core"]).toBe("^1.0.0");
    expect(pkg.devDependencies["@tenonhq/dovetail-types"]).toBe("^1.0.0");
    expect(pkg.devDependencies["@tenonhq/sincronia-core"]).toBeUndefined();
  });

  it("rewrites mid-string sinc invocations (chained commands)", async function () {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify(
        {
          scripts: {
            deploy: "npm run build && sinc push && sinc deploy",
            ci: "lint && test ; sinc status",
            // Should not match `sincronia` (the package name appears in scripts via npx).
            note: "echo @tenonhq/sincronia-core",
          },
        },
        null,
        2,
      ),
    );

    await migrateCommand({ apply: true } as any);

    var pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"));
    expect(pkg.scripts.deploy).toBe("npm run build && dove push && dove deploy");
    expect(pkg.scripts.ci).toBe("lint && test ; dove status");
    // \bsinc\b does not match `sincronia` (no word boundary between c and r),
    // and @tenonhq/sincronia-* is rewritten to @tenonhq/dovetail-* by the
    // earlier package-name pass.
    expect(pkg.scripts.note).toBe("echo @tenonhq/dovetail-core");
  });

  it("skips rename when target file already exists and warns", async function () {
    fs.writeFileSync(path.join(tmp, "sinc.config.js"), "// legacy\n");
    fs.writeFileSync(path.join(tmp, "dove.config.js"), "// new\n");

    await migrateCommand({ apply: true } as any);

    expect(fs.readFileSync(path.join(tmp, "sinc.config.js"), "utf8")).toBe("// legacy\n");
    expect(fs.readFileSync(path.join(tmp, "dove.config.js"), "utf8")).toBe("// new\n");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping rename of sinc.config.js"),
    );
  });

  it("reports nothing-to-migrate when project is already on dove.*", async function () {
    fs.writeFileSync(path.join(tmp, "dove.config.js"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { build: "dove push" }, devDependencies: { "@tenonhq/dovetail-core": "^1.0.0" } }, null, 2),
    );

    await migrateCommand({ apply: true } as any);

    expect(mockLogger.success).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to migrate"),
    );
  });
});
