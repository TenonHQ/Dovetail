import { SN, Sinc } from "@tenonhq/dovetail-types";
import { PATH_DELIMITER } from "./constants";
import fs, { promises as fsp } from "fs";
import path from "path";
import * as ConfigManager from "./config";
import { fileLogger } from "./FileLogger";

export const SNFileExists =
  (parentDirPath: string) =>
  async (file: SN.File): Promise<boolean> => {
    try {
      const files = await fsp.readdir(parentDirPath);
      const reg = new RegExp(`${file.name}\..*$`);
      return !!files.find((f) => reg.test(f));
    } catch (e) {
      return false;
    }
  };

export const writeManifestFile = async (
  man: SN.AppManifest,
  scope?: string,
) => {
  if (scope) {
    const manifestPath = ConfigManager.getScopeManifestPath(scope);
    fileLogger.debug(
      "Writing manifest for scope " + scope + " to " + manifestPath,
    );
    return fsp.writeFile(manifestPath, JSON.stringify(man, null, 2));
  }
  const manifestPath = ConfigManager.getManifestPath();
  fileLogger.debug("Writing manifest to " + manifestPath);
  return fsp.writeFile(manifestPath, JSON.stringify(man, null, 2));
};

export const writeScopeManifest = async (
  scope: string,
  man: SN.AppManifest,
) => {
  const manifestPath = ConfigManager.getScopeManifestPath(scope);
  fileLogger.debug("Writing scope manifest: " + scope + " -> " + manifestPath);
  return fsp.writeFile(manifestPath, JSON.stringify(man, null, 2));
};

export const writeSNFileCurry =
  (checkExists: boolean) =>
  async (file: SN.File, parentPath: string): Promise<void> => {
    let { name, type, content = "" } = file;
    if (!content) {
      content = "";
    }

    const fullPath = path.join(parentPath, `${name}.${type}`);

    const write = async () => {
      fileLogger.debug("Writing: " + fullPath);
      try {
        const result = await fsp.writeFile(fullPath, content);
        return result;
      } catch (error) {
        fileLogger.error("Failed to write " + fullPath + ":", error);
        throw error;
      }
    };

    if (checkExists) {
      const exists = await SNFileExists(parentPath)(file);
      if (!exists) {
        await write();
      } else {
        fileLogger.debug("Skipped (exists): " + fullPath);
      }
    } else {
      await write();
    }
  };

/**
 * Writes the SN file to disk only if the local content differs from `file.content`.
 * Returns `true` if the file was written (missing or differed), `false` if skipped.
 *
 * Used by `sinc refresh` to pull ServiceNow-side edits without churning unchanged
 * files (preserves mtime, avoids noisy watchers, keeps diff output clean).
 */
export const writeSNFileIfDifferent = async (
  file: SN.File,
  parentPath: string,
): Promise<boolean> => {
  let { name, type, content = "" } = file;
  if (!content) content = "";

  const fullPath = path.join(parentPath, `${name}.${type}`);

  let localContent: string | null = null;
  try {
    localContent = await fsp.readFile(fullPath, "utf8");
  } catch (e) {
    localContent = null;
  }

  if (localContent === content) {
    fileLogger.debug("Unchanged: " + fullPath);
    return false;
  }

  if (localContent !== null) {
    fileLogger.debug(
      "Overwriting local content (differs from instance): " + fullPath,
    );
  } else {
    fileLogger.debug("Writing (missing locally): " + fullPath);
  }

  try {
    await fsp.writeFile(fullPath, content);
    return true;
  } catch (error) {
    fileLogger.error("Failed to write " + fullPath + ":", error);
    throw error;
  }
};

export const createDirRecursively = async (path: string): Promise<void> => {
  await fsp.mkdir(path, { recursive: true });
};

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fsp.access(path, fs.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
};

export const appendToPath =
  (prefix: string) =>
  (suffix: string): string =>
    path.join(prefix, suffix);

/**
 * Detects if a path is under a parent directory
 * @param parentPath full path to parent directory
 * @param potentialChildPath full path to child directory
 */
