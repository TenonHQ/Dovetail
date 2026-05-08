import fs from "fs";
import path from "path";
import { logger } from "./Logger";
import { setLogLevel } from "./commands";

interface InitClaudeCmdArgs {
  logLevel: string;
  force: boolean;
}

function findSkillsDir(): string | null {
  // Walk up from __dirname looking for a skills/ directory with .md files
  // Handles both dist/ and dist/core/src/ output structures, plus monorepo layout
  let dir = __dirname;
  const root = path.parse(dir).root;
  while (dir !== root) {
    dir = path.dirname(dir);
    const candidate = path.join(dir, "skills");
    if (
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isDirectory() &&
      fs.readdirSync(candidate).some(function (f) {
        return f.endsWith(".md");
      })
    ) {
      return candidate;
    }
  }
  return null;
}

export async function initClaudeCommand(args: InitClaudeCmdArgs) {
  setLogLevel(args);

  var skillsDir = findSkillsDir();
  if (!skillsDir) {
    logger.error("Could not find Dovetail skills directory.");
    process.exit(1);
    return;
  }

  // Target: <cwd>/.claude/commands/
  const targetDir = path.resolve(process.cwd(), ".claude", "commands");
  fs.mkdirSync(targetDir, { recursive: true });

  // Copy .md files
  const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  let copied = 0;
  let skipped = 0;

  for (const file of files) {
    const dest = path.join(targetDir, file);
    if (fs.existsSync(dest) && !args.force) {
      logger.info(`Skipped (exists): ${file}`);
      skipped++;
    } else {
      fs.copyFileSync(path.join(skillsDir, file), dest);
      logger.info(`Copied: ${file}`);
      copied++;
    }
  }

  logger.success(
    `Init complete! ${copied} skills copied, ${skipped} skipped. ✅`,
  );
  if (skipped > 0) {
    logger.info("Use --force to overwrite existing files.");
  }
}
