const candidatePattern = /^[a-f0-9]{40}$/u;
const issueUrl = "https://github.com/ruiwang20010702/foursday/issues/new?template=bug_report.yml";

function nodeMajor(value) {
  const match = String(value ?? "").match(/^(\d{2})\./u);
  const major = Number(match?.[1]);
  if (!Number.isSafeInteger(major) || major < 22 || major > 99) {
    throw new Error("Readiness support report requires a supported Node.js version");
  }
  return major;
}

function boolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`Readiness support report requires ${name}`);
  }
  return value;
}

function status(value) {
  return value ? "ready" : "not ready";
}

export function buildReadinessSupportReport({ candidateSha, nodeVersion, readiness }) {
  if (!candidatePattern.test(String(candidateSha ?? ""))) {
    throw new Error("Readiness support report requires an immutable candidate SHA");
  }
  if (
    readiness?.schema !== "foursday-activation-readiness/v1" ||
    readiness.externalSystemsModified !== false
  ) {
    throw new Error("Readiness support report requires a completed read-only result");
  }
  const values = {
    githubCli: boolean(readiness.github?.cliAvailable, "github.cliAvailable"),
    githubAuth: boolean(readiness.github?.authenticated, "github.authenticated"),
    codex: boolean(readiness.runtimes?.codex, "runtimes.codex"),
    claudeCode: boolean(readiness.runtimes?.claudeCode, "runtimes.claudeCode"),
    openAiCompatible: boolean(
      readiness.runtimes?.openAiCompatible,
      "runtimes.openAiCompatible",
    ),
    openAiConfigurationError: boolean(
      readiness.runtimes?.openAiCompatibleConfigurationError,
      "runtimes.openAiCompatibleConfigurationError",
    ),
    pilotPreparation: boolean(
      readiness.readyForPilotPreparation,
      "readyForPilotPreparation",
    ),
    governedExecution: boolean(
      readiness.readyForGovernedExecution,
      "readyForGovernedExecution",
    ),
  };
  const markdown = [
    "### Foursday v0.5 privacy-safe readiness report",
    "",
    `- immutable candidate: ${candidateSha}`,
    `- Node.js major: ${nodeMajor(nodeVersion)}`,
    `- GitHub CLI: ${status(values.githubCli)}`,
    `- GitHub authentication: ${status(values.githubAuth)}`,
    `- Codex runtime: ${status(values.codex)}`,
    `- Claude Code runtime: ${status(values.claudeCode)}`,
    `- OpenAI-compatible runtime: ${status(values.openAiCompatible)}`,
    `- OpenAI-compatible configuration error: ${values.openAiConfigurationError ? "yes" : "no"}`,
    `- pilot fork preparation: ${status(values.pilotPreparation)}`,
    `- governed execution: ${status(values.governedExecution)}`,
    "- external systems modified by this check: no",
    "- step where I stopped: __",
    "- what I expected: __",
    "- privacy-safe symptom: __",
    "",
    "I did not include local paths, usernames, private repositories, messages, model output, or credentials.",
  ].join("\n");
  return Object.freeze({
    schema: "foursday-readiness-support/v1",
    issueUrl,
    markdown,
    externalSystemsModified: false,
  });
}
