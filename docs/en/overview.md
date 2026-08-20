# Foursday Documentation Map

Foursday is a personal-memory-driven Hermes work twin. This page maps canonical documentation; it does not duplicate live status.

## Canonical owners

| Question | Canonical source |
|---|---|
| What is the product and how is it accepted? | [Product requirements](./product-requirements.md) |
| What exists and how does it work? | [Architecture](./architecture.md) |
| What is currently complete or intentionally removed? | [Chinese status matrix](../完成度矩阵.md) |
| What passed Gate 2? | [Gate 2 report](../历史/自主工作分身迁移验收报告.md) |
| Why did the runtime change? | [Migration decision](../历史/自主工作分身架构迁移方案.md) |
| How does current production run? | [Legacy production runbook](../生产运维手册.md) |
| What rules must contributors obey? | [Security](../../SECURITY.md), [Contributing](../../CONTRIBUTING.md) |

## Architecture at a glance

```mermaid
flowchart LR
    MSG["Trusted message"] --> ROUTE["Session + project route"]
    GB["Personal gbrain"] --> ROUTE
    ROUTE --> LOOP["Hermes + Codex"]
    LOOP --> WORK["Real workspace work"]
    WORK --> EVIDENCE["Read-back evidence"]
    EVIDENCE --> REPLY["Personal-account reply"]
    LOOP --> BOUNDARY["Independent high-risk boundary"]
```

## Code map

| Need | Source |
|---|---|
| Native Hermes compatibility/install | `src/hermes-upstream.mjs`, `src/foursday-hermes-native-install.mjs` |
| DWS personal DingTalk | `src/hermes-dws-sidecar.mjs`, `hermes/plugins/dws_personal/` |
| Project routing | `hermes/plugins/project_router/` |
| Personal gbrain | `src/hermes-personal-memory-context.mjs`, `hermes/plugins/gbrain_memory/`, `src/personal-gbrain-*.mjs` |
| Tool isolation/high risk | `hermes/plugins/foursday_boundary/` |
| Profile and Skills | `hermes/profile/`, `hermes/skills/` |
| Native Profile/Gateway | `scripts/安装Foursday原生Hermes.mjs`, `scripts/配置Foursday原生Hermes.mjs`, `scripts/管理Foursday原生Gateway.mjs` |
| Legacy production | `src/listener.mjs`, `src/worker.mjs`, `src/plan-executor.mjs` |

## State boundary

- Production is intentionally paused; both Gateways are stopped and disabled, so there is currently no production sender.
- The native Hermes Profile candidate has passed isolated profile installation and plugin validation only.
- The native profile-scoped Gateway is not yet installed or running in production.
- Production send authority does not transfer until a new shadow and single-writer cutover are explicitly authorized.
