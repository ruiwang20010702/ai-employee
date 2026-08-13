# Copy the exact plan hash with accessible feedback

Labels: `good first issue`, `frontend`, `accessibility`

## User outcome

After building a preview, a user can copy the complete plan hash without selecting a long string manually. Keyboard and screen-reader users receive a clear success or failure message.

## Scope

- `src/activation-ui.mjs`
- `test/activation-server.test.mjs`

## Acceptance

- Add a visible `Copy plan hash` action next to the hash.
- Use the Clipboard API only in response to the user action; provide a safe fallback or an explicit error.
- Announce the result through an existing or new `aria-live` region.
- Never copy an action token, repository path, prompt, or approval reason.
- Add a UI contract test covering the label and accessible feedback path.
- `node --test test/activation-server.test.mjs` and `git diff --check` pass.

## Non-goals

Do not change approval, execution, persistence, or external-effect behavior.
