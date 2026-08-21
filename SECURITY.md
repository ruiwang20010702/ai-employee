# Security Policy

[中文版](./docs/指南/安全说明.md)

Report vulnerabilities through a private GitHub Security Advisory. Do not publish credentials, message content, personal identifiers, database URLs, private gbrain pages, or internal project files.

## Current boundaries

- Unknown users and unmentioned groups are rejected before a Foursday Session is created.
- A Foursday App Server proxy forces the routed project permission profile on every Codex thread and turn, strips caller overrides, and refuses permission escalation.
- The App Server receives only runtime essentials and three host-owned MCP path bindings; the project shell excludes Foursday, DWS, identity, database, proxy, and secret variables.
- The routed project is the only writable workspace; host reads, `.env`, `.runtime`, and command network are denied.
- Project terminal commands have no network and cannot access credentials, `.env`, `.runtime`, Keychain, or other projects.
- gbrain and DWS credentials remain in narrow host-side bridges.
- Git push, merge, publish, deployment, production writes, service control, payments, contracts, HR decisions, irreversible deletion, and secret disclosure are hard-blocked.
- DWS sends require exact receipt/read-back; unknown results are not retried.
- Owner takeover interrupts in-flight work.
- Installation and configuration do not start a Gateway or enable sending.
- Install and activation verify the full pinned runtime commit, official remote, index flags, and every tracked diff; only the official installer's contributor-email stamp is tolerated.

Pin deployments to reviewed full commit SHAs. Mutable branch names are not a production trust boundary.
