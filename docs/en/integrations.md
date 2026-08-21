# Integrations

Use the narrowest Foursday extension surface that fits the job. The distribution maps these contracts onto its embedded control plane internally:

| Need | Extension |
|---|---|
| New messaging platform | Foursday connector |
| Project discovery or context | Profile plugin / Hook |
| Repeatable work method | Skill |
| External application API | MCP server or tool plugin |
| External or irreversible action | Separate owner-authorized exit |

Do not add a capability manifest, business-specific JSON pointer, fixed reply template, second Agent Loop, or control-plane core patch.

An integration is acceptable only when it preserves identity binding, workspace isolation, secret isolation, human takeover, idempotency, unknown-outcome handling, and exact read-back. Add positive, denial, mismatch, retry, restart, and duplicate tests with the implementation.

Current examples live in `distribution/plugins/` and `distribution/skills/`.
