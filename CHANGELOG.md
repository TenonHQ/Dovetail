# Changelog

This monorepo no longer keeps a hand-written root changelog — it drifted (it stopped at
`0.0.83` and still used the pre-rebrand "Sincronia" names while packages moved well past it).

Release notes are now **generated automatically, per package, on publish**:

- **GitHub Releases** — every merge to `main` that publishes a package cuts a tagged Release
  (`<package>@<version>`) whose body is that package's own commit log for the range. Browse them at
  [github.com/TenonHQ/Dovetail/releases](https://github.com/TenonHQ/Dovetail/releases).
  Mechanism: `Scripts/publish-on-merge.js` → `createReleases()`.
- **Capability reference** — what Claude/devs can *do* with each shipped capability lives in
  [`docs/claude-operating-guide.md`](docs/claude-operating-guide.md), kept current from the same
  release-event feed (`dove knowledge-diff` → `dovetail-features-sync`).

Some packages still carry their own `CHANGELOG.md` (e.g. `packages/claude-plans`) for hand-curated
narrative notes; those remain authoritative for their package.
