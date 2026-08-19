<div align="center">

![Foursday](./assets/foursday-hero.svg)

# Foursday

**A personal-memory-driven work twin for real projects.**

Trusted message → personal context → real workspace → Hermes + Codex → verified work → natural reply.

[简体中文](./README_ZH.md) · [Architecture](./docs/设计总览.md) · [Gate 2 evidence](./docs/自主工作分身迁移验收报告.md) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md)

[![Checks](https://github.com/ruiwang20010702/foursday/actions/workflows/check.yml/badge.svg)](https://github.com/ruiwang20010702/foursday/actions/workflows/check.yml)
[![Security](https://github.com/ruiwang20010702/foursday/actions/workflows/security.yml/badge.svg)](https://github.com/ruiwang20010702/foursday/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-53a7ff.svg)](./LICENSE)

</div>

## What Foursday is

Foursday is an AI work twin that uses your personal gbrain and a general Hermes Agent Loop to do work—not a chatbot that needs a new capability, JSON pointer, or reply template for every question.

For an allowlisted contact, ordinary reversible work is autonomous:

- understand the conversation and route the project;
- enter the real workspace;
- inspect files, scripts, ledgers, and Git state;
- calculate, analyze, write documents, or change code;
- run tests and continue fixing failures;
- read the result back and reply with evidence.

Push, merge, production deployment, production data writes, irreversible deletion, payment, contracts, HR decisions, secrets, and irreversible commitments remain independent hard boundaries.

## One-command install

Requires macOS, Node.js 22.5+, Git, and [`uv`](https://docs.astral.sh/uv/). Python 3.13 is managed inside the isolated runtime.

```bash
git clone https://github.com/ruiwang20010702/foursday.git && cd foursday && npm ci --ignore-scripts && npm run hermes:setup -- --apply
```

Already cloned? Run `npm run hermes:setup` for a zero-write preview, then repeat with `-- --apply`. The installer is idempotent and performs the pinned-upstream, isolated-environment, patch, plugin, Profile, and Skill steps as one recoverable operation inside `.runtime/hermes-poc`.

Installation does **not** copy credentials, start the Gateway, send messages, or enable active mode. Authenticate Codex and connect your own message/memory providers after install; begin with a send-disabled shadow.

## Architecture

```mermaid
flowchart LR
    A["DWS personal DingTalk / Hermes channels"] --> B["Allowlist + session"]
    B --> C["Personal gbrain + minimal project registry"]
    C --> D["Real project workspace"]
    D --> E["Hermes Agent Loop"]
    E --> F["OpenAI Codex app-server"]
    F --> G["Search / files / terminal / tests"]
    G --> F
    F --> H["Read-back evidence + natural reply"]
    E --> I{"High-risk boundary"}
    I -->|"reversible"| G
    I -->|"external / irreversible"| J["Owner authorization"]
```

Foursday is a thin distribution on an exact Hermes upstream release:

- pinned Hermes `v2026.8.18` / `0.20.4`;
- external DWS, project-router, and high-risk-boundary plugins;
- a Foursday Profile and general project-work Skill;
- one locked three-file patch for per-session workspace persistence;
- no heavy fork and no second business-memory repository.

[Read the canonical architecture map](./docs/设计总览.md).

## Memory model

```text
Personal PRIVATE gbrain Git → durable business knowledge authority
Personal gbrain PostgreSQL  → rebuildable search/entity/graph index
Hermes Session DB           → conversation, tool calls, short-term execution
Foursday PostgreSQL         → retained rollback and governance state
```

The gbrain OAuth credential stays in a host-side read-only bridge. Agent terminal commands never receive the credential, production configuration, DWS executable, deployment secrets, or network access.

## Production status

The local V3 candidate has passed all 12 PoC gates:

- real DWS receipt from the original personal DingTalk conversation;
- autonomous 2.2 project audit: `68,786` formal questions vs `81,088` source rows;
- same-session follow-ups for release, failures, worst batch, cost, and cause;
- real project documentation, analysis, and code changes with read-back;
- one real personal self-chat send plus owner takeover interrupt;
- one separately authorized natural correction to the original contact, read back exactly once;
- unknown users, unmentioned groups, ambiguity, secret access, network, push, and deployment rejected;
- full Foursday regression passed; the live count is maintained only in the [status matrix](./docs/完成度矩阵.md);
- Hermes contract checks: 202 passed, 1 upstream conditional skip.

Hermes is now the production `active` runtime and the only message writer. The legacy Node.js writers are stopped and retained only as a tested rollback path. The exact active release passed ten-scenario shadow acceptance, a real rollback-to-legacy drill, and a second successful activation. See the [status matrix](./docs/完成度矩阵.md) for live boundaries.

[Review the full Gate 2 report](./docs/自主工作分身迁移验收报告.md).

For manual recovery, the same operation remains available as three independently repeatable stages: `hermes:prepare`, `hermes:patch`, and `hermes:install`. See the [deployment guide](./docs/en/deployment.md).

## Documentation

| Need | Canonical source |
|---|---|
| Product definition and acceptance | [Product requirements](./docs/产品需求文档.md) |
| Architecture and module map | [Design overview](./docs/设计总览.md) |
| Implementation rules | [Technical design](./docs/技术设计文档.md) |
| Current status and removed concepts | [Status matrix](./docs/完成度矩阵.md) |
| Migration evidence | [Gate 2 report](./docs/自主工作分身迁移验收报告.md) |
| Current production operations | [Legacy runtime runbook](./docs/生产运维手册.md) |
| Historical decision | [Hermes migration decision](./docs/自主工作分身架构迁移方案.md) |

## Roadmap

- [x] General Hermes/Codex loop with DWS, gbrain, routing, evidence, and hard boundaries
- [x] Real P0 conversations, follow-ups, project work, send read-back, and takeover
- [x] Reproducible thin distribution with pinned upstream and rollback-safe install
- [x] Gate 2 candidate committed and published on `main`
- [x] Controlled production migration from the legacy runtime
- [ ] Feishu, WeCom, Slack, Teams, Gmail, and Google Workspace profiles

## License

[MIT](./LICENSE)
