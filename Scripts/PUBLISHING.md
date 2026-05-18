# Publishing

Dovetail packages publish to npm automatically on every merge to `main`. No
developer runs `npm publish`, and there is no follow-up version-bump PR.

## How it works

`.github/workflows/publish.yml` runs on every push to `main` that touches
`packages/**`:

1. **Install** — `npm ci`.
2. **Build** — `node Scripts/run-workspaces.js prepack` builds every package in
   dependency order.
3. **Test** — `node Scripts/run-workspaces.js test` runs every package's jest
   suite. Any failure stops the release — nothing publishes.
4. **Publish** — `node Scripts/publish-on-merge.js` publishes the packages that
   changed in the merge, commits the version bumps, and cuts releases.

## Versioning

Versioning is automatic patch bumps, layered on the repo's existing
`postpublish` hook (which bumps the source `package.json` after each publish,
keeping it one patch ahead of npm).

The version CI publishes is:

    max(package.json version, npm-latest-version + 1 patch)

So a clean merge publishes the version already in `package.json`, while a
concurrent-merge race (npm moved ahead of your branch) is reconciled up to the
next free patch — a version collision is impossible.

**For a minor or major release:** edit the package's `version` in your PR
(e.g. `0.0.9` → `0.1.0`). CI publishes exactly what you set.

## What gets published

Only packages whose files changed in the merge, detected with
`git diff <before> <after>`. Inter-package dependencies use `^` ranges, so a
patch bump reaches consumers without republishing them.

A package with `"private": true` in its `package.json` is never published.

## After a publish

CI commits the bumped `package.json` files and the refreshed
`package-lock.json` back to `main` as:

    chore(release): <pkg>@<version> [skip ci]

The `[skip ci]` tag stops that commit from re-triggering the workflow. A git
tag (`<pkg>@<version>`) and a GitHub Release are created for each package.

## Files

| File | Role |
| --- | --- |
| `.github/workflows/publish.yml` | The release workflow |
| `Scripts/lib/workspace.js` | Package discovery, dependency graph, toposort, semver |
| `Scripts/run-workspaces.js` | Runs an npm script across all packages in dependency order |
| `Scripts/publish-on-merge.js` | Detect → publish → commit → tag → release |
| `Scripts/bump-version.js` | The `postpublish` patch bump (unchanged) |

## Dry runs

To see what a merge would publish without shipping anything:

```bash
# Locally — diffs HEAD against its parent
node Scripts/publish-on-merge.js --dry-run

# Against a specific commit range
node Scripts/publish-on-merge.js --base=<sha> --head=<sha> --dry-run
```

Or run the **Publish packages** workflow from the Actions tab
(`workflow_dispatch`) — its `dry_run` input defaults to `true`.

## Setup

The workflow needs one repository secret: **`NPM_TOKEN`** — an npm token with
publish rights to the `@tenonhq` scope (a granular access token, or a classic
automation token; both bypass 2FA).

```bash
gh secret set NPM_TOKEN -R TenonHQ/Dovetail
```

## Troubleshooting

- **`NPM_TOKEN secret is not set`** — add the secret (see Setup).
- **A publish run is red** — open the failed run in the Actions tab. Build or
  test failures block all publishing by design; fix and merge again.
- **A package didn't publish** — it only publishes if its files changed in the
  merge. Re-running is safe: version reconciliation prevents double-publishing.
