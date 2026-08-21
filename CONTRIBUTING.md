# Contributing to Foursday

[简体中文](./docs/指南/参与贡献.md)

Foursday is a work-twin product with one Codex Agent Loop and an embedded control plane. Contributions should strengthen that boundary instead of rebuilding another Agent Runtime around it.

## Good contributions

- Foursday connectors, policy rules, Skills, or MCP integrations;
- project routing, gbrain context, DWS, and workspace isolation improvements;
- security, restart recovery, read-back, and human-takeover tests;
- installation and documentation improvements.

Do not add business-specific capability manifests, JSON pointers, fixed reply templates, a second knowledge repository, a second Agent Loop, or a control-plane core patch.

## Development

```bash
git clone https://github.com/ruiwang20010702/foursday.git
cd foursday
npm ci
npm run check:full
npm run check:security
git diff --check
```

Use synthetic identities and data. Never commit `.runtime/`, credentials, real messages, personal identifiers, database dumps, private gbrain pages, or machine-specific paths.

Every behavioral change should cover the allowed path, denied path, timeout/failure, duplicate/restart behavior, and final read-back. A merge does not authorize deployment or message sending.

By contributing, you agree that your contribution is provided under the [MIT License](./LICENSE).
