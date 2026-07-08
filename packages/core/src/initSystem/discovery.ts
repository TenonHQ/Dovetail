import { Sinc } from "@tenonhq/dovetail-types";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../Logger";

// Skip packages that are not init plugins:
// - core/types: the discovery system itself
// - dashboard: starts Express server on require (side effect)
// - schema: library imported directly by schemaCommand, not a plugin
// Both new (dovetail-*) and legacy (sincronia-*) names are listed so the deprecation
// shim packages on npm are also skipped during the rebrand transition window.
const SKIP_PACKAGES = new Set([
  "dovetail-core",
  "dovetail-types",
  "dovetail-dashboard",
  "dovetail-schema",
  "sincronia-core",
  "sincronia-types",
  "sincronia-dashboard",
  "sincronia-schema",
]);
const PLUGIN_PACKAGE_PREFIXES = ["dovetail-", "sincronia-"];
const MAX_PARENT_DEPTH = 3;

/**
 * @description Scans node_modules for @tenonhq/dovetail-* (and legacy @tenonhq/sincronia-*) packages that export a sincPlugin.
 * @returns {Sinc.InitPlugin[]} Array of discovered init plugins.
 */
export function discoverPlugins(): Sinc.InitPlugin[] {
  const plugins: Sinc.InitPlugin[] = [];
  const seen = new Set<string>();

  const searchPaths = [
    path.resolve(process.cwd(), "node_modules", "@tenonhq"),
    path.resolve(__dirname, "..", "..", "..", "@tenonhq"),
  ];

  // Check parent directories for monorepo hoisted node_modules (capped depth)
  let current = process.cwd();
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const parent = path.dirname(current);
    if (parent === current) break;
    const hoisted = path.join(parent, "node_modules", "@tenonhq");
    if (!searchPaths.includes(hoisted)) {
      searchPaths.push(hoisted);
    }
    current = parent;
  }

  for (const searchPath of searchPaths) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(searchPath);
    } catch (e) {
      continue;
    }

    dirs
      .filter(
        (name) =>
          PLUGIN_PACKAGE_PREFIXES.some((p) => name.startsWith(p)) &&
          !SKIP_PACKAGES.has(name) &&
          !seen.has(name),
      )
      .forEach((dirName) => {
        seen.add(dirName);

        try {
          const pkg = require("@tenonhq/" + dirName);
          if (
            pkg &&
            pkg.sincPlugin &&
            pkg.sincPlugin.name &&
            pkg.sincPlugin.displayName
          ) {
            plugins.push(pkg.sincPlugin);
            logger.debug(
              "Discovered init plugin: " +
                pkg.sincPlugin.displayName +
                " (" +
                dirName +
                ")",
            );
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logger.warn("Failed to load plugin " + dirName + ": " + message);
        }
      });
  }

  return plugins;
}
