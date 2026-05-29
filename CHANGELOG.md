# Changelog

All notable changes to this project will be documented in this file.

## [0.0.83] - 2026-04-17

### Added

- `--benchmark` flag for `sinc refresh` with workstudio measurements (#41)
- Active task banner and record links in watch log (#37)

### Fixed

- `sinc refresh` now pulls instance-side edits down to local (#36)
- `sinc refresh` gated on scope + table whitelists (#34)
- `bulkDownload` chunked, REST 500 error detail surfaced (#33)
- Dashboard session persistence and watcher scope switching (#31, #32)
- Default update set fallback warning — RFC-0004 defect 3.3 (#40)
- Restored 3 multi-scope test suites after mock gap and stale assertions (#39)

### Changed

- `@tenonhq/sincronia-core@0.0.83` / `@tenonhq/sincronia-clickup@0.0.7` published
- Internal refs bumped to core 0.0.82, clickup 0.0.6 (#44)
- RFC-0004 canonical pointer replaces duplicate copy (#38)

## [0.0.82] - 2026-04-14

### Added

- Sincronia multi-scope QA/UAT audit — 20 remediations across scope safety, API resilience, and docs (#29)

### Changed

- Removed single-scope mode, enforced multi-scope (#21)
- Multi-scope manifests handled across push, build, create, delete (#20)
- Config phase, dashboard port flag, concurrency batching (#19)
- Per-scope progress bars for sync operations (#18)

### Fixed

- `normalizeInstance` trailing slash alignment (#17)
- Skip login prompts when `.env` credentials exist (#23)

## [0.0.78] - 2026-04-10

### Added

- Multi-scope support for `sinc init` (#26)
- Dashboard task filters and default update set names (#27)
- Sincronia platform specification docs (#24)

## [0.0.73] - 2026-04-08

### Fixed

- `sinc init` no longer starts the dashboard server — plugin discovery was requiring the dashboard package which started Express as a side effect
- Dashboard `server.js` now guarded with `require.main === module` to prevent startup on `require()`

### Added

- `--port` / `-p` flag for `sinc watch` and `sinc dashboard` — run multiple sessions on different ports (e.g. `sinc watch --port 3457`)
- Port precedence: `--port` flag > `DASHBOARD_PORT` env var > default `3456`
- `sincronia-dashboard` and `sincronia-schema` added to plugin discovery skip list

### Changed

- `@tenonhq/sincronia-types@0.0.11` — added `port` to `WatchCmdArgs`
- `@tenonhq/sincronia-dashboard@0.0.8` — guarded `app.listen()` with `require.main` check
- `@tenonhq/sincronia-core@0.0.73` — discovery skip list, `--port` flag

## [0.4.1] - 2020-07-06

### Added

- updated deps version with security vulnerabilities [@collinparker-nuvolo]
- in dev mode, retries are disabledd from [@nrdurkin]

## [0.4.0] - 2020-06-19

### Added

- Installed Jest and added preliminary tests from [@tyler-ed]
- Added diff option to build and deploy commands from [@nrdurkin]
- Added documentation for new configuration options and commands from [@nrdurkin]

### Changed

- Dev mode will periodically refresh the manifest from [@nrdurkin]

## [0.3.10-alpha.0] - 2020-06-01

### Added

- Retry sending files when network error occurs while pushing to server from [@nrdurkin].
- Added status command to show current connection information from [@nrdurkin]
- Added "build" command to create static deployable bundles from [@nrdurkin].
- Added "deploy" command to deploy static bundles to servers from [@nrdurkin].

### Changed

- "sinc push" shows record count before confirmation from [@nrdurkin].
- Validate credentials during init from [@nrdurkin].
- refactored config loading during startup to be more straight forward and performent from [@nrdurkin].

### Removed

- nothing removed

## [0.3.6] - 2020-02-12

### Added

- created by [@bbarber9](https://github.com/bbarber9).

### Changed

- no changes

### Removed

- nothing removed

[0.4.1]: https://github.com/nuvolo/sincronia/releases/tag/v0.4.1
[0.4.0]: https://github.com/nuvolo/sincronia/releases/tag/v0.4.0
[0.3.6]: https://github.com/nuvolo/
[0.3.10-alpha.0]: https://github.com/nuvolo/sincronia/releases/tag/v0.3.10-alpha.0
[@nrdurkin]: https://github.com/nrdurkin
[@tyler-ed]: https://github.com/tyler-ed
[@collinparker-nuvolo]: https://github.com/collinparker-nuvolo
