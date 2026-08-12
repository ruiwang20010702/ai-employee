# Add a repeatable mobile activation visual check

Labels: `good first issue`, `frontend`, `testing`

## User outcome

Contributors can verify that the onboarding form, five-step plan, and execution offer remain readable at a 390-pixel mobile viewport.

## Scope

- contributor-only visual-check script or documentation
- activation UI contract tests

## Acceptance

- Use synthetic values and the read-only preview endpoint only.
- Check a 390×844 viewport and a desktop viewport.
- Fail on horizontal overflow, missing primary action, or inaccessible plan-step labels.
- Generated screenshots go to an ignored temporary directory and never enter the release package.
- The check must not create a local execution session or call a model, Git, GitHub, DingTalk, or a production database.
- Document one command contributors can run.

## Non-goals

Do not add a production browser service, screenshot telemetry, or committed machine-specific artifacts.
