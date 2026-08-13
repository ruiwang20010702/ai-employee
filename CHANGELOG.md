# Changelog

**English** · [简体中文](./CHANGELOG_ZH.md)

Notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic Versioning.

## [Unreleased]

### Added

- An evidence-ranked weekly delegation queue in the personal cockpit and a read-only Codex tool that reports the remaining eight-hour goal without creating or executing plans.
- Bounded research and document previews before a completed recipe can become a time-return proposal; the entered human time is the user's actual review, verification, correction, and editing after the AI delivery.

### Security

- Weekly recommendations count only user-confirmed outcomes, fail closed on unknown capability modes or an older service without the weekly API, exclude active duplicates, and use a dedicated bounded endpoint so project objectives, memory statements, graph data, plan payloads, and blocked-capability details never enter the Codex plugin.

### Planned

- Easier desktop distribution and production community connectors.

## [0.5.0] - 2026-08-12

### Added

- A ten-minute local Web onboarding path that requires no DingTalk, DWS, or production PostgreSQL for preview.
- Approval-bound Codex, Claude Code, and OpenAI-compatible execution from one GitHub Issue to a verified Draft PR.
- Downloadable privacy-bounded validation evidence plus a verifier for ten maintainer loops and ten external testers.
- A result-led English-default README, new Foursday visual identity, authentic 75-second demo contract, and five bounded first-contribution drafts.
- Personal project onboarding, a four-recipe library, project cockpit, and human-confirmed time-return ledger.
- Disabled-by-default schedule and event triggers with idempotent runs, daily limits, cooldowns, and leases.
- Meeting-to-execution and GitHub patch-to-Draft-PR recipes.
- Versioned work-event and workspace adapter contracts plus Slack, Teams, Gmail, and Google Workspace examples.

### Security

- Project memory created by recipes remains proposed until human confirmation and is erased with its requester/project source scope.
- Proactive runs reuse the same project authorization, approval, budget, takeover, idempotency, and read-back gates as message-originated work.
- Project onboarding verifies the canonical Git repository root in the shared server boundary, not only in the CLI.
- Trigger definitions reject credential material, schedule runs bind to their lease owner, and triggered plans cannot consume authorization before the exact run is durably completed.
- Community manifests must use contract version `1.0` and explicitly enable all five safety guarantees.

## [0.4.0] - 2026-08-11

### Changed

- Renamed the project to **Foursday**, an open-source work twin whose mission is to return one verified workday per user each week.
- Made `foursday` the primary CLI and retained `ai-employee` as a compatibility alias for the `0.x` line.
- Renamed the Codex marketplace, plugin, MCP server, skill, and status resource to Foursday with an explicit migration procedure.

### Added

- Versioned channel, agent-runtime, and model-provider contracts.
- A five-minute local demo without enterprise accounts or model credentials.
- Feishu Open Platform and Claude Code integration contracts alongside DingTalk/DWS and Codex.

## [0.3.0] - 2026-08-11

### Added

- Project capability manifests, work plans, approval hashes, leases, and persistent run budgets.
- Source-bound memory candidates, human confirmation, explicit conflict replacement, expiry, revocation, and privacy erasure.
- Clarification waiting chains, bounded message bundling, and human takeover across task states.
- Target read-back verification for DingTalk office actions, code work, and production release adapters.
- PostgreSQL production storage, field encryption, backup recovery, health alerts, and SLO acceptance gates.
- Exact-commit release gates, immutable release directories, crash journals, and forward-only migration boundaries.

### Security

- Minimal child-process environments prevent production secrets from reaching Codex, DWS, or candidate code.
- External effect intent is recorded before execution; unknown outcomes are never retried automatically.
- Database constraints protect persistent capability budgets from older services.

### Documentation

- Rebuilt the Chinese and English project homepages around positioning, boundaries, quick start, architecture, and roadmap.
- Added contribution, security, conduct, issue, and pull request guidance.

## [0.2.0] - 2026-08-05

### Added

- DWS message ingestion, draft generation, human approval, and send receipts.
- A local admin console, read-only Codex plugin, and macOS background services.
- SQLite development storage and the initial production diagnostic workflow.

[Unreleased]: https://github.com/ruiwang20010702/foursday/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ruiwang20010702/foursday/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ruiwang20010702/foursday/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ruiwang20010702/foursday/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ruiwang20010702/foursday/releases/tag/v0.2.0
