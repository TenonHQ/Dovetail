---
title: Refresh Benchmark — PR #36 Impact Measurement
date: 2026-04-17
instance: tenonworkstudio.service-now.com
cli_version: feat/sinc-refresh-benchmark-flag (pre-release)
---

# Refresh Benchmark — PR #36 Impact

## Why this exists

PR #36 changed `sinc refresh` from "download files absent from disk" to
"bulk-download every manifest file and compare before writing." The author
asserted this "scales the same as `download`" but shipped no measurements.
`refresh` is a daily developer command (6 engineers); `download` is occasional.
This report is the first empirical look at the new profile.

## Method

- Instance: `tenonworkstudio.service-now.com`
- Machine: local dev, wired, warm manifest on disk
- CLI: built from `feat/sinc-refresh-benchmark-flag` against dist
- Flag: `--benchmark / -b` — opt-in; null-sink early-return means zero
  overhead when off
- Metric boundary: HTTP response-interceptor records `durationMs`,
  `responseBytes`, and `statusCode` per request; collector aggregates
  p50/p95/max + per-scope wall time, request count, and file counts

## Results

### All scopes (single pass, 8 scopes)

| Metric | Value |
|---|---|
| HTTP requests | 22 |
| Data received | 134.72 MB |
| p50 latency | 1236 ms |
| p95 latency | 12563 ms |
| Max latency | 13027 ms |
| Files written | 44 |
| Files unchanged | 7763 |
| Change ratio | 0.56% |

### Per-scope

| Scope | Wall | Req | Bytes | Written / Unchanged |
|---|---:|---:|---:|---:|
| x_cadso_automate | 2561 ms | 3 | 9.20 MB | 24 / 3706 |
| x_cadso_work | 3411 ms | 3 | 8.94 MB | 14 / 3255 |
| x_cadso_core | 1209 ms | 2 | 917.5 KB | 0 / 471 |
| x_cadso_lead | 735 ms | 2 | 399.3 KB | 0 / 101 |
| x_cadso_journey | 385 ms | 1 | 194.6 KB | 4 / 190 |
| x_cadso_cloud | 357 ms | 1 | 15.4 KB | 2 / 22 |
| x_cadso_email_spok | 295 ms | 1 | 30.0 KB | 0 / 14 |
| x_cadso_text_spoke | 233 ms | 1 | 8.6 KB | 0 / 4 |

### Single-scope spot checks (not part of the all-scopes pass)

| Scope | Wall | Req | Bytes | Written / Unchanged |
|---|---:|---:|---:|---:|
| x_cadso_core | 1162 ms | 2 | 917.5 KB | 0 / 471 |
| x_cadso_automate | 3033 ms | 3 | 9.20 MB | 26 / 3704 |

## Interpretation

- **Scale is dominated by two scopes.** `x_cadso_automate` and `x_cadso_work`
  together account for ~18 MB of in-scope download and ~6 seconds of wall
  time. The other six scopes combined land under 2 MB and finish in under
  2 seconds total. Any future work to shrink refresh cost should focus
  on these two first.
- **134 MB total for an 8-scope refresh is larger than the in-scope
  per-scope bytes sum (~19 MB).** The delta is the initial `getManifest`
  response per scope, which is recorded in the overall count but lands
  before `startScope`. This is worth flagging: a daily refresh moves
  ~135 MB from workstudio to each developer's laptop, six times a day
  across the engineering team. That is ~5 GB/day of egress on this one
  command on workstudio.
- **p95 = 12.5 s, max = 13 s.** These are the big `bulkDownload` chunks
  for the two large scopes. They sit well below any timeout threshold
  but they are the reason an all-scopes refresh feels slow. Chunking
  `BULK_DOWNLOAD_TABLE_CHUNK_SIZE` smaller than 5, or parallelizing
  within a scope, would lower p95 at the cost of more requests.
- **Change ratio is 0.56%.** 44 out of 7807 files actually changed. The
  new refresh path downloads the entire world to confirm that 99.44% of
  it did not move. This is the cost PR #36 traded in to fix the silent
  "instance edit never reaches local" bug — the fix was the right call,
  but the numbers justify a follow-up to make the comparison cheaper
  (hash-before-content, or manifest-field-based staleness) for the
  big scopes.

## Next steps

- Not in this PR: shared CLI ↔ dashboard rate limiter (RFC-0004 3.6),
  hash-first comparison path for bulk-download, auto-tuning of
  `BULK_DOWNLOAD_TABLE_CHUNK_SIZE`.
- Re-run this report after any of those land and compare.

## Reproducing

```bash
cd ServiceNow     # project with .env pointed at workstudio
npx dove refresh --benchmark                           # all scopes
npx dove refresh --benchmark --scope x_cadso_automate  # one scope
```

Output goes to the normal logger at info level. Zero overhead when
`--benchmark` is not passed.
