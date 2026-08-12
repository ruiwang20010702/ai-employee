# 75-second authentic demo

[Watch the v0.5 candidate demo](../../assets/foursday-v0.5-demo.mp4). It uses
synthetic [Issue #29](https://github.com/ruiwang20010702/foursday/issues/29) and
the resulting verified [Draft PR #39](https://github.com/ruiwang20010702/foursday/pull/39).
Nothing was merged or deployed, and production sending, execution, and proactive
work remained disabled.

The published file is 75 seconds, 1280×720, H.264, silent, and uses burned-in
captions. A human reviewed the exact media digest for exposed credentials,
private repositories, and user-specific filesystem paths. The repository field
shown in the public recording is the synthetic `/workspace/foursday`. Run
`npm run demo:verify` to verify the media structure, exact reviewed digest,
poster, and public-evidence boundary. This command binds the visual review to
the published bytes; it does not claim automated OCR or pixel-level privacy
analysis.

The v0.5 launch demo must show one real, reviewable handoff. It is not a motion mockup and must not splice a local preview together with an unrelated pull request.

## Recording contract

- Use a public, synthetic GitHub Issue created for the demo repository.
- Start from a clean checkout at the exact candidate SHA.
- Show the Issue URL, local repository identity, selected runtime, registered test command, and Draft PR title.
- Build the preview before creating any local session. The screen must show `0 external systems touched`.
- Show the complete plan hash and explicit approval checkbox before execution.
- Keep merge and deployment unavailable.
- Show all five terminal states: patch, isolated branch, registered test, verified push, and verified Draft PR.
- Open the resulting Draft PR and show its draft state, head branch, commit, base branch, and check result.
- Return to Foursday and confirm the project-memory candidate and evidence-backed time return separately.
- Download the evidence bundle after confirmation and show `verified_closed_loop`; keep its SHA-256 digest on the final slate.
- Use only synthetic content. Hide the browser profile, unrelated tabs, filesystem username, tokens, and private repositories.
- Record the human privacy review in `assets/foursday-v0.5-demo.manifest.json` and bind it to the exact video and poster SHA-256 digests.

## 75-second storyboard

| Time | Screen | Narration |
|---:|---|---|
| 0–7s | GitHub Issue | “Give Foursday one bounded job—not your whole account.” |
| 7–17s | `npm start` and onboarding form | “Bind the Issue to a clean repository and a runtime you already use.” |
| 17–28s | Five-step preview | “Before authority, you see the complete recipe, risks, evidence, and plan hash. Nothing external has happened.” |
| 28–38s | Exact-hash approval | “One approval authorizes this plan once. It cannot merge or deploy.” |
| 38–55s | Live execution evidence | “The agent generates a patch in an isolated worktree, runs the registered test, pushes one scoped branch, and reads the Draft PR back.” |
| 55–66s | GitHub Draft PR | “The URL, draft state, branch, commit, title, and base all match the approved intent.” |
| 66–75s | Memory and time confirmation | “Only now can you confirm what the project learned and how much active time was returned.” |

## Evidence slate

End the recording with a two-second slate containing:

- candidate commit SHA;
- public Issue and Draft PR URLs;
- runtime used;
- registered test command and result;
- `memory: proposed → confirmed`;
- `time return: proposed → confirmed`;
- evidence bundle status and integrity digest;
- “No merge. No deploy. Production sending remains off.”

The recording now proves the maintainer path and public Issue-to-Draft-PR
read-back. It does not prove external reproducibility: the public v0.5 acceptance
gate still requires ten independent testers to reproduce the documented Quick
Start and publish privacy-safe feedback.
