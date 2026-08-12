# First contributions

Foursday welcomes small changes that improve the first ten minutes without weakening its safety model. The five tasks below are deliberately bounded: each has a visible user outcome, a narrow file surface, and a deterministic acceptance check.

These are the canonical drafts for the first `good first issue` batch. Once the v0.5 candidate is pushed, maintainers publish each draft as a GitHub Issue and replace the draft link with the live Issue URL. Until then, do not claim they are already open Issues.

| ID | Outcome | Main surface | Draft |
|---|---|---|---|
| GFI-001 | Copy the exact plan hash with accessible feedback | Activation UI | [Issue draft](../../.github/ISSUE_DRAFTS/gfi-001-copy-plan-hash.md) |
| GFI-002 | Explain common preview-only setup failures without exposing local data | Activation UI and docs | [Issue draft](../../.github/ISSUE_DRAFTS/gfi-002-safe-setup-guidance.md) |
| GFI-003 | Add one credential-free community recipe | Recipe example | [Issue draft](../../.github/ISSUE_DRAFTS/gfi-003-community-recipe.md) |
| GFI-004 | Cover an OpenAI-compatible provider edge case | Provider contract tests | [Issue draft](../../.github/ISSUE_DRAFTS/gfi-004-provider-fixture.md) |
| GFI-005 | Add a repeatable mobile activation screenshot check | Contributor tooling | [Issue draft](../../.github/ISSUE_DRAFTS/gfi-005-mobile-visual-check.md) |

## Contributor path

1. Run `npm ci` and `npm run check` before editing.
2. Pick one draft and comment on the live Issue after it is published; do not work on an unassigned duplicate.
3. Keep the change inside the listed surface unless the maintainer agrees to expand it.
4. Add the allowed path and the relevant denied or failure path.
5. Run the acceptance commands from the Issue and paste their real results into the PR.

No first issue may enable production sending, plan execution, proactive triggers, credential storage, deployment, or a new external write. Those changes require a separate design and security review.
