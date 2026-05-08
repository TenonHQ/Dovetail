import fs from "fs";
import path from "path";

// Resolve a project-root dotfile by its short name (e.g. "active-task" → ".dove-active-task.json").
// Reads prefer the new `.dove-*` filename; if only the legacy `.sinc-*` sibling exists, it is
// returned so existing projects keep working until the user runs `dove migrate`. New writes
// land at the `.dove-*` path when neither file is present yet.
function resolveDoveDotfile(name: string): string {
  const dovePath = path.resolve(process.cwd(), ".dove-" + name + ".json");
  const sincPath = path.resolve(process.cwd(), ".sinc-" + name + ".json");
  if (fs.existsSync(dovePath)) return dovePath;
  if (fs.existsSync(sincPath)) return sincPath;
  return dovePath;
}

export function getActiveTaskPath(): string {
  return resolveDoveDotfile("active-task");
}

export function getUpdateSetsConfigPath(): string {
  return resolveDoveDotfile("update-sets");
}

export function getRecentEditsPath(): string {
  return resolveDoveDotfile("recent-edits");
}
