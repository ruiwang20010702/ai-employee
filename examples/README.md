# Community extension examples

These manifests are reviewable references, not credential-ready production integrations.
Every contributed adapter must keep Foursday's authorization, approval, idempotency,
human-takeover, unknown-outcome, and target read-back guarantees. Runtime secret names
may be declared; secret values must never enter a manifest, recipe, prompt, log, or evidence.

Validate the example set, or one file you are editing, without loading credentials or
calling an external service:

```bash
npm run extensions:validate
npm run extensions:validate -- --recipe examples/recipes/my-recipe.json
npm run extensions:validate -- --adapter examples/adapters/my-adapter.json
```

The validator accepts JSON only, rejects symbolic-link files, unknown capabilities,
credential material, arbitrary recipe working directories, missing safety guarantees,
and duplicate extension IDs. A successful result validates the reviewable contract; it
does not install, authorize, execute, or claim production support for the extension.

Run `npm run check` before submitting an adapter or recipe. A real integration also needs
positive, edge, retry, mismatch, permission-denied, and crash-reconciliation tests. The
`recipes/` directory contains a credential-free, versioned community recipe that is
validated by the same contract as the built-in recipe library.
