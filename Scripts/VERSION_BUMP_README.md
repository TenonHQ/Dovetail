# Version Bump Scripts

This directory contains scripts to automatically increment the patch version of the package.json file.

## Files

- `bump-version.js` - Node.js script that increments the patch version
- `bump-version.sh` - Shell wrapper with git integration options
- `package.json` - Updated with npm scripts for version management

## Usage

### Method 1: Direct Node Script
```bash
node bump-version.js
```
This will increment the patch version (e.g., 0.0.17 → 0.0.18)

### Method 2: NPM Scripts

```bash
# Simple version bump (no git operations)
npm run version:bump

# Bump version and create a git commit
npm run version:bump:commit

# Full release: bump version, commit, tag, and push
npm run version:bump:release
```

### Method 3: Shell Script

```bash
# Simple bump
./bump-version.sh

# Bump and commit
./bump-version.sh --commit

# Bump, commit, and tag
./bump-version.sh --commit --tag

# Full release (bump, commit, tag, and push)
./bump-version.sh --commit --tag --push
```

## Features

### Automatic Scope Detection
The script can detect Dovetail scope-based directory structures. If a `dove.config.js` file exists with scope configurations, the script will look for package.json in the appropriate scope/sourceDirectory path.

### Version Format
The script only increments the patch version (last number):
- `1.2.3` → `1.2.4`
- `0.0.17` → `0.0.18`

To change major or minor versions, edit package.json manually.

### Git Integration
When using `--commit` flag:
- Creates a commit with message: "chore: bump version to X.X.X"
- Optionally creates a git tag: `vX.X.X`
- Optionally pushes changes and tags to remote

## Examples

### For Dovetail Core Package
```bash
cd /Users/dman89/Documents/Tenon/Development/Craftsman/Dovetail/packages/core

# Quick version bump for testing
npm run version:bump

# Prepare a release
npm run version:bump:release
```

### For Scope-Based Projects
If your project uses `dove.config.js` with scopes:
```javascript
// dove.config.js
module.exports = {
  scopes: {
    myScope: {
      sourceDirectory: "src"
    }
  }
}
```

The script will automatically find `myScope/src/package.json`

### Custom Path
You can also specify a custom package.json path:
```bash
node bump-version.js /path/to/custom/package.json
```

## Error Handling

The script will fail and exit with error code 1 if:
- No package.json is found
- The version field is missing
- The version format is invalid (not major.minor.patch)
- File write permissions are denied

## Integration with CI/CD

You can use these scripts in your CI/CD pipeline:

```yaml
# GitHub Actions example
- name: Bump version
  run: npm run version:bump
  
- name: Commit and push
  run: |
    git config user.name "GitHub Actions"
    git config user.email "actions@github.com"
    npm run version:bump:commit
    git push
```

## Notes

- Always ensure you're on the correct branch before bumping versions
- The script preserves the JSON formatting (2-space indentation)
- Git operations require appropriate permissions and configurations
- Consider using semantic versioning practices for major/minor updates