export const isUnderPath = (
  parentPath: string,
  potentialChildPath: string,
): boolean => {
  const parentTokens = parentPath.split(path.sep);
  const childTokens = potentialChildPath.split(path.sep);
  return parentTokens.every((token, index) => token === childTokens[index]);
};

const getFileExtension = (filePath: string): string => {
  try {
    return "." + path.basename(filePath).split(".").slice(1).join(".");
  } catch (e) {
    return "";
  }
};

export const getBuildExt = (
  table: string,
  recordName: string,
  field: string,
  scope?: string,
): string => {
  var manifest = ConfigManager.getManifest();
  if (!manifest) {
    throw new Error("Failed to retrieve manifest");
  }

  var resolvedManifest = manifest;
  if (scope && ConfigManager.isMultiScopeManifest(manifest)) {
    var scopeMan = ConfigManager.resolveManifestForScope(manifest, scope);
    if (!scopeMan) {
      throw new Error("Failed to find scope " + scope + " in manifest");
    }
    resolvedManifest = scopeMan;
  }

  const files = resolvedManifest.tables[table].records[recordName].files;
  const file = files.find((f) => f.name === field);
  if (!file) {
    throw new Error("Unable to find file");
  }
  return file.type;
};

const getTargetFieldFromPath = (
  filePath: string,
  table: string,
  ext: string,
): string => {
  return table === "sys_atf_step"
    ? "inputs.script"
    : path.basename(filePath, ext);
};

export interface FileContextResult {
  context?: Sinc.FileContext;
  skipReason?: string;
}

export const getFileContextWithSkipReason = (
  filePath: string,
): FileContextResult => {
  const ext = getFileExtension(filePath);
  const [tableName, recordName] = path
    .dirname(filePath)
    .split(path.sep)
    .slice(-2);
  const targetField = getTargetFieldFromPath(filePath, tableName, ext);
  var manifest = ConfigManager.getManifest();
  if (!manifest) {
    throw new Error("No manifest has been loaded!");
  }

  var scope;
  var tables;

  if (ConfigManager.isMultiScopeManifest(manifest)) {
    var detectedScope = ConfigManager.resolveScopeFromPath(filePath);
    if (!detectedScope) {
      return { skipReason: "scope not found" };
    }
    var scopeMan = ConfigManager.resolveManifestForScope(
      manifest,
      detectedScope,
    );
    if (!scopeMan) {
      return { skipReason: "scope manifest not found" };
    }
    scope = scopeMan.scope || detectedScope;
    tables = scopeMan.tables;
  } else {
    scope = manifest.scope;
    tables = manifest.tables;
  }

  try {
    const { records } = tables[tableName];
    const record = records[recordName];
    const { files, sys_id } = record;
    const field = files.find((file) => file.name === targetField);
    if (!field) {
      return { skipReason: "not in manifest" };
    }
    return {
      context: {
        filePath,
        ext,
        sys_id,
        name: recordName,
        scope,
        tableName,
        targetField,
      },
    };
  } catch (e) {
    return { skipReason: "not in manifest" };
  }
};

export const getFileContextFromPath = (
  filePath: string,
): Sinc.FileContext | undefined => {
  return getFileContextWithSkipReason(filePath).context;
};

export const toAbsolutePath = (p: string): string =>
  path.isAbsolute(p) ? p : path.join(process.cwd(), p);

export const isDirectory = async (p: string): Promise<boolean> => {
  const stats = await fsp.stat(p);
  return stats.isDirectory();
};

export const getPathsInPath = async (p: string): Promise<string[]> => {
  if (
    !isUnderPath(ConfigManager.getSourcePath(), p) &&
    !isUnderPath(ConfigManager.getBuildPath(), p)
  ) {
    return [];
  }
  const isDir = await isDirectory(p);
  if (!isDir) {
    return [p];
  } else {
    const childPaths = await fsp.readdir(p);
    const pathPromises = childPaths.map((childPath) =>
      getPathsInPath(path.resolve(p, childPath)),
    );
    const stackedPaths = await Promise.all(pathPromises);
    return stackedPaths.flat();
  }
};

export const splitEncodedPaths = (encodedPaths: string): string[] =>
  encodedPaths.split(PATH_DELIMITER).filter((p) => p && p !== "");

