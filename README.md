<div align="center">

![Foursday](./assets/foursday-hero.svg)

# Foursday

**Your open-source work twin. One more you, one less workday.**

Foursday learns how you work, turns workplace messages into reviewable replies
and project-scoped plans, executes only authorized tools, and verifies the
result. Its long-term mission is simple: give every user one workday back.

DingTalk uses DWS; Feishu uses its official event and messaging APIs. Real
sending and plan execution are disabled by default, and chat content can never
grant new permissions. Foursday should work like another you without silently
impersonating you.

**English** · [简体中文](./README_ZH.md) · [Quick Start](#quick-start) · [Architecture](#architecture) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md)

[![Checks](https://github.com/ruiwang20010702/foursday/actions/workflows/check.yml/badge.svg)](https://github.com/ruiwang20010702/foursday/actions/workflows/check.yml)
[![Security](https://github.com/ruiwang20010702/foursday/actions/workflows/security.yml/badge.svg)](https://github.com/ruiwang20010702/foursday/actions/workflows/security.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-3c873a)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%20%7C%2017-4169e1)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-53a7ff.svg)](./LICENSE)

</div>

## Why Foursday?

Most AI assistants help you write. Foursday is being built to help you hand off
real work and reclaim time. The north-star outcome is **verified hours returned
per user each week**, with eight hours as the milestone for a four-day workweek.

Real work needs stronger guarantees than a chatbot. Foursday treats workplace
automation like production software:

- **Decide before replying** with allowlists, bounded message bundling, deterministic no-reply rules, and model review.
- **Authorize before executing** with project manifests, scoped capabilities, expiry, run budgets, and risk policies.
- **Approve before side effects** by binding approval to the complete plan and authorization snapshot.
- **Verify after execution** by reading the target system again instead of trusting the model or tool response.
- **Keep memory accountable** through source-bound candidates, human confirmation, conflict replacement, expiry, and revocation.
- **Let humans take over** by cancelling drafts, waiting chains, and active plans when manual work is detected.

## How it works

```mermaid
flowchart LR
    A["DingTalk / Feishu / demo message"] --> B["MessageAdapter: scope, deduplication, bounded bundling"]
    B --> C{"Ignore, ask, reply, or plan work"}
    C -->|"Ask or reply"| D["Draft awaiting approval"]
    C -->|"Work request"| E["Project plan and capability gateway"]
    E --> F{"Allow, approve, or reject"}
    F -->|"Allowed"| G["Codex / Claude Code / Git / office tools"]
    G --> H["Read back and verify target state"]
    H --> I["Result draft, memory candidate, audit trail"]
    D --> J["Final manual-takeover check"]
    J --> K["Channel-native send with receipt verification"]
```

## Highlights

| Area | What is implemented | Default boundary |
|---|---|---|
| Messaging | DingTalk/DWS and Feishu event adapters, allowlists, group mentions, deduplication | No access outside configured conversations |
| Drafting | Codex, Claude Code, provider runtimes, no-reply and clarification | Draft-only by default |
| Human control | Approval, rejection, pause, cancellation, takeover, dead-task handling | No automatic anomaly resolution |
| Project work | Project manifests, plan hashes, leases, persistent run budgets | Global execution disabled by default |
| Tools | Research, docs, code, tests, Git, release, DingTalk office actions | Explicit per-project authorization |
| Memory | Automatic candidates, human confirmation, conflict replacement, expiry, erasure | Never auto-confirms formal memory |
| Reliability | Side-effect ledger, idempotency, read-back verification, alerts, SLOs | Unknown outcomes fail closed |
| Operations | PostgreSQL, encrypted backups, nine LaunchAgents, immutable releases | Sending and execution require separate rollout |

## Quick Start

### Run the five-minute local demo

The demo needs only Node.js. It does not require DingTalk, DWS, PostgreSQL,
Codex, Claude Code, or an API key:

```bash
git clone https://github.com/ruiwang20010702/foursday.git
cd foursday
npm ci
npm run demo
```

Enter a message, review the draft, and choose whether to approve the local
simulation. Before approval, the effect ledger and evidence list remain empty.
After approval, the demo records intent, performs only an in-memory action, and
reads the simulated target back. For a non-interactive reproducible run:

```bash
npm run demo -- --message "Prepare a launch checklist" --approve --json
```

### Validate the repository without external access

```bash
git clone https://github.com/ruiwang20010702/foursday.git
cd foursday
npm ci
npm run check
```

This does not read DingTalk messages or connect to your production database or Codex account.

### Check a macOS runtime

The production DingTalk profile currently targets a logged-in macOS session and
requires Node.js 22.5+, PostgreSQL 16/17, authenticated DWS, and either Codex
or Claude Code:

```bash
npm run setup:check
```

### Install an audited immutable revision

```bash
npm init -y
npm install "github:ruiwang20010702/foursday#REPLACE_WITH_APPROVED_FULL_SHA"
npx --no-install foursday check
npx --no-install foursday init
npx --no-install foursday init --apply
npx --no-install foursday secrets
npx --no-install foursday secrets --apply
```

Replace the placeholder with a reviewed 40-character commit SHA. Initialization writes only workspace-specific Keychain references to a `600` configuration file. Mutating commands are preview-only unless `--apply` is explicitly supplied. The former `ai-employee` command remains available as a compatibility alias in the `0.x` line.

### Compatibility during the rename

Foursday is the public product, package, plugin, service, repository, and CLI
name. Existing installations remain readable and upgradeable: the
`ai-employee` CLI alias, `AI_EMPLOYEE_*` environment keys, encrypted database
sentinels, schema identifiers, HTTP compatibility headers, Prometheus metric
aliases, and legacy Keychain references remain supported throughout the `0.x`
line. New installations use `foursday`, `com.foursday.*`, and
`foursday-production`. These stable protocol identifiers are retained on
purpose; they are not the public brand and will not be silently broken by a
cosmetic rename.

## Architecture

```mermaid
flowchart LR
    DT["DingTalk"] --> DWS["DWS adapter"]
    FS["Feishu events"] --> FSA["Feishu Open Platform adapter"]
    DEMO["Local demo"] --> MA["MessageAdapter contract"]
    DWS --> MA
    FSA --> MA
    MA --> DB[("PostgreSQL")]
    DB --> W["Draft worker"]
    W --> C["Codex / Claude Code / ModelProvider"]
    DB --> E["Plan executor"]
    E --> T["DWS / Git / Tests / Release"]
    T --> V["Target read-back verification"]
    V --> DB
    DB --> A["Local admin console"]
    A --> M["Read-only Codex plugin"]
```

The system follows default-deny authorization, separates message ingestion from slow work, and combines at-least-once delivery with effect-level idempotency. See the full [architecture guide](./docs/en/architecture.md).

## Security

- Draft-only production mode by default.
- Model output and message content cannot grant capabilities.
- Human approval is bound to the complete work plan.
- AES-256-GCM field encryption for sensitive business content.
- Minimal child-process environments without database or admin secrets.
- Side-effect intent is persisted before execution; unknown outcomes are never replayed automatically.
- Local-only admin console with separate read and write tokens.
- Immutable release directories, exact Git SHAs, cloud gates, encrypted backups, and forward-only migration controls.

Report vulnerabilities privately through GitHub Security Advisories. Never include real messages, user identifiers, credentials, or internal company data in a public issue. See [SECURITY.md](./SECURITY.md).

## Documentation

| Guide | What it covers |
|---|---|
| [Overview](./docs/en/overview.md) | Product model, principles, lifecycle, and non-goals |
| [Architecture](./docs/en/architecture.md) | Components, states, side effects, security, and readiness |
| [Integrations](./docs/en/integrations.md) | DingTalk/DWS, Feishu events, Codex, Claude Code, and provider contracts |
| [Capabilities and Memory](./docs/en/capabilities.md) | Project authorization, plans, formal memory, and takeover |
| [Deployment](./docs/en/deployment.md) | Safe setup, exact-SHA releases, verification, and forward-only boundaries |
| [Security Policy](./SECURITY.md) | Private reporting and supported security boundaries |

## Roadmap

- [x] Reliable DingTalk ingestion, draft decisions, and human approval
- [x] Project capability gateway, work plans, execution evidence, and result reporting
- [x] Formal memory, takeover controls, SLOs, and immutable production releases
- [x] Interactive local demo without enterprise accounts or model credentials
- [x] Versioned MessageAdapter, AgentRuntime, and ModelProvider contracts
- [ ] Easier desktop distribution
- [x] Feishu Open Platform adapter without a DWS dependency
- [x] Claude Code and direct model-provider runtime contracts
- [ ] Production Feishu credential wizard and managed long-connection service
- [ ] More message adapters and a community example library

## Contributing

Issues, real-world use cases, documentation improvements, and code contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before contributing.

## License

[MIT](./LICENSE)
