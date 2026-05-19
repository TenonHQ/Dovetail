# Downstream package propagation — plan

> Status: **proposal** — open for review. Not yet implemented.

## Context

The Dovetail publish pipeline (`.github/workflows/publish.yml`) ships
`@tenonhq/dovetail-*` packages to npm automatically on every merge to `main`
(see [`Scripts/PUBLISHING.md`](../Scripts/PUBLISHING.md)).

What it does **not** do yet: update the repositories that *consume* those
packages. When `@tenonhq/dovetail-core` publishes a new version, the
ServiceNow app repo, `Craftsman`, and other consumers keep their old version
until someone notices and bumps it by hand.

This plan covers automating that last hop — when Dovetail publishes, **open a
dependency-bump PR in each consumer repo and raise a tracking issue there.**

## Is it possible?

**Yes.** GitHub Actions can create issues and pull requests in other
repositories. The only hard requirement is a credential beyond the workflow's
built-in `GITHUB_TOKEN`, which is scoped to the Dovetail repo alone — see
[Authentication](#authentication).

Three established mechanisms can do this; they are compared below.

## Approaches

### A. Push from Dovetail

A new job in `publish.yml`, after publishing, checks out each consumer repo,
bumps its `@tenonhq/dovetail-*` dependencies + lockfile, and opens a PR (and
issue) there directly.

- Central — Dovetail knows exactly what just shipped.
- But Dovetail must know every consumer repo and hold write credentials for
  all of them. Tightest coupling, largest blast radius. **Not recommended.**

### B. `repository_dispatch` fan-out — *recommended for a built solution*

After publishing, Dovetail sends a `repository_dispatch` event (e.g. type
`dovetail-published`) carrying the published `name@version` list to each
consumer repo. Each consumer has a small listener workflow that reacts —
bumps its own dependencies, opens its own PR, and files its own issue.

- Decoupled — each consumer owns its update logic and opens the PR in-repo
  with its own `GITHUB_TOKEN`. Dovetail only needs permission to *send the
  event*.
- Instant — fires the moment a package publishes.
- This is literally what the request describes: "have this action trigger an
  issue in another repo … and create a PR."
- Cost: each consumer repo needs the listener workflow added once.

### C. Renovate (or Dependabot) in the consumer repos — *recommended baseline*

Run Renovate in each consumer repo. When a new `@tenonhq/dovetail-*` version
hits npm, Renovate opens a version-bump PR on its own. Renovate also keeps a
per-repo **Dependency Dashboard issue** — which already satisfies the
"issue in the consumer repo" half of the ask.

- Zero custom code; battle-tested; handles grouping, scheduling, changelogs,
  auto-merge policy, and the dashboard issue.
- No Dovetail-side changes at all.
- Cost: polls the registry, so propagation is minutes-to-hours, not instant;
  less bespoke control.

## Recommendation

A two-layer rollout:

1. **Baseline — enable Renovate on the consumer repos.** It delivers most of
   the ask (auto bump-PR + dashboard issue) for near-zero effort and
   maintenance. Do this first; it may be enough on its own.
2. **If instant, event-driven propagation is wanted** (the request says
   "trigger"), layer **approach B**: Dovetail emits `repository_dispatch` on
   publish, consumers run a listener workflow. This is the correct custom
   design — decoupled, in-repo PR creation, minimal credentials in Dovetail.
3. **Skip approach A** — centralising consumer credentials in Dovetail is the
   most coupled and highest-risk option.

## Authentication

Cross-repo automation needs one of:

- **GitHub App** *(recommended)* — installed on the `TenonHQ` org, scoped to
  the specific repos, mints short-lived tokens. No personal-account
  dependency; easy to audit and revoke.
- **Fine-grained PAT** — quicker to set up; scoped to the target repos with
  Contents + Pull requests + Issues (and, for approach B, `repository_dispatch`)
  write. Tied to a user account and needs rotation.

For approach B, Dovetail needs only permission to *send* `repository_dispatch`
to the consumers; each consumer's PR and issue are created with that repo's
own `GITHUB_TOKEN`, so no broad cross-repo write credential is centralised.

## Open decisions

| Decision | Notes |
| --- | --- |
| Consumer repos | Enumerate every repo with a `@tenonhq/dovetail-*` dependency. Known/likely: the ServiceNow app repo, `Craftsman`, the CTO tooling repo. A definitive list is needed. |
| Issue **and** PR, or PR only? | Renovate's Dependency Dashboard issue may be enough; or file a dedicated issue per propagation. |
| Package scope | Propagate every package, or only `core`? |
| PR grouping | One PR per consumer with all bumps, vs one PR per package. |
| Auto-merge | Should consumer bump-PRs auto-merge when CI passes, or always need review? |

## Suggested phasing

1. Enumerate consumer repos; choose the auth mechanism (GitHub App vs PAT).
2. Enable Renovate on the consumer repos — confirm it opens bump PRs and a
   dashboard issue.
3. If instant propagation is wanted: add a `repository_dispatch` emit step to
   Dovetail's `publish.yml`, plus a reusable listener-workflow template for
   consumers.
4. Roll the listener workflow out to each consumer repo.

## Related

- [`Scripts/PUBLISHING.md`](../Scripts/PUBLISHING.md) — the publish pipeline
- Issue: *Migrate npm publishing to Trusted Publishing (OIDC)* (#76)
