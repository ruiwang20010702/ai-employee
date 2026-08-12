# Community extension examples

These manifests are reviewable references, not credential-ready production integrations.
Every contributed adapter must keep Foursday's authorization, approval, idempotency,
human-takeover, unknown-outcome, and target read-back guarantees. Runtime secret names
may be declared; secret values must never enter a manifest, recipe, prompt, log, or evidence.

Run the repository checks before submitting an adapter or recipe. A real integration also
needs positive, edge, retry, mismatch, permission-denied, and crash-reconciliation tests.
The `recipes/` directory contains a credential-free, versioned community recipe that is
validated by the same contract as the built-in recipe library.
