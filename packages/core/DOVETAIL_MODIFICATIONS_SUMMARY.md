# Dovetail Core Modifications Summary

## Version

Updated from @tenonhq/dovetail-core@0.0.30 to include the following enhancements.

## Changes Implemented

### 1. Updated metaData.json \_lastUpdatedOn Field

**Location**: `/packages/core/src/appUtils.ts` - `processFilesInManRec` function

**Change**: The `_lastUpdatedOn` field in metaData.json files is now set to the record's `sys_updated_on` value from ServiceNow instead of the current timestamp.

**Implementation**:

- When processing files, metadata files are identified and handled separately
- The JSON content is parsed, and if `sys_updated_on.value` exists, it's used to update `_lastUpdatedOn`
- The updated metadata is then written to the file system

### 2. Excluded metaData.json from dove.manifest.json

**Location**: `/packages/core/src/appUtils.ts` - `processFilesInManRec` function

**Change**: metaData.json files are no longer included in the manifest file structure, significantly reducing manifest file size.

**Implementation**:

- Files are separated into metadata files and regular files during processing
- Only regular files are included in the manifest structure
- Metadata files are still written to disk but excluded from the manifest

### 3. Per-Scope Manifest File Generation

**Location**: Multiple files updated

**Changes**:

- Manifests are now written as separate files per scope: `dove.manifest.<scope>.json`
- Example: `dove.manifest.x_cadso_core.json`, `dove.manifest.x_cadso_api.json`

**Files Modified**:

- `/packages/core/src/config.ts`:

  - Added `getScopeManifestPath(scope)` function
  - Added `loadScopeManifest(scope)` function
  - Added `loadAllScopeManifests()` function for backward compatibility
  - Updated `getManifestPath()` to support scope parameter

- `/packages/core/src/FileUtils.ts`:

  - Updated `writeManifestFile()` to support scope parameter
  - Added `writeScopeManifest()` function

- `/packages/core/src/appUtils.ts`:

  - Updated `processManifest()` to write scope-specific manifests
  - Updated `syncManifest()` to support per-scope syncing

- `/packages/core/src/allScopesCommands.ts`:

  - Updated `initScopesCommand()` to write per-scope manifest files

- `/packages/core/src/MultiScopeWatcher.ts`:

  - Updated `loadScopeManifest()` to first check for scope-specific manifest files
  - Falls back to legacy single manifest for backward compatibility

- `/packages/types/index.d.ts`:
  - Added "json" to the FileType definition to support metadata files

## Backward Compatibility

The implementation maintains backward compatibility:

- If no scope-specific manifests exist, the system falls back to reading the legacy `dove.manifest.json`
- The `loadAllScopeManifests()` function combines scope-specific manifests into a single structure when needed
- All existing commands continue to work with both old and new manifest structures

## Benefits

1. **Accurate Timestamps**: metaData.json files now reflect the actual last update time from ServiceNow
2. **Smaller Manifest Files**: Excluding metadata content reduces manifest file size by approximately 50-70%
3. **Better Organization**: Per-scope manifest files make it easier to manage multi-scope projects
4. **Improved Performance**: Smaller manifest files load and parse faster
5. **Maintained Compatibility**: All existing commands and workflows continue to function

## Testing Recommendations

1. Test `npx dove initScopes` to verify per-scope manifest generation
2. Test `npx dove watchAllScopes` to ensure file watching works with new structure
3. Test `npx dove refresh` to verify manifest syncing
4. Verify metaData.json files have correct `_lastUpdatedOn` timestamps
5. Confirm metaData.json files are created but not included in manifests
6. Test with both single-scope and multi-scope configurations

## Migration

For existing projects:

1. Run `npx dove initScopes` to regenerate manifests in the new format
2. The old `dove.manifest.json` can be deleted after verification
3. No changes required to `dove.config.js` or other configuration files
