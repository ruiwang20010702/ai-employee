# Changelog

**English** · [简体中文](./CHANGELOG_ZH.md)

Notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic Versioning.

## [Unreleased]

Post-`v0.6.0-rc.1` candidates. Nothing in this section is part of the tagged
preview or production until a later exact-commit release.

### Added

- Optional DingTalk mobile approval for message drafts with owner-only self-chat commands, idempotent notifications, expiry, replay protection, and transactional full-draft hash binding.
- Personal PRIVATE gbrain Git is now the only durable readable memory authority. Foursday reads the personal `default` source through a dedicated OAuth client that must have `read` and must not have `write` or `admin`; bounded reply retrieval and exact-slug `knowledge_read` no longer copy personal content into a second repository.
- Foursday PostgreSQL now keeps only runtime state, governance evidence, project routing aliases, and unpromoted candidates. Legacy overlay writers, cleanup jobs, and source leases remain migration compatibility code but are not run in personal-memory mode.
- New installations create a protected Foursday configuration without a second Markdown repository, gbrain source, `GBRAIN_HOME`, or gbrain database. Personal OAuth credentials are externally injected, and readiness verifies the live identity.
- Separate opt-in switches now cover allowlisted, explicitly mentioned low-risk group replies and single-question low-risk direct clarifications. Group clarifications, work requests, and medium/high-risk content remain approval-bound.
- Project knowledge reads are pinned to project-authorized exact slugs in the personal `default` source, fixed-source project-memory extraction creates PostgreSQL candidates in the five-minute memory service, and prohibited or unauthorized work receives a deterministic capability-limit reply.
- An optional, default-off unattended-send policy may auto-approve only high-confidence, low-risk direct-chat replies with no clarification or work request. Group chat, plans, medium/high risk, human-takeover checks, idempotency, and receipt verification remain unchanged.
- The English and Chinese GitHub homepages are now concise navigation surfaces instead of duplicated product, pilot, growth, and operations manuals; canonical detail remains in the existing topic documents.
- Direct-message drafts now rebuild a bounded 24-hour conversation window, identify self versus the other participant from the exact source message, and treat messages up to two minutes apart as one review episode. Confirmed project-identity aliases route only the matching project memories and preserve that association for later shorthand in the same conversation. A later unsent draft expires the older draft and approval, including reverse completion races; unverifiable history retries instead of silently falling back to one-message drafting.
- A one-time local owner registration page collects a login identifier, optional email alias, and matching password confirmation. Existing read/write tokens prove ownership once; success atomically persists the verifier, signs the owner in, and permanently closes registration.
- The operations console and personal cockpit now share one local username-or-email and password session, while the existing read/write tokens remain available as an API and recovery compatibility path.
- A dry-run-first `config:set-admin-login` command creates the owner login with a salted `scrypt` verifier without accepting a password on the command line or storing plaintext.
- An explicit, default-zero-write admission flow for an owner-confirmed project-recipe shadow proof. It rechecks the evidence SHA, isolated ledger, project authorization, recipe baseline, and local confirmation before an idempotent production time-return import.
- Migration 022 stores confirmed shadow time returns separately from production work plans, while the personal cockpit reports both sources in one north-star total.
- Read-only recipe steps now declare artifact data flow through `evidenceStepIds`; downstream document generation consumes the exact earlier research evidence instead of inferring context from step order.
- The daily-report recipe starts with a deterministic, date-bounded repository-activity node so reports can cite exact commits and changed files within the authorized path scope instead of inferring daily work from README status.
- Daily reports also consume a project-scoped, date-bounded summary of terminal governed plans and step read-back metadata; historical evidence bodies are not recopied into the prompt, and shadow runs read only their isolated ledger.
- Personal-cockpit recipes now require a read-only plan preview before registration. The second action must submit the exact reviewed plan hash; registration still does not approve or execute the plan.
- The personal cockpit can now preview a local historical-project JSON bundle, show source-bound candidates, skips, duplicates, and conflicts, and apply only the exact typed `IMPORT-...` digest. Application creates proposed memory only and touches no external system.
- Project-memory sync is now reviewable from the cockpit: an explicit write-token action invokes the configured agent against isolated authorized files, keeps the generated bundle server-side for ten minutes, and applies it once without exposing a mutable payload to the browser.
- The cockpit can now configure project-memory authorization without hand-editing JSON. A dual-token, zero-write preview binds the current manifest, regular non-symlink source files, fact prefixes, project-bounded retention, a maximum 365-day authorization expiry, and auto-confirm policy to an exact `MEMORY-AUTH-...` confirmation. Apply atomically updates only the `0600` project manifest and does not enable the global capability gate.
- Proposed project memories are now reviewable in the owning project card. The cockpit exposes at most 20 project-scoped candidates, never cross-project candidates; confirmation and rejection still require the write token, conflicts expose the existing formal fact and require an explicit replacement action, and existing duplicates cannot be reconfirmed.
- A single cockpit work-handoff form now replaces one-prompt-at-a-time recipe entry for project, meeting, daily-report, memory, and GitHub work. It renders typed inputs together, previews the governed plan before registration, and reviews schedule time, interval, daily limit, and cooldown before saving a disabled trigger. Scheduled trigger creation must submit the same reviewed plan hash or fail closed.

