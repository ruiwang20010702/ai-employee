# Architecture

[Overview](./overview.md) · [简体中文技术设计](../技术设计文档.md)

## System shape

Foursday separates fast message ingestion, slow model work, external side effects, and human control. PostgreSQL is the production state and evidence store; SQLite is retained for local development and parity testing.

```mermaid
flowchart LR
    CHANNEL["DingTalk / Feishu / Demo"] --> MESSAGE["MessageAdapter"]
    MESSAGE --> DB[("PostgreSQL")]
    DB --> WORKER["Draft worker"]
    WORKER --> RUNTIME["AgentRuntime"]
    RUNTIME --> PROVIDER["ModelProvider or agent CLI"]
    DB --> EXECUTOR["Plan executor"]
    EXECUTOR --> ADAPTERS["DWS / Git / Tests / Release"]
    ADAPTERS --> VERIFY["Target read-back"]
    VERIFY --> DB
    DB --> ADMIN["Local admin console"]
    ADMIN --> MCP["Read-only Codex plugin"]
```

## Main components

| Component | Responsibility |
|---|---|
| Listener | Receive normalized adapter messages, deduplicate them, reconcile gaps, and build bounded bundles |
| Draft worker | Decide ignore/clarify/reply/work, generate drafts, propose memory, and detect human takeover |
| Policy engine | Evaluate requester, project, capability, risk, target scope, expiry, and persistent run budget |
| Plan executor | Acquire leases, revalidate policy, run one step at a time, and persist evidence |
| Work adapters | Provide narrow interfaces for research, documents, code, Git, DingTalk work, and releases |
| Stores | Encrypt business content and enforce transactional state transitions in SQLite and PostgreSQL |
| Health and alerts | Track heartbeats, dead tasks, unknown sends, leases, message coverage, and SLO samples |
| Admin console | Expose local review and control with separate read/write tokens |
| Codex plugin | Present read-only status, drafts, plans, capabilities, and takeover information |

## Versioned integration contracts

The runtime exposes three independent `1.0` contracts:

| Contract | Owns | Does not own |
|---|---|---|
| `MessageAdapter` | Message identity, scoped ingestion, conversation context, manual-reply detection, sending, and receipt read-back | Reply policy, project authorization, or model selection |
| `AgentRuntime` | Producing a schema-validated draft through an agent such as Codex or Claude Code | Message credentials or permission to execute work |
| `ModelProvider` | Structured model generation for provider-backed runtimes | Tool authorization, side effects, or approval state |

DWS is contained inside the DingTalk adapter. The Feishu adapter uses Feishu's
official event subscription and messaging APIs and has no DWS dependency. Adapters
share normalized identities and lifecycle semantics, not platform credentials
or platform-specific fields.

### Channel-specific receive paths

```mermaid
sequenceDiagram
    participant DT as DingTalk desktop
    participant DWS as DingTalk DWS adapter
    participant FS as Feishu WebSocket
    participant FA as Feishu adapter
    participant DB as Durable store
    DT-->>DWS: Local database activity signal
    DWS->>DWS: Pull allowlisted messages and reconcile gaps
    DWS->>DB: Persist normalized messages
    FS->>FA: im.message.receive_v1 event
    FA->>FA: Validate sender, text, group mention, and event identity
    FA->>DB: Persist before the callback returns
    Note over FA,DB: Model work never runs inside the event callback
```

Feishu delivery is at least once, so the adapter deduplicates by message ID.
Only direct messages and allowlisted group messages that explicitly mention the
work twin are eligible. Sending uses Feishu's native UUID field; completion
still requires an exact message ID, conversation, and text read-back.

### Agent runtime selection

Set `AI_EMPLOYEE_AGENT_RUNTIME=codex` (default) or
`AI_EMPLOYEE_AGENT_RUNTIME=claude-code`. Pin `CODEX_PATH` or
`CLAUDE_CODE_PATH` in managed environments. Both CLIs receive the draft prompt
through stdin, run without tools, and must return the same JSON Schema. Direct
model integrations implement `ModelProvider` and inherit the same draft
validation.

## Message lifecycle

Messages are received at least once and deduplicated by platform identity. Nearby messages from one conversation are bundled within a bounded quiet window, with a hard maximum from the first message. Explicit urgent input may close the bundle early.

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> processing
    processing --> no_reply
    processing --> awaiting_approval
    processing --> waiting_information
    awaiting_approval --> approved
    awaiting_approval --> rejected
    approved --> sending
    sending --> completed
    sending --> send_unknown
    waiting_information --> continuation_pending
    continuation_pending --> continued
    processing --> dead
    awaiting_approval --> cancelled_manual
    waiting_information --> cancelled_manual
```

Clarification chains reserve exactly one relevant continuation. Late-ingested messages that occurred before the question, ambiguous candidates, unrelated messages, expired waits, and human replies are handled without guessing.

## Work-plan lifecycle

A model may propose work, but the runtime builds and validates the executable plan. Approval binds the complete normalized plan, project authorization version, capability policy, and budget identity.

```mermaid
sequenceDiagram
    participant W as Draft worker
    participant P as Policy engine
    participant H as Human reviewer
    participant E as Executor
    participant T as Target system
    W->>P: Proposed normalized plan
    P-->>W: allow / approval required / deny
    P->>H: Complete hashed plan when required
    H-->>P: Approval bound to current hash
    E->>P: Revalidate before consumption and each step
    E->>T: Record intent, then execute
    E->>T: Read target state back
    E-->>W: Verified evidence or fail-closed result
```

## Side-effect reliability

- Every external effect uses an idempotency key and a persisted intent record.
- A completed effect requires a corresponding ledger entry.
- Adapter success must be followed by target-system verification.
- Cancellation checks preserve evidence from an effect that may already have happened.
- Unknown outcomes enter an explicit reconciliation state and are never automatically replayed.

This provides at-least-once message handling with effect-level exactly-once behavior where the target and adapter support it.

## Security boundaries

- Sensitive business fields use AES-256-GCM encryption at rest.
- Production secrets come from Keychain or controlled environment references, never repository files.
- Codex, DWS, candidate code, and release checks receive minimal child-process environments.
- Paths, commands, remotes, document targets, people, templates, and time ranges are allowlisted.
- The local console binds to loopback and separates read and write credentials.
- Release artifacts are tied to an exact Git SHA and rechecked before activation.

## Observability and readiness

Liveness, service availability, strict business readiness, and rollout acceptance are different results:

| Result | Meaning |
|---|---|
| Liveness | The process is running |
| Service available | Required components and the target release can serve safely |
| Business ready | No dead tasks, failed plans, unknown sends, expired leases, or other strict blockers |
| Rollout accepted | Quality samples, long-window SLOs, side-effect evidence, and memory conflict gates pass |

For the complete entity model, SQL schema, concurrency rules, tests, and architecture decisions, see the [Chinese production design](../技术设计文档.md).
