# Pilot validation

Foursday v0.5 is not launch-proven because the code passes tests. It becomes launch-proven only after ten maintainer loops and ten distinct external testers complete the same evidence-backed handoff.

## What counts as one loop

1. Start from the documented Quick Start and a clean candidate checkout.
2. Use one real synthetic GitHub Issue and one exact-hash approval.
3. Complete patch, isolated branch, registered test, verified push, and verified Draft PR.
4. Confirm project memory and time return separately.
5. Download the evidence bundle after confirmation. It must report `verified_closed_loop` and bind the local server-start-to-confirmed stage timings to the integrity digest.
6. Copy the privacy-safe pilot proof, replace `tester-XX`, add the separately observed install-to-preview timing and feedback, and post it to Issue #49. The generated proof already contains the rounded server-side journey and states that package download was not measured.
7. Keep the resulting Draft PR unmerged and do not deploy it as part of the pilot.

The Web page places an **Open pilot Issue #49** link beside the copy action.
Opening the page never posts the clipboard; review and submit the comment
yourself. The earlier setup check-in in Issue #50 is a separate installation
signal and does not count as an external closed loop.

If readiness is blocked, use **Copy privacy-safe readiness report** before
opening the bug form. The server constructs this report from a strict whitelist:
the immutable candidate, Node major, readiness booleans, and three editable
symptom placeholders. It never includes executable paths, usernames, private
repository details, command output, model output, environment variables, or
credentials. Copying the report and opening the form are separate local actions;
Foursday never submits it. A failed attempt is funnel evidence, not a completed
installation or pilot loop.

See the [sanitized validation evidence example](../examples/validation-evidence.example.json) for the expected bundle structure. Its `github.com/example` URLs are fictional, and the example does not count as pilot evidence.

An installation, preview, test fixture, repeated Issue, repeated PR, unconfirmed outcome, or self-written JSON does not count.

The automatic timer starts inside the launched Foursday process and covers plan
creation, review, approved execution, and outcome confirmation. It uses a
monotonic local clock and never phones home. It does not cover the package
download that happened before the process started, so the full ten-minute claim
requires both the generated server-side duration and the tester's separate
install-to-preview observation. Missing or over-ten-minute evidence is retained
as real funnel data; it is not rewritten into a passing result.

## External tester fork path

An external tester must not need upstream write access. The supported path is:

1. Run the immutable one-command Quick Start and review the exact candidate SHA.
2. In the loopback Web page, explicitly approve **Prepare my pilot fork**. This
   may create or reuse only the tester's personal fork, clone the exact commit
   under `~/FoursdayPilot/`, and install lockfile dependencies without lifecycle
   scripts. It does not run a model, push, create a PR, merge, or deploy.
3. Under **Create your unique pilot task**, keep the random browser-generated
   pseudonym or choose another safe `tester-` alias. No maintainer assignment is
   required. Open the bounded GitHub Issue composer, review and submit the
   synthetic task, then paste that new Issue URL into Foursday. Issue #49 is
   optional intake and final feedback only; it must not be reused as the work
   Issue.
4. Verify the generated defaults: base branch `codex/v0.5-candidate`, registered
   test `check`, the alias-bound change request, and Draft PR title.
5. Before approval, verify that Foursday shows the fork as the push source and
   `ruiwang20010702/foursday` as the Issue and Draft PR target.
6. After execution, verify that the evidence binds the unique Issue, fork head repository,
   governed branch, exact commit, upstream PR target, open state, and Draft flag.

The manual fork and exact-checkout commands in the README are a fallback, not a
different evidence path. Both routes must start from the same immutable SHA.

Maintainers verify the public first command separately from the private cohort:

```bash
npm run public-install:verify -- --sha <reviewed-40-character-feature-sha>
```

This networked check creates a dedicated temporary HOME and npm cache, ignores
system and user Git/npm configuration, disables SSH and lifecycle scripts,
forwards no GitHub/npm credential tokens, starts only the loopback page, checks
the unique-task and timing boundaries, and removes the temporary workspace. A
passing maintainer check is installation evidence for that maintainer only; it
does not count as an external tester or a verified closed loop.

