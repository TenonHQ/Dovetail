import fs from "fs";
import { getUpdateSetsConfigPath } from "./projectFiles";
import { logger } from "./Logger";

/**
 * One scope's routing destination in .dove-update-sets.json.
 */
export interface UpdateSetSelection {
  sys_id: string;
  name: string;
}

/**
 * The whole routing file: scope name -> selected update set.
 * `dove push` routes each record's capture by this map, keyed on the record's
 * scope (see pushFiles()), NOT by the instance's active update set.
 */
export type UpdateSetConfig = Record<string, UpdateSetSelection>;

/**
 * Read .dove-update-sets.json (or its legacy .sinc- sibling). Returns {} when
 * the file is absent or unparseable, so callers never have to guard for null.
 */
export function readUpdateSetConfig(): UpdateSetConfig {
  const configPath = getUpdateSetsConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as UpdateSetConfig;
      }
      logger.warn(
        `Update set config at ${configPath} is not an object; ignoring it.`,
      );
    }
  } catch (e) {
    logger.warn(
      `Failed to parse update set config at ${configPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return {};
}

/**
 * Merge a single scope's update set into .dove-update-sets.json so that
 * `dove push` routes that scope's records to the set the operator just created
 * or switched to.
 *
 * Without this, `dove createUpdateSet` / `dove switchUpdateSet` only flip the
 * instance's *active* update set, while `dove push` keeps routing via this file
 * — so a freshly "activated" set can stay empty and the work lands in whatever
 * stale set the file still points at (TenonHQ/Dovetail#182).
 *
 * Returns the path written, or null when any input is missing (no scope name,
 * sys_id, or set name to route by) so the caller can warn instead.
 */
export function writeUpdateSetRouting(opts: {
  scope?: string;
  sysId?: string;
  name?: string;
}): string | null {
  const scope = opts.scope ? opts.scope.trim() : "";
  const sysId = opts.sysId ? opts.sysId.trim() : "";
  const name = opts.name ? opts.name.trim() : "";
  if (!scope || !sysId || !name) return null;

  const configPath = getUpdateSetsConfigPath();
  const config = readUpdateSetConfig();
  config[scope] = { sys_id: sysId, name };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
