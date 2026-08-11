# Changelog

**English** · [简体中文](./CHANGELOG_ZH.md)

Notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic Versioning.

## [Unreleased]

### Planned

- An interactive demo that does not require a real DingTalk account.
- Easier desktop distribution and a community example library.

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

[Unreleased]: https://github.com/ruiwang20010702/ai-employee/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ruiwang20010702/ai-employee/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ruiwang20010702/ai-employee/releases/tag/v0.2.0
