# Pilot validation

Foursday v0.5 is not launch-proven because the code passes tests. It becomes launch-proven only after ten maintainer loops and ten distinct external testers complete the same evidence-backed handoff.

## What counts as one loop

1. Start from the documented Quick Start and a clean candidate checkout.
2. Use one real synthetic GitHub Issue and one exact-hash approval.
3. Complete patch, isolated branch, registered test, verified push, and verified Draft PR.
4. Confirm project memory and time return separately.
5. Download the evidence bundle after confirmation. It must report `verified_closed_loop`.
6. Keep the resulting Draft PR unmerged and do not deploy it as part of the pilot.

An installation, preview, test fixture, repeated Issue, repeated PR, unconfirmed outcome, or self-written JSON does not count.

## Cohort manifest

Keep evidence files and `pilot.json` in one private local directory that is not committed. Use pseudonymous external aliases and never collect a name, email address, token, repository credential, or private model output.

```json
{
  "schema": "foursday-pilot-evidence/v1",
  "entries": [
    {
      "cohort": "self",
      "participantAlias": "maintainer",
      "evidencePath": "evidence/self-01.json",
      "reproducedFromQuickStart": true
    },
    {
      "cohort": "external",
      "participantAlias": "tester-01",
      "evidencePath": "evidence/external-01.json",
      "reproducedFromQuickStart": true,
      "feedback": "The exact-plan approval was clear; repository setup took four minutes."
    }
  ]
}
```

After collecting at least ten entries in each cohort:

```bash
npm run pilot:verify -- --manifest /absolute/path/to/pilot.json
```

The verifier checks bundle integrity, the complete governed recipe, confirmed outcomes, unique plan/Issue/PR evidence, ten self loops, and ten unique external aliases.

Local bundle integrity and online GitHub proof are separate checks:

- **Local SHA-256 integrity:** the self-contained digest detects whether the sealed bundle bytes changed. It is not a signature, does not identify who ran the loop, and does not contact GitHub or prove that a recorded target still exists in the recorded state.
- **Online GitHub read-back:** immediately before launch, the maintainer must re-open every recorded target on GitHub and re-read these fields:
  - **Issue:** repository, number, URL, state, title, and body must match the approved change request.
  - **Draft PR:** repository, number, URL, open state, draft flag, head branch, head commit SHA, base branch, title, and body must match the approved plan and verified push.

A passing local report therefore keeps `targetReadbackReverificationRequired: true` until this separate online read-back is complete.

## Feedback decision

Classify every external observation as `blocker`, `important`, or `suggestion`. Fix all reproducible blockers, rerun the affected loop, and keep both the failed and successful evidence. Product copy may say “tested by 10 external users” only after the cohort verifier passes and GitHub target read-back is complete.
