# Explain common setup failures without exposing local data

Labels: `good first issue`, `documentation`, `ux`

## User outcome

When session creation is refused because the repository is dirty, the Issue repository differs from `origin`, or a registered test script is missing, the page gives one concise next action.

## Scope

- `src/activation-ui.mjs`
- `README.md`
- `README_ZH.md`
- activation tests only

## Acceptance

- Map only stable, public error categories to guidance; do not pattern-match or render raw paths, remote URLs, command output, or credentials.
- Keep the server response generic and the preview available.
- Cover at least the three categories above and one unknown-error fallback.
- English remains the default public copy; Chinese wording stays semantically aligned.
- Activation tests and `git diff --check` pass.

## Non-goals

Do not auto-clean a repository, edit `package.json`, change a Git remote, log in to GitHub, or bypass a failed check.