### Security

- Registration is same-origin and loopback-only, requires both existing admin tokens, rejects config symlinks and existing accounts, and never persists the password or bootstrap tokens in the browser. Password sessions are memory-only, bounded to 5 minutes–24 hours, rate limited after repeated failures, issued as `HttpOnly; SameSite=Strict` loopback cookies, and require a separate CSRF token for every non-GET request. Login does not remove content-level plan/hash confirmations.
- Shadow admission never fabricates a production work plan or imports memory. The apply path requires a digest-derived confirmation and remains subject to project privacy erasure.
- Shadow research is limited to the historical-import paths already verified for that project, and downstream artifact evidence is type checked, size bounded, and treated as untrusted data.
- Expired project-memory authorization now blocks both manual model preview and the automatic sync worker before either invokes a model.

### Planned

- Easier desktop distribution and production community connectors.

## [0.6.0-rc.1] - 2026-08-13

### Added

- A zero-write project-recipe shadow preview, explicit local run, and evidence-SHA-bound human review confirmation that keep a selected research/document recipe inside one clean Git snapshot and isolated evidence ledger.
- An evidence-ranked weekly delegation queue in the personal cockpit and a read-only Codex tool that reports the remaining eight-hour goal without creating or executing plans.
- Bounded research and document previews before a completed recipe can become a time-return proposal; entered human time means actual review, verification, correction, and editing after the AI delivery.
- Historical-project import, fixed-source project-memory synchronization, five versioned recipes, and a governed work graph projected into SQLite and PostgreSQL.

### Security

- Project-recipe shadow runs reject code, memory, office, messaging, Git, and deployment capabilities; recheck the source digest and commit after model execution; and keep local review confirmation idempotent without creating production memory or time-return records.
- Weekly recommendations count only user-confirmed outcomes, fail closed on unknown capability modes or an older service without the weekly API, exclude active duplicates, and use a dedicated bounded endpoint so project objectives, memory statements, graph data, plan payloads, and blocked-capability details never enter the Codex plugin.

## [0.5.0-rc.1] - 2026-08-13

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

[Unreleased]: https://github.com/ruiwang20010702/foursday/compare/v0.6.0-rc.1...HEAD
[0.6.0-rc.1]: https://github.com/ruiwang20010702/foursday/releases/tag/v0.6.0-rc.1
[0.5.0-rc.1]: https://github.com/ruiwang20010702/foursday/releases/tag/v0.5.0-rc.1
[0.4.0]: https://github.com/ruiwang20010702/foursday/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ruiwang20010702/foursday/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ruiwang20010702/foursday/releases/tag/v0.2.0
