# Public growth scorecard

Foursday's 90-day launch goal is growth with evidence, not telemetry by default.
The project does not phone home, upload local evidence, inspect private repositories,
or turn on production capabilities to improve these numbers.

## 90-day targets and baseline

Snapshot: **2026-08-13**. A dated snapshot is intentionally not presented as live data.

| Outcome | 90-day target | Verified baseline | What currently proves it |
|---|---:|---:|---|
| Successful installations | 200 | 1 | Maintainer reproduced the immutable public `npx` command with isolated HOME/Git/npm configuration, SSH and lifecycle scripts disabled, and no credential tokens forwarded; CI and reusable-install fixtures do not count |
| Distinct users with a verified closed loop | 50 | 1 | One maintainer identity completed ten independently re-read loops; ten loops by one person still count as one user |
| Completed external contributors | 10 | 1 | One non-maintainer contribution, [PR #51](https://github.com/ruiwang20010702/foursday/pull/51), passed review and was merged into `main` |
| Community recipes or adapters | 5 | 0 | Maintainer-authored examples do not count as community contributions |
| GitHub Stars | 1,000 | 1 | GitHub repository counter at the snapshot time |

Historical evidence contains **10/10 maintainer loops** started from commit
`ddd6646486d5248197f43cdfefc6d83baaeb3235`, but it was not reused for the
current gate. The public candidate
`e272f92dcebd10abbc599f32fed3e7db4428f9b7` now has **10/10 candidate-bound
maintainer loops**, all ten online targets re-read successfully, and **0/10
external tester loops**. Those ten runs still represent one maintainer identity.
External progress remains open in
[pilot Issue #49](https://github.com/ruiwang20010702/foursday/issues/49).
Successful setup reports are collected separately in
[setup check-in Issue #50](https://github.com/ruiwang20010702/foursday/issues/50).

For a current, read-only public snapshot, run:

```bash
npm run growth:report -- --sha <reviewed-40-character-candidate-sha>
```

The command reads GitHub's public API, emits aggregate counts only, and reports
whether Issues #49/#50 still point to the same immutable
candidate and whether that candidate is visible from the default branch. It
does not emit usernames or comment bodies, modify GitHub, publish anything, or
write production data. External contributors are derived from distinct
non-maintainer authors of PRs merged into the current default branch—not from
claim comments, open PRs, or the broader Contributors API. A merged external PR
with a `community-extension`, `recipe`, or `adapter` label is reported only as a
maintainer-attested community extension. The stronger
`locallyVerifiedCommunityRecipesOrAdapters` remains `null` unless a versioned
extension evidence manifest passes both local artifact validation and GitHub
target read-back; `null` must not be converted to zero by guess.
Anonymous access is the default. If GitHub's public rate limit is exhausted,
the standard `GH_TOKEN` or `GITHUB_TOKEN` environment variable may authenticate
the same fixed public-repository requests; the token is never emitted, stored,
or forwarded anywhere else.
Public checkboxes are reported as maintainer attestations, not verified loops.
The same private evidence schema supports two separate gates. For honest
90-day progress from the first verified person onward, use:

```bash
npm run growth:report -- --sha <reviewed-sha> --closed-loop-manifest /absolute/path/growth.json
```

This sets `locallyVerifiedClosedLoopUsers` to distinct external aliases plus at
most one stable maintainer identity. Multiple maintainer loops never inflate the
user count. It does not satisfy the public-candidate gate by itself.

The completed maintainer gate can be reproduced with:

```bash
npm run pilot:self:verify -- --manifest /absolute/path/maintainer.json --sha <reviewed-sha>
```

It reports ten candidate-bound local loops and ten successful online target
read-backs. The next gate is ten distinct external participants completing the
same evidence-backed workflow.

After the private 10 + 10 manifest is complete, bind the stricter launch
evidence without emitting aliases or bundle contents:

```bash
npm run growth:report -- --sha <reviewed-sha> --pilot-manifest /absolute/path/pilot.json
```

The pilot manifest must declare the same top-level `candidateSha`. Older valid
loops may remain in the cumulative closed-loop manifest, but each strict launch
bundle must also start from that candidate and old loops cannot unlock a
new candidate's launch gate.

This form runs both checks in one read-only command: local evidence validation
and live GitHub read-back for every recorded Issue and Draft PR. The latter
reconstructs the approved synthetic Issue, verifies the open Draft PR fields,
and compares title/body SHA-256 values sealed into the evidence. Only the
aggregate `onlineVerifiedPilotTargets` count is emitted. Local 10 + 10 evidence
without this successful online read-back cannot set `broadLaunchReady` to true.

Without a successful `pilot:verify` result, `locallyVerifiedExternalPilotLoops`
remains `null` and `broadLaunchReady` must remain false.

For community recipes or adapters, create a private or versioned manifest that
contains only the reviewed candidate SHA and public repository facts:

```json
{
  "schema": "foursday-community-extension-evidence/v1",
  "candidateSha": "<40-character-sha>",
  "entries": [{
    "kind": "recipe",
    "extensionId": "community-weekly-review",
    "extensionPath": "examples/recipes/community-weekly-review.json",
    "pullNumber": 123
  }]
}
```

Verify the local artifact first, then bind it into the aggregate report:

```bash
npm run extensions:evidence:verify -- --manifest /absolute/path/extensions.json --sha <reviewed-sha>
npm run growth:report -- --sha <reviewed-sha> --extension-manifest /absolute/path/extensions.json
```

The verifier rejects candidate drift, duplicate IDs, paths, or PRs, symlinks,
credential-bearing or invalid extensions, and files outside the fixed example
directories. The public report independently requires the referenced PR to be
authored externally, merged into the current default branch, carry a reviewed
extension label, and include that exact file. Neither command emits contributor
identities or modifies GitHub. The PR file blob, candidate file blob, and local
SHA-256 must all agree, so a later maintainer rewrite cannot be counted as the
original community artifact.

## Counting contract

### Successful installation

Count one installation only when a person voluntarily reports a successful
immutable one-command launch, or a maintainer directly reproduces it in a fresh
workspace and records bounded evidence. Package downloads, CI jobs, repeated
retries, and the two workspaces created by `reuse:verify` do not count.
The repeatable maintainer acceptance command is
`npm run public-install:verify -- --sha <reviewed-feature-sha>`; its JSON result
must report zero forwarded credential tokens, zero external effects, and zero
production writes.

External users can use the bounded template in Issue #50. A setup report never
counts as a verified closed-loop user and never grants repository or production
authority.

The immutable Web flow derives that same bounded template only after the
read-only readiness check returns `externalSystemsModified: false`. Copying is
local; opening Issue #50 and posting remain separate voluntary user actions.
Once fork preparation starts, the no-fork setup copy action is disabled.

The proof must contain no username, email, local path, token, model output, private
repository identity, or company data. A successful preview does not claim that a
fork, branch, PR, merge, deployment, message send, or plan execution occurred.

### User with a verified closed loop

Count each distinct consenting person once, regardless of how many loops they
complete. Every counted person needs at least one valid evidence bundle bound to
a unique Issue and Draft PR, exact plan approval, target read-back, separately
confirmed project memory, and separately confirmed returned time. The maintainer
still independently re-reads the public Issue and Draft PR. The complete local
bundle is never posted publicly.

For the ten-minute activation funnel, use two honest measurements: the tester's
install-to-preview observation and the integrity-bound local
server-start-to-confirmed monotonic-clock duration. The latter is automatically
segmented into plan creation, review, approved execution, and outcome review,
but explicitly excludes package download. Neither timing alone proves the full
promise.

### External contributor

Count a distinct non-maintainer only after a contribution is accepted into the
default branch. Claim comments, Draft PRs, reviews, and abandoned attempts are
useful funnel signals but are not completed contributors.

### Community recipe or adapter

Count a credential-free, versioned recipe or adapter contributed by a
non-maintainer only after contract tests, safety review, and merge. Renames,
duplicates, maintainer fixtures, and connectors that require hidden production
authority do not count.

### GitHub Star

Use GitHub's repository counter. Foursday does not purchase, exchange, or
automate stars.

## Evidence and privacy boundary

- Public evidence: Issue/PR URLs, immutable commit IDs, bounded plan and evidence
  hashes, Draft/open state, voluntarily supplied feedback, and aggregate counts.
- Local-only evidence: complete validation bundles, local paths, runtime logs,
  project-memory text, model output, and private repository details.
- Forbidden evidence: credentials, access tokens, real workplace messages,
  employee identifiers, internal source code, or production data.
- Product authority remains independent from growth: no target can enable
  production sending, automatic execution, proactive work, merge, or deployment.

This scorecard is deliberately conservative. Missing evidence means “not counted,”
not “probably complete.”

## Maintainer launch asset

The repository includes [`assets/foursday-social-preview.png`](../../assets/foursday-social-preview.png),
a deterministic crop of the authentic 75-second demo poster. It is a solid-background
PNG at 1280 × 640 pixels and below 1 MB, ready for GitHub's Social Preview setting.

The candidate only versions and verifies the asset. Uploading it in GitHub Settings
is a separate public metadata change and is not implied by a passing test or commit.
