# Public growth scorecard

Foursday's 90-day launch goal is growth with evidence, not telemetry by default.
The project does not phone home, upload local evidence, inspect private repositories,
or turn on production capabilities to improve these numbers.

## 90-day targets and baseline

Snapshot: **2026-08-12**. A dated snapshot is intentionally not presented as live data.

| Outcome | 90-day target | Verified baseline | What currently proves it |
|---|---:|---:|---|
| Successful installations | 200 | 1 | Maintainer reproduced the immutable public `npx` command from a fresh temporary directory; CI and reusable-install fixtures do not count |
| Distinct users with a verified closed loop | 50 | 1 | One maintainer identity completed ten independently re-read loops; ten loops by one person still count as one user |
| Completed external contributors | 10 | 0 | No non-maintainer contribution has been merged; one contributor has claimed [Issue #3](https://github.com/ruiwang20010702/foursday/issues/3) |
| Community recipes or adapters | 5 | 0 | Maintainer-authored examples do not count as community contributions |
| GitHub Stars | 1,000 | 1 | GitHub repository counter at the snapshot time |

The launch cohort has separately completed **10/10 maintainer loops** and
**0/10 external tester loops**. External progress remains open in
[pilot Issue #49](https://github.com/ruiwang20010702/foursday/issues/49).
Successful setup reports are collected separately in
[setup check-in Issue #50](https://github.com/ruiwang20010702/foursday/issues/50).

## Counting contract

### Successful installation

Count one installation only when a person voluntarily reports a successful
immutable one-command launch, or a maintainer directly reproduces it in a fresh
workspace and records bounded evidence. Package downloads, CI jobs, repeated
retries, and the two workspaces created by `reuse:verify` do not count.

External users can use the bounded template in Issue #50. A setup report never
counts as a verified closed-loop user and never grants repository or production
authority.

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
