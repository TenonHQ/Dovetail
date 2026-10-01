/**
 * invoke-rest --out: the atomic result-file writer (grain B2, backlog
 * "invoke-rest --json truncates at ~64KB when piped").
 *
 * The pipe-truncation half of that fix is the CLI's flush-aware exit
 * (exitAfterFlush in cli.ts — structural, exercised by any piped run); this
 * suite pins the file half: large payloads land complete, writes are atomic
 * (temp+rename, no residue), overwrite is by-design, and a missing parent
 * directory fails loudly instead of "succeeding" with no file.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeInvokeRestResultFile } from "../src/invokeRest";

describe("writeInvokeRestResultFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "invoke-rest-out-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a >64KB body completely (the pipe-buffer regression size)", () => {
    const big = "x".repeat(200 * 1024); // well past the ~65534-byte truncation point
    const result = {
      status: "sent",
      method: "GET",
      path: "/api/x_cadso_core/example",
      httpStatus: 200,
      ok: true,
      body: { blob: big },
    };
    const out = path.join(dir, "result.json");

    writeInvokeRestResultFile(out, result);

    const readBack = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(readBack.body.blob).toHaveLength(200 * 1024);
    expect(readBack.body.blob).toBe(big);
    expect(readBack.httpStatus).toBe(200);
  });

  it("overwrites an existing file by design", () => {
    const out = path.join(dir, "result.json");
    fs.writeFileSync(out, '{"stale":true}');

    writeInvokeRestResultFile(out, { fresh: true });

    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ fresh: true });
  });

  it("throws loudly when the parent directory does not exist", () => {
    const out = path.join(dir, "missing-subdir", "result.json");

    expect(() => writeInvokeRestResultFile(out, { ok: true })).toThrow();
    expect(fs.existsSync(out)).toBe(false);
  });

  it("leaves no temp-file residue on success or failure", () => {
    const out = path.join(dir, "result.json");
    writeInvokeRestResultFile(out, { ok: true });

    const missingOut = path.join(dir, "nope", "result.json");
    try {
      writeInvokeRestResultFile(missingOut, { ok: false });
    } catch (err) {
      // expected — parent dir missing
    }

    const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("pretty-prints with a trailing newline (matches the --json stdout shape)", () => {
    const out = path.join(dir, "result.json");
    writeInvokeRestResultFile(out, { a: 1 });

    const raw = fs.readFileSync(out, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "a": 1');
  });
});
