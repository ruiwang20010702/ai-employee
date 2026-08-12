# First contributions

Foursday welcomes small changes that improve the first ten minutes without weakening its safety model. The five tasks below are deliberately bounded: each has a visible user outcome, a narrow file surface, and a deterministic acceptance check.

All five tasks are live. Claim a task by commenting on its GitHub Issue before editing. The repository draft remains the versioned source for scope and acceptance, while the live Issue is authoritative for availability, assignment, and discussion.

| ID | Outcome | Main surface | Claim task | Versioned contract |
|---|---|---|---|---|
| GFI-001 | Copy the exact plan hash with accessible feedback | Activation UI | [Issue #3](https://github.com/ruiwang20010702/foursday/issues/3) | [Contract](../../.github/ISSUE_DRAFTS/gfi-001-copy-plan-hash.md) |
| GFI-002 | Explain common preview-only setup failures without exposing local data | Activation UI and docs | [Issue #4](https://github.com/ruiwang20010702/foursday/issues/4) | [Contract](../../.github/ISSUE_DRAFTS/gfi-002-safe-setup-guidance.md) |
| GFI-003 | Add one credential-free community recipe | Recipe example | [Issue #5](https://github.com/ruiwang20010702/foursday/issues/5) | [Contract](../../.github/ISSUE_DRAFTS/gfi-003-community-recipe.md) |
| GFI-004 | Cover an OpenAI-compatible provider edge case | Provider contract tests | [Issue #6](https://github.com/ruiwang20010702/foursday/issues/6) | [Contract](../../.github/ISSUE_DRAFTS/gfi-004-provider-fixture.md) |
| GFI-005 | Add a repeatable mobile activation screenshot check | Contributor tooling | [Issue #7](https://github.com/ruiwang20010702/foursday/issues/7) | [Contract](../../.github/ISSUE_DRAFTS/gfi-005-mobile-visual-check.md) |

## Contributor path

1. Run `npm ci` and `npm run check` before editing.
2. Pick one live Issue and comment before starting; do not work on an unclaimed duplicate.
3. Keep the change inside the listed surface unless the maintainer agrees to expand it.
4. Add the allowed path and the relevant denied or failure path.
5. Run the acceptance commands from the Issue and paste their real results into the PR.

No first issue may enable production sending, plan execution, proactive triggers, credential storage, deployment, or a new external write. Those changes require a separate design and security review.
