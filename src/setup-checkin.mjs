const candidatePattern = /^[a-f0-9]{40}$/u;
const issueUrl = "https://github.com/ruiwang20010702/foursday/issues/50#new_comment_field";

function nodeMajor(value) {
  const match = String(value ?? "").match(/^(\d{2})\./u);
  const major = Number(match?.[1]);
  if (!Number.isSafeInteger(major) || major < 22 || major > 99) {
    throw new Error("Setup check-in requires a supported Node.js version");
  }
  return major;
}

export function buildSetupCheckin({ candidateSha, nodeVersion, readiness }) {
  if (!candidatePattern.test(String(candidateSha ?? ""))) {
    throw new Error("Setup check-in requires an immutable candidate SHA");
  }
  if (
    readiness?.schema !== "foursday-activation-readiness/v1" ||
    readiness.externalSystemsModified !== false
  ) {
    throw new Error("Setup check-in requires a completed read-only readiness result");
  }
  const markdown = [
    "### Foursday v0.5 setup check-in",
    "",
    `- immutable candidate: ${candidateSha}`,
    `- Node.js: ${nodeMajor(nodeVersion)}`,
    "- platform: macOS / Linux (choose one)",
    "- loopback Web page opened: yes",
    "- read-only readiness check completed: yes",
    "- fork, branch, push, or PR created by this readiness check: no",
    "- production deployment performed by this launch or readiness check: no",
    "- automatic sending, execution, or proactive work enabled by this launch or readiness check: no",
    "- approximate setup time: __ minutes",
    "- one friction point or none: __",
  ].join("\n");
  return Object.freeze({
    schema: "foursday-setup-checkin/v1",
    issueUrl,
    markdown,
    externalSystemsModified: false,
  });
}
