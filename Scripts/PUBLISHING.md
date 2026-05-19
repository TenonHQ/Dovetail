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
(`workflow_dispatch`) — its `dry_run` input defaults to `true`. The optional
`base` input sets the diff base, so a missed publish can be replayed for an
explicit commit range.

## Authentication

The workflow authenticates to npm two ways, tried in order:

1. **Trusted Publishing (OIDC)** — preferred. If a package has a Trusted
   Publisher configured on npmjs.com pointing at this repo's `publish.yml`, the
   workflow publishes it with a short-lived OIDC token — no stored credential —
   and npm attaches a provenance attestation automatically.
2. **`NPM_TOKEN` secret** — fallback. A package without a Trusted Publisher yet
   is published with this token.

This hybrid lets packages move to Trusted Publishing one at a time. Once every
package has a Trusted Publisher, delete the `NPM_TOKEN` secret.

```bash
# Fallback token — needed until every package is on Trusted Publishing
gh secret set NPM_TOKEN -R TenonHQ/Dovetail
```

### Moving a package to Trusted Publishing

1. Ensure the package's `package.json` has a `repository` field whose URL
   matches this repo exactly — provenance generation requires it.
2. On npmjs.com, open the package's **Settings → Trusted Publisher**, choose
   **GitHub Actions**, and enter org `TenonHQ`, repo `Dovetail`, workflow
   `publish.yml`.
3. The next publish of that package authenticates via OIDC automatically.

Trusted Publishing needs npm 11.5.1+ — the workflow runs on Node 24, whose
bundled npm satisfies this.

## Troubleshooting

- **`NPM_TOKEN is not set` warning** — only affects packages without a Trusted
  Publisher yet; add the fallback token or finish the Trusted Publishing migration.
- **A publish run is red** — open the failed run in the Actions tab. Build or
  test failures block all publishing by design; fix and merge again.
- **A package didn't publish** — it only publishes if its files changed in the
  merge. Re-running is safe: version reconciliation prevents double-publishing.
