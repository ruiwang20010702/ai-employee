# Public launch playbook

Foursday should earn attention by proving that a stranger can safely hand off
real work—not by inflating stars, installs, or automation claims. This playbook
separates the current external pilot from a later broad launch and keeps every
public claim tied to evidence.

## Current launch state

Snapshot: **2026-08-12**. Re-check every number before publishing it.

| Signal | Verified state | Meaning |
|---|---:|---|
| Current-candidate maintainer loops | 0/10 | Historical 10/10 loops started from ancestor `ddd6646`; none are bound to the current candidate |
| External tester loops | 0/10 | The public pilot remains open in [Issue #49](https://github.com/ruiwang20010702/foursday/issues/49) |
| Successful installation identities | 1 | CI, package downloads, and repeated maintainer retries do not create extra users |
| GitHub Stars | 1 | A dated repository-counter snapshot, not a product-quality claim |
| Forks | 0 | No external fork has yet been counted as a completed pilot |

[Issue #49](https://github.com/ruiwang20010702/foursday/issues/49) and
[Issue #50](https://github.com/ruiwang20010702/foursday/issues/50) are pinned so
visitors can find the full pilot and the lower-friction setup check-in. Pinning
improves discovery; it does not count as an install or validation loop.

The historical maintainer cohort remains valid evidence that the earlier
governed contract ran end to end. It is not reusable launch evidence after the
candidate changed; the current candidate must complete its own 10/10 loops.

Run the anonymous aggregate read-back before every progress update:

```bash
npm run growth:report -- --sha <reviewed-40-character-candidate-sha>
```

The report reads public GitHub state, emits no identity or comment body, and
refuses to mark a broad launch ready when the two Issues drift to another
candidate, the candidate is absent from the default branch, or external loops
remain below 10/10.
The public checkbox count is only a maintainer attestation. A broad-launch gate
also requires `--pilot-manifest` to pass the private 10 + 10 evidence verifier;
the report emits only the aggregate result, never participant aliases or bundle
contents. The same run re-reads every recorded Issue and Draft PR from GitHub;
`onlineVerifiedPilotTargets` must equal the complete cohort before
`broadLaunchReady` can become true. Local evidence alone never unlocks launch.
Before inviting the external cohort, verify the current candidate's maintainer
phase separately:

```bash
npm run pilot:self:verify -- --manifest /absolute/path/maintainer.json --sha <reviewed-sha>
```

This must report ten candidate-bound maintainer loops and ten online target
read-backs; historical ancestor loops do not count.
The separate `--closed-loop-manifest` option may report progressive
`locallyVerifiedClosedLoopUsers` from the first evidence-backed user through the
90-day target of 50, but it never weakens or replaces the 10 + 10 launch gate.
If GitHub's anonymous API limit is exhausted, a standard `GH_TOKEN` or
`GITHUB_TOKEN` may authenticate only the same fixed public-repository reads;
the report records that authentication was used but never emits the token.
External contributor progress is based only on non-maintainer PR authors merged
into the default branch. Recipe/adapter labels are maintainer attestations, not
standalone proof that an extension passed its contract and safety review.
Supply `--extension-manifest` only after
`npm run extensions:evidence:verify` succeeds for the same candidate; the
growth report then re-reads the merged PR, reviewed label, and exact changed
file before setting `locallyVerifiedCommunityRecipesOrAdapters`. Without that
two-sided evidence it remains `null`.

## Launch stages

| Stage | Audience | Required evidence | Allowed call to action |
|---|---|---|---|
| Private pilot | Ten people the maintainer can support directly | Immutable one-command launch, bounded readiness, explicit approvals, Draft PR read-back | Try one synthetic task and report the real blocker |
| Public candidate | GitHub visitors and contributors | 10/10 distinct external loops, reproducible package, open safety model, current demo | Reproduce the loop, open a Draft PR, or pick a good-first issue |
| Broad launch | Developer communities | v0.5 visible from the default branch or an immutable release, current external evidence, support capacity | Run it, critique it, and contribute—never solicit coordinated votes |

Do not skip directly from maintainer evidence to a broad launch. The next honest
milestone is ten distinct external loops, not a larger claims page.

## Invite the first ten people

Personal invitations are the fastest way to learn why a qualified user does or
does not finish. Send each invitation individually and edit it for the actual
relationship. Never mass-message a workplace directory.

### English invitation

> I am testing Foursday, an open-source work twin that turns one synthetic
> GitHub Issue into an approval-bound code change, test run, and verified Draft
> PR. The preview needs only Node.js; the full loop uses your own GitHub account
> and Codex, Claude Code, or a compatible model. It does not need DingTalk or
> production credentials, and it cannot merge or deploy. Would you try the
> ten-minute candidate and tell me the first place you get stuck?
>
> Demo: https://github.com/ruiwang20010702/foursday/blob/codex/v0.5-candidate/assets/foursday-v0.5-demo.mp4
>
> Pilot: https://github.com/ruiwang20010702/foursday/issues/49

The invitation asks for friction, not praise, stars, or a passing result.

## Claims ledger

| Safe current wording | Do not claim yet |
|---|---|
| “v0.5 candidate” | “production-ready v0.5” |
| “historical maintainer loops 10/10; current candidate 0/10; external 0/10” | “current candidate validated by 10 users” |
| “one maintainer reproduced the public install” | “hundreds of installs” or package-download counts as users |
| “server-start-to-confirmed is measured; package download is separate” | “every user finishes within ten minutes” |
| “Codex, Claude Code, or a compatible provider can run the GitHub recipe” | “supports every model or workplace platform” |
| “Draft PR only; no merge or deployment” | “fully autonomous software engineer” |

Every post should link to the real repository, the 75-second demo, and either
the setup check-in or pilot Issue. Do not upload private evidence bundles,
model output, local paths, credentials, or workplace content.

## Channel rules

### GitHub

- Keep Issue #49 and Issue #50 pinned while the external cohort is open.
- Keep the repository description, topics, demo, and pilot status truthful.
- Uploading `assets/foursday-social-preview.png` in repository Settings is a
  separate maintainer action. GitHub recommends a 1280 × 640 image for best
  display; the versioned asset already matches that size and stays below 1 MB.
  See [GitHub's official social-preview guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

### Show HN

Only publish after the external pilot gate is met and the runnable v0.5 entry is
visible from the default branch or an immutable release. The maintainer must
write the submission personally; do not paste AI-generated or AI-edited copy.
The title should be factual, avoid hype, and begin with `Show HN:`. Link directly
to the runnable project, stay available for discussion, and never request votes
or coordinated comments. These constraints follow the official
[Show HN guidance](https://news.ycombinator.com/showhn.html) and
[Hacker News guidelines](https://news.ycombinator.com/newsguidelines.html).

### Other developer communities

Write a native post for each community instead of copying the same promotional
text everywhere. Lead with the personal problem—building another bounded “you”
to reclaim a workday—then show the real Issue-to-Draft-PR loop, current external
count, and the safety tradeoffs. Ask for technical criticism and reproduction,
not stars.

## Seven-day pilot sequence

1. Invite two qualified people per day until ten have started or explicitly declined.
2. Record only consented, bounded funnel states: opened, readiness blocked, preview complete, fork prepared, plan approved, Draft PR verified, outcomes confirmed.
3. Fix repeated blockers only after distinguishing product defects from missing prerequisites.
4. Independently read back every counted public Issue and Draft PR.
5. Publish aggregate progress in Issue #49; never expose identities or private evidence.
6. When 10/10 external loops are verified, update the scorecard and decide whether the candidate is ready for default-branch or immutable-release publication.
7. Only then prepare a broad community launch in the maintainer's own voice.

This document is a reviewable launch asset. Foursday never posts it, sends an
invitation, uploads the social preview, or changes a release automatically.
