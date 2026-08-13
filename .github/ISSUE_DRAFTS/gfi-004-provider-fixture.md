# Cover one OpenAI-compatible provider edge case

Labels: `good first issue`, `testing`, `model-provider`

## User outcome

Users get a stable, secret-free error when an OpenAI-compatible endpoint returns malformed structured content or an unsupported redirect.

## Scope

- `test/openai-compatible-provider.test.mjs`
- `src/openai-compatible-provider.mjs` only if the new test proves a real contract gap

## Acceptance

- Add one deterministic `fetchImpl` fixture for an uncovered response edge.
- Assert the stable error code and prove the response body and API key are absent from the error.
- Preserve HTTPS-or-loopback URL policy, redirect refusal, timeout, and cancellation.
- Do not add a provider SDK dependency.
- Targeted provider tests and `git diff --check` pass.

## Non-goals

Do not add provider-specific authentication, pricing, model recommendations, retries, or a real network call.
