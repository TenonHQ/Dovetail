# Dovetail Docs Index

Start here. Docs are tagged by audience — **🤖 Claude** (a Claude Code session using Dovetail) vs **🛠 Developer** (contributing to Dovetail).

## Start here

| Doc                                                      | Audience     | What it covers                                                                                                    |
| -------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| [`../ONBOARDING.md`](../ONBOARDING.md)                   | 🛠 Developer | Zero → merged change: Node 22, install, build order, test, branch, **DRAFT PR**, auto-publish — plus a FAQ        |
| [`claude-operating-guide.md`](claude-operating-guide.md) | 🤖 Claude    | **Canonical** capability surface: all 41 MCP tools (3 servers), the 3 CLIs, the 9 installable skills, write gates |
| [`../CLAUDE.md`](../CLAUDE.md)                           | 🤖 Claude    | In-repo working rules: config architecture, server-side REST API, releasing, troubleshooting                      |
| [`../README.md`](../README.md)                           | 🛠 Developer | Product overview + the `dove` sync workflow (origin/Sincronia history)                                            |

## Design & specification

| Doc                                                                | Audience     | What it covers                                                         |
| ------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------- |
| [`dovetail-platform-spec.md`](dovetail-platform-spec.md)           | 🛠 Developer | Complete platform spec — implement the system from zero context        |
| [`downstream-propagation-plan.md`](downstream-propagation-plan.md) | 🛠 Developer | Proposal: propagating package changes downstream (not yet implemented) |

## Migration (Sincronia → Dovetail)

| Doc                                                                    | Audience     | What it covers                                                     |
| ---------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| [`migrate-from-sincronia.md`](migrate-from-sincronia.md)               | 🛠 Developer | Upgrade an existing Sincronia project to Dovetail (`dove migrate`) |
| [`dovetail-servicenow-migration.md`](dovetail-servicenow-migration.md) | 🛠 Developer | ServiceNow-side rebrand plan (Claude → Dovetail REST API paths)    |

## Operations & QA

| Doc                                                                | Audience     | What it covers                                         |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------------ |
| [`troubleshooting-refresh-500.md`](troubleshooting-refresh-500.md) | 🛠 Developer | Diagnose `dove refresh` 500s on specific scopes        |
| [`benchmark-refresh-pr36.md`](benchmark-refresh-pr36.md)           | 🛠 Developer | `dove refresh --benchmark` impact measurement (PR #36) |
| [`qa-checklist.md`](qa-checklist.md)                               | 🛠 Developer | Programmatic verification checklist                    |
| [`qa-scorecard.md`](qa-scorecard.md)                               | 🛠 Developer | QA scorecard snapshot (2026-03-31)                     |

## Per-package READMEs

Each `packages/<pkg>/README.md` documents that package. Notables: [`packages/mcp`](../packages/mcp/README.md) (read-mostly MCP server), [`packages/claude-plans`](../packages/claude-plans/README.md) (plans MCP + CLI), [`packages/servicenow`](../packages/servicenow/README.md) (`dove-sn` authoring), [`packages/sawmill`](../packages/sawmill/README.md) (cross-instance update-set promotion).

---

_Last updated: 2026-05-29._