Foursday suggests a random pseudonymous alias locally and deterministically
derives the bounded synthetic change from that alias and the immutable
candidate. It only prepares a GitHub composer URL; the tester must review and
submit it. The verifier rejects duplicate external aliases, Issues, plans,
evidence files, and Draft PRs, so removing the assignment wait does not weaken
cohort independence.
Never publish the complete local evidence bundle. Post only the generated
privacy-safe proof: it is a strict whitelist of public GitHub identities,
governed hashes, runtime, confirmed returned minutes, and feedback placeholders.
It is explicitly unsigned and still requires maintainer target read-back. Keep
the full bundle locally unless a maintainer requests it through an agreed
private channel.

## Cohort manifest

Keep evidence files and `pilot.json` in one private local directory that is not committed. Use pseudonymous external aliases and never collect a name, email address, token, repository credential, or private model output.

```json
{
  "schema": "foursday-pilot-evidence/v1",
  "candidateSha": "<reviewed-40-character-candidate-sha>",
  "entries": [
    {
      "cohort": "self",
      "participantAlias": "tester-maintainer",
      "evidencePath": "evidence/self-01.json",
      "reproducedFromQuickStart": true
    },
    {
      "cohort": "external",
      "participantAlias": "tester-ext-01",
      "evidencePath": "evidence/external-01.json",
      "reproducedFromQuickStart": true,
      "feedback": "The exact-plan approval was clear; repository setup took four minutes."
    }
  ]
}
```

After collecting at least ten entries in each cohort:

```bash
npm run pilot:verify -- --manifest /absolute/path/to/pilot.json --sha <reviewed-40-character-candidate-sha>
```

Before inviting external testers, keep the first ten maintainer entries in the
same manifest shape and verify the current candidate separately:

```bash
npm run pilot:self:verify -- --manifest /absolute/path/maintainer.json --sha <reviewed-40-character-candidate-sha>
```

This read-only command requires ten candidate-bound maintainer loops, validates
their sealed local evidence, and re-reads all ten Issues and Draft PRs from
GitHub. It emits only aggregate counts. Historical loops from an ancestor
commit do not pass this gate.

The verifier checks bundle integrity, the complete governed recipe, confirmed outcomes, unique plan/Issue/PR evidence, ten self loops, and ten unique external aliases. Every launch-cohort alias, including the stable maintainer alias, must use the same `tester-` format so the approved synthetic Issue can be reconstructed without storing its body in the aggregate report.
The strict launch verifier also requires the manifest and command to name the
same immutable candidate, and every sealed bundle must report that candidate as
its exact starting commit. Evidence from an older candidate can remain in the
cumulative 90-day growth ledger, but it cannot satisfy a newer candidate's
10 + 10 launch gate.

The public proof is intake evidence, not a replacement for the private cohort
manifest. It makes the first review reproducible without publishing local
outcome identifiers or the complete bundle.

Local bundle integrity and online GitHub proof are separate checks:

- **Local SHA-256 integrity:** the self-contained digest detects whether the sealed bundle bytes changed. It is not a signature, does not identify who ran the loop, and does not contact GitHub or prove that a recorded target still exists in the recorded state.
- **Online GitHub read-back:** immediately before launch, the maintainer must re-open every recorded target on GitHub and re-read these fields:
  - **Issue:** repository, number, URL, state, title, and body must match the approved change request.
  - **Draft PR:** repository, number, URL, open state, draft flag, head branch, head commit SHA, base branch, title, and body must match the approved plan and verified push.

A passing local report therefore keeps `targetReadbackReverificationRequired: true` until this separate online read-back is complete.
The public growth command performs that bounded online read-back only when the
private launch manifest is supplied. It rebuilds the approved synthetic Issue
from the alias and candidate SHA, compares the live Issue fields, and compares
the live Draft PR title and body to the SHA-256 values sealed into the local
evidence. The report emits only `onlineVerifiedPilotTargets`; it does not emit
aliases, URLs, repositories, titles, or bodies. `broadLaunchReady` stays false
unless every launch-cohort target passes in the same run.

## Feedback decision

Classify every external observation as `blocker`, `important`, or `suggestion`. Fix all reproducible blockers, rerun the affected loop, and keep both the failed and successful evidence. Product copy may say “tested by 10 external users” only after the cohort verifier passes and GitHub target read-back is complete.
