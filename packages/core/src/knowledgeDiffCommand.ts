import * as fs from "fs";
import * as path from "path";
import { Sinc } from "@tenonhq/dovetail-types";
import { setLogLevel } from "./commands";
import { logger } from "./Logger";
import {
  computeDrift,
  eventFilename,
  ReleaseManifest,
  DocLedger,
  KnowledgeConfig,
} from "./knowledgeDiff";

interface KnowledgeDiffConfig extends KnowledgeConfig {
  ledger?: string;
  pending_dir?: string;
}

type KnowledgeDiffArgs = Sinc.SharedCmdArgs & {
  manifest?: string;
  config?: string;
  ledger?: string;
  out?: string;
  json?: boolean;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function resolveManifestPath(explicit: string | undefined): string {
  if (explicit) return path.resolve(explicit);
  // Bundled inside @tenonhq/dovetail-core at publish time (see publish-on-merge.js).
  // __dirname is <pkg>/dist at runtime, so ".." is the installed package root.
  return path.resolve(__dirname, "..", "release-manifest.json");
}

// `dove knowledge-diff` — pure, deterministic detector. Compares the Dovetail
// release manifest against this repo's documented-state ledger and stages the
// undocumented release-events for the in-session /dovetail-features-sync skill.
// No network, no LLM — safe to run at install or in CI.
export async function knowledgeDiffCommand(
  args: KnowledgeDiffArgs,
): Promise<void> {
  setLogLevel(args);
  const cwd = process.cwd();

  const configPath = args.config
    ? path.resolve(args.config)
    : path.join(cwd, "context", "dovetail-releases", "config.json");
  let config: KnowledgeDiffConfig = {};
  if (fs.existsSync(configPath)) {
    config = readJson<KnowledgeDiffConfig>(configPath);
  } else {
    logger.warn(
      "knowledge-diff: no config at " + configPath + "; watching all packages.",
    );
  }

  const manifestPath = resolveManifestPath(args.manifest);
  if (!fs.existsSync(manifestPath)) {
    logger.warn(
      "knowledge-diff: no release manifest at " +
        manifestPath +
        " — nothing to diff (Dovetail publish writes it).",
    );
    return;
  }
  const manifest = readJson<ReleaseManifest>(manifestPath);

  let ledgerPath: string;
  if (args.ledger) {
    ledgerPath = path.resolve(args.ledger);
  } else if (config.ledger) {
    ledgerPath = path.resolve(cwd, config.ledger);
  } else {
    ledgerPath = path.join(cwd, "context", "dovetail-releases", "ledger.json");
  }
  const ledger: DocLedger = fs.existsSync(ledgerPath)
    ? readJson<DocLedger>(ledgerPath)
    : { packages: {} };

  const drift = computeDrift(manifest, ledger, config);

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ count: drift.length, events: drift }, null, 2) + "\n",
    );
    return;
  }

  if (drift.length === 0) {
    logger.info("knowledge-diff: no new Dovetail releases to document.");
    return;
  }

  let outDir: string;
  if (args.out) {
    outDir = path.resolve(args.out);
  } else if (config.pending_dir) {
    outDir = path.resolve(cwd, config.pending_dir);
  } else {
    outDir = path.join(cwd, "context", "dovetail-releases", "pending");
  }
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  for (const ev of drift) {
    const dest = path.join(outDir, eventFilename(ev));
    fs.writeFileSync(dest, JSON.stringify(ev, null, 2) + "\n");
  }
  logger.info(
    "knowledge-diff: wrote " +
      drift.length +
      " pending release-event(s) to " +
      path.relative(cwd, outDir) +
      ". Run /dovetail-features-sync to document them.",
  );
}
