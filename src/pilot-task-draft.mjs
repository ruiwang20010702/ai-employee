const candidatePattern = /^[a-f0-9]{40}$/u;
const participantAliasPattern = /^tester-[a-z0-9][a-z0-9-]{2,23}$/u;
const issueComposer = "https://github.com/ruiwang20010702/foursday/issues/new";

export function buildPilotTaskDraft({ participantAlias, candidateSha }) {
  const alias = String(participantAlias ?? "").trim();
  if (!participantAliasPattern.test(alias)) {
    throw new Error(
      "Pilot task requires a self-chosen alias using tester- plus 3-24 lowercase letters, numbers, or hyphens",
    );
  }
  if (!candidatePattern.test(String(candidateSha ?? ""))) {
    throw new Error("Pilot task requires an immutable candidate SHA");
  }
  const changeRequest = [
    `Create docs/pilot-notes/${alias}.md with the heading Foursday external pilot ${alias}`,
    "and the sentence This synthetic file verifies the governed v0.5 fork workflow.",
    "Do not change any other file.",
  ].join(" ");
  const prTitle = `test(pilot): validate ${alias} fork loop`;
  const issueTitle = `Pilot ${alias}: verify the governed fork loop`;
  const issueBody = [
    "## Foursday v0.5 external pilot task",
    "",
    `- participant alias: ${alias}`,
    `- immutable candidate: ${candidateSha}`,
    "- source: external pilot intake Issue #49",
    "",
    "## Requested change",
    "",
    changeRequest,
    "",
    "## Safety boundary",
    "",
    "This is synthetic public test content. Keep the resulting pull request open and Draft.",
    "Do not include personal data, credentials, private repositories, workplace content, or model output.",
    "Do not merge, deploy, enable automatic sending, enable automatic execution, or enable proactive work.",
  ].join("\n");
  const url = new URL(issueComposer);
  url.searchParams.set("title", issueTitle);
  url.searchParams.set("body", issueBody);
  return Object.freeze({
    schema: "foursday-pilot-task-draft/v1",
    participantAlias: alias,
    candidateSha,
    newIssueUrl: url.toString(),
    issueTitle,
    issueBody,
    changeRequest,
    prTitle,
    baseBranch: "codex/v0.5-candidate",
    testCommandId: "check",
    externalSystemsModified: false,
  });
}
