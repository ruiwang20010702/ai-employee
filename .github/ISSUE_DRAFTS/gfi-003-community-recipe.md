# Add one credential-free community recipe

Labels: `good first issue`, `recipe`, `examples`

## User outcome

A contributor can copy a small versioned recipe example and understand how validated inputs become a governed plan without carrying secrets.

## Scope

- one new file under `examples/recipes/`
- `examples/README.md`
- recipe contract tests

## Acceptance

- Choose a read-only or local-only workflow with 2–4 steps.
- Use the existing recipe schema and only existing capabilities.
- Declare every input, expected evidence, and rollback boundary.
- Include no token, account, person, internal URL, arbitrary executable, or free-form filesystem target.
- `npm run extensions:validate -- --recipe examples/recipes/<file>.json` and
  `npm run check` pass.

## Non-goals

Do not add a production connector, new capability, automatic trigger, or external write.
