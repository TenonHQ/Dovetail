import fs from "fs";
import path from "path";
import { Sinc } from "@tenonhq/dovetail-types";
import { logger } from "./Logger";
import { setLogLevel } from "./commands";

interface MigrateCmdArgs extends Sinc.SharedCmdArgs {
  apply?: boolean;
  dryRun?: boolean;
}

interface MigrationStep {
  description: string;
  apply: () => void;
}

// Map legacy -> new artifact filenames at the project root.
const FILE_RENAMES: Array<{ legacy: string; next: string }> = [
  { legacy: "sinc.config.js", next: "dove.config.js" },
  { legacy: "sinc.manifest.json", next: "dove.manifest.json" },
  { legacy: "sinc.diff.manifest.json", next: "dove.diff.manifest.json" },
  { legacy: ".sinc-active-task.json", next: ".dove-active-task.json" },
  { legacy: ".sinc-update-sets.json", next: ".dove-update-sets.json" },
  { legacy: ".sinc-recent-edits.json", next: ".dove-recent-edits.json" },
];

// Per-scope manifests follow the pattern sinc.manifest.<scope>.json. Glob from disk.
function collectScopeManifestRenames(rootDir: string): Array<{ legacy: string; next: string }> {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(rootDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.startsWith("sinc.manifest.") && f !== "sinc.manifest.json" && f.endsWith(".json"))
    .map((f) => ({
      legacy: f,
      next: f.replace(/^sinc\.manifest\./, "dove.manifest."),
    }));
}

// Rewrite package.json scripts and dependencies.
function buildPackageJsonStep(rootDir: string): MigrationStep | null {
  const pkgPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const original = fs.readFileSync(pkgPath, "utf8");

  // Order matters: rewrite the @tenonhq/sincronia-* deps first so the
  // subsequent \bsinc\b sweep doesn't have to know about package-name
  // collisions. \bsinc\b doesn't match `sincronia` (no word boundary between
  // `c` and `r`), so the package-name replace and the script-token replace
  // are independent. The standalone \bsinc\b catches every CLI invocation
  // shape — bare (`sinc watch`), chained (`&& sinc push`), prefixed
  // (`npx sinc`), trailing (`build && sinc deploy`) — without the four
  // separate fragile regexes we had before.
  const updated = original
    .replace(/@tenonhq\/sincronia-/g, "@tenonhq/dovetail-")
    .replace(/\bsinc\b/g, "dove");

  if (updated === original) return null;

  return {
    description: "Update package.json (rename @tenonhq/sincronia-* deps and `sinc` scripts to `dove`)",
    apply: () => {
      fs.writeFileSync(pkgPath, updated);
    },
  };
}

function buildFileRenameStep(rootDir: string, legacy: string, next: string): MigrationStep | null {
  const legacyPath = path.join(rootDir, legacy);
  const nextPath = path.join(rootDir, next);
  if (!fs.existsSync(legacyPath)) return null;
  if (fs.existsSync(nextPath)) {
    logger.warn(
      "Skipping rename of " + legacy + " — " + next + " already exists. Resolve manually.",
    );
    return null;
  }
  return {
    description: "Rename " + legacy + " -> " + next,
    apply: () => {
      fs.renameSync(legacyPath, nextPath);
    },
  };
}

export async function migrateCommand(args: MigrateCmdArgs) {
  setLogLevel(args);

  const rootDir = process.cwd();
  const apply = !!args.apply;

  const steps: MigrationStep[] = [];

  // 1. Single-file renames.
  for (const r of FILE_RENAMES) {
    const step = buildFileRenameStep(rootDir, r.legacy, r.next);
    if (step) steps.push(step);
  }

  // 2. Per-scope manifest renames.
  for (const r of collectScopeManifestRenames(rootDir)) {
    const step = buildFileRenameStep(rootDir, r.legacy, r.next);
    if (step) steps.push(step);
  }

  // 3. package.json rewrite.
  const pkgStep = buildPackageJsonStep(rootDir);
  if (pkgStep) steps.push(pkgStep);

  if (steps.length === 0) {
    logger.success("Nothing to migrate — project already uses Dovetail filenames.");
    return;
  }

  logger.info("Migration plan (" + steps.length + " step" + (steps.length === 1 ? "" : "s") + "):");
  steps.forEach((s, i) => {
    logger.info("  " + (i + 1) + ". " + s.description);
  });

  if (!apply) {
    logger.info("");
    logger.warn("Dry run only — re-run with `--apply` to perform the migration.");
    return;
  }

  for (const step of steps) {
    try {
      step.apply();
      logger.success("✓ " + step.description);
    } catch (e) {
      logger.error("✗ " + step.description + ": " + (e instanceof Error ? e.message : String(e)));
    }
  }

  logger.info("");
  logger.info(
    "Migration complete. Review the changes, run `npm install` if package.json was updated, and re-import the Dovetail Scripted REST API XML on your ServiceNow instance (see docs/dovetail-servicenow-migration.md).",
  );
}
