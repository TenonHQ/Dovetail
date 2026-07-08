# v1 Contract Fixtures

> Frozen request/response snapshots for the 12 v1 MCP tools. Phases B–D add a `v1-contract.test.ts` suite that loads each fixture, calls the tool through `buildDescriptors()` against a clock-frozen + slug-deterministic test harness, and asserts the response is byte-identical to `response`.

A byte drift means a v1 consumer (dashboard, /resume skill, /improve-prompt, downstream CTO scripts) would see a different shape. The CI gate blocks the PR until either the consumer is updated _and_ the fixture is intentionally amended, or the regression is reverted.

## Conventions

- All timestamps in fixtures are `2026-05-26T12:00:00.000Z` (the freezer the test installs).
- All slugs are derived deterministically from the recorded `title` via the existing `slugify()` — fixtures use values that produce stable slugs.
- `content_hash` is the sha256 of `content_html ?? content_md`, recomputed at test time (the fixture records the expected hex).
- Fixtures carry a `notes` field describing why this shape matters and which downstream consumer would notice drift.

## Adding a new fixture

1. Add a new JSON file in this directory named `<tool_name>.json`.
2. Use the same envelope: `{ tool, request, response, notes }`.
3. Add the tool name to the snapshot test's table.

## Intentional amendments

If a v1 tool's response shape _must_ change (e.g. fixing a long-standing bug), update the fixture in the same PR, document the consumer migration in the PR body, and ship a CHANGELOG entry. The v1 contract is a guardrail, not a wall.