export const isValidPath = async (path: string): Promise<boolean> => {
  return pathExists(path);
};

export const encodedPathsToFilePaths = async (
  encodedPaths: string,
): Promise<string[]> => {
  const pathSplits = splitEncodedPaths(encodedPaths);
  const validChecks = await Promise.all(pathSplits.map(isValidPath));
  const validSplits = pathSplits.filter((_, index) => validChecks[index]);
  const splitPaths = await Promise.all(validSplits.map(getPathsInPath));
  const deDupedPaths = splitPaths.flat().reduce((acc, cur) => {
    acc.add(cur);
    return acc;
  }, new Set<string>());
  return Array.from(deDupedPaths);
};

export const summarizeFile = (ctx: Sinc.FileContext): string => {
  const { tableName, name: recordName, sys_id } = ctx;
  return `${tableName}/${recordName}/${sys_id}`;
};

export const writeBuildFile = async (
  folderPath: string,
  newPath: string,
  fileContents: string,
) => {
  const buildPath = ConfigManager.getBuildPath();
  const resolvedFolder = path.resolve(folderPath);
  const resolvedFile = path.resolve(newPath);
  if (
    !isUnderPath(buildPath, resolvedFolder) ||
    !isUnderPath(buildPath, resolvedFile)
  ) {
    throw new Error(
      `Write rejected: path "${resolvedFile}" is outside build directory "${buildPath}"`,
    );
  }

  try {
    await fsp.access(folderPath, fs.constants.F_OK);
  } catch (e) {
    await fsp.mkdir(folderPath, { recursive: true });
  }
  await fsp.writeFile(newPath, fileContents);
};

export const writeSNFileIfNotExists = writeSNFileCurry(true);
export const writeSNFileForce = writeSNFileCurry(false);

export const writeFileForce = fsp.writeFile;

// ============================================================================
// .env File Utilities — merge-style writes (never destructive)
// ============================================================================

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteEnvValue(value: string): string {
  if (/[\s#"'\\]/.test(value)) {
    return (
      '"' +
      value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") +
      '"'
    );
  }
  return value;
}

function mergeEnvLine(content: string, key: string, value: string): string {
  const escaped = escapeRegex(key);
  const regex = new RegExp("^" + escaped + "=.*$", "m");
  const line = key + "=" + quoteEnvValue(value);

  if (regex.test(content)) {
    return content.replace(regex, line);
  }

  if (content.length > 0 && content.charAt(content.length - 1) !== "\n") {
    content += "\n";
  }
  return content + line + "\n";
}

function readEnvFile(envPath: string): string {
  try {
    return fs.readFileSync(envPath, "utf8");
  } catch (e) {
    return "";
  }
}
/**
 * @description Writes a single env variable to a .env file, preserving existing values.
 * @param {Object} params - Parameters object.
 * @param {string} params.key - The environment variable name.
 * @param {string} params.value - The value to set.
 * @param {string} [params.envPath] - Path to .env file. Defaults to process.cwd()/.env.
 */
export function writeEnvVar(params: {
  key: string;
  value: string;
  envPath?: string;
}): void {
  const resolvedPath = params.envPath || path.resolve(process.cwd(), ".env");
  const content = mergeEnvLine(
    readEnvFile(resolvedPath),
    params.key,
    params.value,
  );
  fs.writeFileSync(resolvedPath, content, "utf8");
}

/**
 * @description Writes multiple env variables to a .env file in a single read/write cycle.
 * @param {Object} params - Parameters object.
 * @param {Array<{key: string; value: string}>} params.vars - Array of key/value pairs to write.
 * @param {string} [params.envPath] - Path to .env file. Defaults to process.cwd()/.env.
 */
export function writeEnvVars(params: {
  vars: Array<{ key: string; value: string }>;
  envPath?: string;
}): void {
  const resolvedPath = params.envPath || path.resolve(process.cwd(), ".env");
  let content = readEnvFile(resolvedPath);

  params.vars.forEach(({ key, value }) => {
    content = mergeEnvLine(content, key, value);
  });

  fs.writeFileSync(resolvedPath, content, "utf8");
}
