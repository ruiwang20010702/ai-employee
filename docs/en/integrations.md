# Integration Guide

[Project home](../../README.md) · [Architecture](./architecture.md)

Foursday separates channels, agent CLIs, and direct model providers behind
three versioned contracts. An integration changes transport or generation; it
does not change approval, capability authorization, idempotency, takeover, or
target read-back rules.

## Message channels

| Channel | Receive path | Send path | DWS required | Status |
|---|---|---|---:|---|
| DingTalk | Local activity signal plus bounded DWS pull and reconciliation | DWS with transparent AI marker | Yes | Production adapter |
| Feishu | Official WebSocket event subscription | Official message API with UUID and read-back | No | Adapter and contract tests |
| Local demo | In-memory fixture | In-memory target | No | Five-minute demo |

The Feishu adapter intentionally does not import or invoke DWS. It supports
text messages first, ignores bot/self events, requires explicit group mentions,
deduplicates at-least-once delivery by message ID, and refuses a long
connection without an explicit user or group allowlist.

## Feishu long connection

```js
import { createFeishuLongConnection } from "foursday-runtime/src/feishu.mjs";

const connection = createFeishuLongConnection({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  selfOpenId: process.env.FEISHU_SELF_OPEN_ID,
  targetUserIds: ["ou_allowlisted_user"],
  targetGroupIds: ["oc_allowlisted_group"],
  persistMessage: async (message) => {
    // Commit message.id, senderUserId, conversationId, createTime, and content
    // to durable storage before this promise resolves.
  },
});

await connection.start();
```

The callback must only validate and durably persist the event. Never call a
model or execute work inside the event callback. If persistence fails, reject
the callback so a repeated event can be retried safely.

The repository does not yet install this connection as a managed production
service. Production credentials, platform namespacing, and deployment wiring
must be reviewed for the target tenant before enabling it.

## Agent CLIs

Select one draft runtime:

```bash
# Default
export AI_EMPLOYEE_AGENT_RUNTIME=codex
export CODEX_PATH=/absolute/path/to/codex

# Alternative
export AI_EMPLOYEE_AGENT_RUNTIME=claude-code
export CLAUDE_CODE_PATH=/absolute/path/to/claude
```

Codex and Claude Code both receive the untrusted message prompt through stdin,
run without tools, and must return the repository draft JSON Schema. CLI
errors expose exit metadata and a stderr hash, never message bodies or raw
provider errors.

## Direct model providers

Implement `ModelProvider` when an agent CLI is unnecessary:

```js
const provider = {
  id: "my-provider",
  contractVersion: "1.0",
  async generateStructured({ prompt, schema, timeoutMs, signal }) {
    // Call the provider with schema-constrained output.
    return structuredDraft;
  },
};
```

Wrap the provider with `ModelProviderAgentRuntime`. Provider credentials are
runtime-only secrets and must never enter repository configuration examples,
logs, prompts, evidence, or memory.

## Contract checklist

A contributed channel or runtime must prove:

- stable identities and at-least-once deduplication;
- direct-message allowlists and explicit group mentions;
- human-takeover detection before draft completion, plan registration, and send;
- approval-bound side effects and stable idempotency keys;
- explicit rejected versus unknown send outcomes;
- exact target read-back before completion;
- no business or infrastructure secrets in child-process environments;
- positive, edge, error, retry, and mismatch tests.

## Event, workspace, and recipe extensions

Foursday now validates four community extension kinds:

| Kind | Purpose | Repository evidence |
|---|---|---|
| `message_adapter` | Receive/send and detect human takeover | DingTalk and Feishu implementations; Slack/Teams examples |
| `work_event_adapter` | Normalize signed external events | Meeting-ended and GitHub issue normalization |
| `workspace_adapter` | Todo, calendar, document, and mail ports | Gmail/Google Workspace examples |
| `work_recipe` | Versioned inputs and plan templates | Four built-in recipes plus the credential-free community example under `examples/recipes/` |

Example manifests under `examples/adapters/` declare permission names and
runtime secret names only. They do not contain credentials, make remote calls,
or claim production support. An adapter market remains future work until
package signing, publisher identity, revocation, and trust review are designed.
Manifest contract version `1.0` is mandatory, and all five guarantees—allowlist,
idempotency, human takeover, target read-back, and unknown-outcome handling—must
be explicitly enabled or validation fails closed.

Validate all repository examples or one contribution with the credential-free,
read-only contributor command:

```bash
npm run extensions:validate
npm run extensions:validate -- --recipe examples/recipes/my-recipe.json
npm run extensions:validate -- --adapter examples/adapters/my-adapter.json
```

The command only parses bounded JSON files. It does not read runtime credential
files, import contributor code, install an extension, call a network service, or
authorize a capability. `valid: true` therefore means “ready for contract review,”
not “production ready.” Implemented adapters still require the full contract
checklist above and target-system mismatch tests.
