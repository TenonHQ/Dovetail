// Ensure the per-instance baseline is gitignored in the consumer project. The
// baseline is per-developer, per-instance local state (the "merge-base/index")
// and must never be committed. The compute step is pure and unit-tested; the
// wrapper does the file I/O and never throws (a gitignore it cannot write is a
// warning, not a failed reconcile).

import fs from "fs";
import path from "path";

export interface GitignoreUpdate {
  changed: boolean;
  content: string;
}

function lines(content: string): string[] {
  return content.split(/\r?\n/);
}

/**
 * Returns whether `entry` is already an active (non-comment) line in the
 * gitignore content. Trailing whitespace and blank lines are ignored.
 */
export function hasGitignoreEntry(content: string, entry: string): boolean {
  const target = entry.trim();
  for (const line of lines(content)) {
    const trimmed = line.trim();
    if (trimmed === target) {
      return true;
    }
  }
  return false;
}

/**
 * Pure: compute the gitignore content that includes `entry`. Appends a tidy
 * block (with a trailing newline) when missing; returns unchanged when present.
 * `content` is null when the file does not yet exist.
 */
export function ensureEntryContent(
  content: string | null,
  entry: string,
): GitignoreUpdate {
  if (content !== null && hasGitignoreEntry(content, entry)) {
    return { changed: false, content };
  }
  const base = content === null ? "" : content;
  const needsNewline = base.length > 0 && !base.endsWith("\n");
  const next =
    base + (needsNewline ? "\n" : "") + entry + "\n";
  return { changed: true, content: next };
}

export function ensureGitignored(rootDir: string, entry: string): GitignoreUpdate {
  const filePath = path.join(rootDir, ".gitignore");
  let existing: string | null = null;
  try {
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, "utf8");
    }
  } catch (e) {
    existing = null;
  }
  const update = ensureEntryContent(existing, entry);
  if (update.changed) {
    try {
      fs.writeFileSync(filePath, update.content, "utf8");
    } catch (e) {
      return { changed: false, content: existing || "" };
    }
  }
  return update;
}
