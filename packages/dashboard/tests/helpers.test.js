const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  buildScopedUpdateSetName,
  extractDuplicateNumber,
  readActiveTask,
} = require("../lib/helpers");

describe("readActiveTask", () => {
  let directory;
  let taskFile;
  let warn;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "dovetail-dashboard-"));
    taskFile = path.join(directory, "active-task.json");
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("returns the persisted task object", () => {
    const task = { taskId: "DEV-123", taskName: "Fix dashboard" };
    fs.writeFileSync(taskFile, JSON.stringify(task));

    expect(readActiveTask(taskFile)).toEqual(task);
  });

  test("returns null for a missing file", () => {
    expect(readActiveTask(taskFile)).toBeNull();
  });

  test.each([
    ["an empty file", ""],
    ["truncated JSON", '{"taskId":'],
    ["JSON null", "null"],
    ["a JSON string", '"task"'],
    ["a JSON array", "[]"],
    ["a JSON number", "42"],
  ])("returns null for %s", (_description, contents) => {
    fs.writeFileSync(taskFile, contents);

    expect(readActiveTask(taskFile)).toBeNull();
  });

  test("returns null when reading throws", () => {
    fs.mkdirSync(taskFile);

    expect(readActiveTask(taskFile)).toBeNull();
  });
});

describe("buildScopedUpdateSetName", () => {
  test("uses customId before taskId", () => {
    expect(
      buildScopedUpdateSetName(
        {
          devInitials: "AJ",
          customId: "DEV-7",
          taskId: "internal-id",
          shortDesc: "Dashboard tests",
        },
        "Core",
      ),
    ).toBe("AJ | DEV-7 | Core | Dashboard tests");
  });

  test("falls back to taskId and taskName", () => {
    expect(
      buildScopedUpdateSetName(
        { taskId: "internal-id", taskName: "Dashboard tests" },
        "Core",
      ),
    ).toBe("internal-id | Core | Dashboard tests");
  });

  test("truncates names at exactly 80 characters", () => {
    const name = buildScopedUpdateSetName(
      { devInitials: "AJ", taskId: "DEV-7", shortDesc: "x".repeat(100) },
      "Core",
    );

    expect(name).toHaveLength(80);
    expect(name).toBe(`AJ | DEV-7 | Core | ${"x".repeat(60)}`);
  });
});

describe("extractDuplicateNumber", () => {
  test("returns -1 for the unsuffixed base name", () => {
    expect(
      extractDuplicateNumber("DEV-7 — Dashboard", "DEV-7 — Dashboard"),
    ).toBe(-1);
  });

  test("returns the trailing duplicate number", () => {
    expect(
      extractDuplicateNumber("DEV-7 — Dashboard 12", "DEV-7 — Dashboard"),
    ).toBe(12);
  });

  test("returns -1 for a non-numeric suffix", () => {
    expect(
      extractDuplicateNumber("DEV-7 — Dashboard copy", "DEV-7 — Dashboard"),
    ).toBe(-1);
  });
});

describe("server module", () => {
  test("can be required without binding a port", () => {
    const serverPath = path.join(__dirname, "..", "server.js");
    const script = `
      const net = require("net");
      let listenCalls = 0;
      net.Server.prototype.listen = function () {
        listenCalls += 1;
        return this;
      };
      require(${JSON.stringify(serverPath)});
      if (listenCalls !== 0) {
        throw new Error("requiring server.js called listen " + listenCalls + " time(s)");
      }
    `;

    expect(() =>
      execFileSync(process.execPath, ["-e", script], {
        stdio: "pipe",
        timeout: 3000,
      }),
    ).not.toThrow();
  });
});
