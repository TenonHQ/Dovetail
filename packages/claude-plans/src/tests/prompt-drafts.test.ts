import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  createPromptDraft,
  getPromptDraft,
  listPromptDrafts,
  listPromptDraftsWithActive,
  updatePromptDraft,
  deletePromptDraft,
  setActivePromptDraft,
  getActivePromptDraft,
} from "../storage";
import { TOOL_NAMES } from "../registry";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prompt-drafts-test-"));
}

describe("prompt drafts storage", () => {
  let root: string;
  let opts: { rootDir: string };

  beforeEach(() => {
    root = mkTmp();
    opts = { rootDir: root };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("create assigns a pd_<8hex> id and persists", () => {
    const d = createPromptDraft(
      { title: "My prompt", content: "<done>x</done>" },
      opts,
    );
    expect(d.id).toMatch(/^pd_[0-9a-f]{8}$/);
    expect(d.title).toBe("My prompt");
    expect(d.content).toBe("<done>x</done>");
    expect(getPromptDraft(d.id, opts)).toEqual(d);
  });

  test("create defaults a blank title and empty content", () => {
    const d = createPromptDraft({}, opts);
    expect(d.title).toBe("Untitled prompt");
    expect(d.content).toBe("");
  });

  test("first draft becomes active automatically; later ones do not", () => {
    const a = createPromptDraft({ title: "A" }, opts);
    expect(getActivePromptDraft(opts)!.id).toBe(a.id);
    const b = createPromptDraft({ title: "B" }, opts);
    // still A — creating a second draft must not steal focus
    expect(getActivePromptDraft(opts)!.id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });

  test("list is oldest-first and excludes the _active pointer", () => {
    const a = createPromptDraft({ title: "A" }, opts);
    const b = createPromptDraft({ title: "B" }, opts);
    setActivePromptDraft(b.id, opts);
    const ids = listPromptDrafts(opts).map((d) => d.id);
    expect(ids).toEqual([a.id, b.id]);
    // pointer file exists but is not a draft
    expect(
      fs.existsSync(path.join(root, "_prompt-drafts", "_active.json")),
    ).toBe(true);
  });

  test("listWithActive returns drafts and the active id", () => {
    const a = createPromptDraft({ title: "A" }, opts);
    const b = createPromptDraft({ title: "B" }, opts);
    setActivePromptDraft(b.id, opts);
    const res = listPromptDraftsWithActive(opts);
    expect(res.drafts.map((d) => d.id)).toEqual([a.id, b.id]);
    expect(res.active_id).toBe(b.id);
  });

  test("update overwrites content (the enhance-write path) and bumps updated_at", async () => {
    const d = createPromptDraft({ title: "T", content: "draft" }, opts);
    await new Promise((r) => setTimeout(r, 5));
    const next = updatePromptDraft({ id: d.id, content: "ENHANCED" }, opts);
    expect(next.content).toBe("ENHANCED");
    expect(next.title).toBe("T");
    expect(next.updated_at >= d.updated_at).toBe(true);
    expect(getPromptDraft(d.id, opts)!.content).toBe("ENHANCED");
  });

  test("update on a missing id throws", () => {
    expect(() =>
      updatePromptDraft({ id: "pd_deadbeef", content: "x" }, opts),
    ).toThrow(/not found/);
  });

  test("setActive on a missing id throws", () => {
    expect(() => setActivePromptDraft("pd_deadbeef", opts)).toThrow(
      /not found/,
    );
  });

  test("deleting the active draft advances active to the next remaining draft", () => {
    const a = createPromptDraft({ title: "A" }, opts);
    const b = createPromptDraft({ title: "B" }, opts);
    setActivePromptDraft(a.id, opts);
    const res = deletePromptDraft(a.id, opts);
    expect(res.deleted).toBe(true);
    expect(res.active_id).toBe(b.id);
    expect(getActivePromptDraft(opts)!.id).toBe(b.id);
  });

  test("deleting the last draft clears active to null", () => {
    const a = createPromptDraft({ title: "A" }, opts);
    const res = deletePromptDraft(a.id, opts);
    expect(res.active_id).toBeNull();
    expect(getActivePromptDraft(opts)).toBeNull();
  });

  test("getActive returns null on a fresh store", () => {
    expect(getActivePromptDraft(opts)).toBeNull();
  });

  test("path-traversal ids are rejected on read (returns null, never escapes root)", () => {
    expect(getPromptDraft("../../etc/passwd", opts)).toBeNull();
  });

  test("registry exposes the five prompt-draft tools", () => {
    for (const name of [
      "list_prompt_drafts",
      "get_active_prompt_draft",
      "get_prompt_draft",
      "create_prompt_draft",
      "update_prompt_draft",
    ]) {
      expect(TOOL_NAMES).toContain(name);
    }
  });
});
