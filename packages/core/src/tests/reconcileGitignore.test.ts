// Tests for the gitignore-ensure compute step plus the I/O wrapper.

import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureEntryContent,
  ensureGitignored,
  hasGitignoreEntry,
} from "../reconcile/gitignore";

const ENTRY = ".dove-reconcile-baseline.json";

describe("hasGitignoreEntry", () => {
  it("detects a present entry ignoring surrounding whitespace", () => {
    expect(hasGitignoreEntry("node_modules\n" + ENTRY + "\n", ENTRY)).toBe(
      true,
    );
    expect(hasGitignoreEntry("  " + ENTRY + "  \n", ENTRY)).toBe(true);
  });

  it("does not match a commented line", () => {
    expect(hasGitignoreEntry("# " + ENTRY + "\n", ENTRY)).toBe(false);
  });

  it("returns false when absent", () => {
    expect(hasGitignoreEntry("node_modules\n", ENTRY)).toBe(false);
  });
});

describe("ensureEntryContent", () => {
  it("creates content when the file does not exist", () => {
    const out = ensureEntryContent(null, ENTRY);
    expect(out.changed).toBe(true);
    expect(out.content).toBe(ENTRY + "\n");
  });

  it("appends with a separating newline when the file lacks a trailing one", () => {
    const out = ensureEntryContent("node_modules", ENTRY);
    expect(out.changed).toBe(true);
    expect(out.content).toBe("node_modules\n" + ENTRY + "\n");
  });

  it("is a no-op when the entry is already present", () => {
    const existing = "node_modules\n" + ENTRY + "\n";
    const out = ensureEntryContent(existing, ENTRY);
    expect(out.changed).toBe(false);
    expect(out.content).toBe(existing);
  });
});

describe("ensureGitignored — I/O", () => {
  it("creates .gitignore with the entry, then is idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dove-gitignore-"));
    const first = ensureGitignored(root, ENTRY);
    expect(first.changed).toBe(true);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(
      ENTRY,
    );

    const second = ensureGitignored(root, ENTRY);
    expect(second.changed).toBe(false);
  });
});
