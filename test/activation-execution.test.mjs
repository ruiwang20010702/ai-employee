import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildActivationPreview } from "../src/activation.mjs";
import {
  ActivationExecutionCoordinator,
  inspectActivationReadiness,
  inspectActivationRepository,
  prepareActivationExecution,
} from "../src/activation-execution.mjs";

const execFileAsync = promisify(execFile);

const input = {
  projectId: "example-project",
  projectName: "Example project",
  rootDirectory: "/workspace/example",
  requesterId: "owner-1",
  runtime: "codex",
  issueUrl: "https://github.com/example/project/issues/42",
  changeRequest: "Fix the startup error without changing public APIs.",
  testCommandId: "check",
  baseBranch: "main",
  prTitle: "fix: keep startup compatible",
};

async function previewBuilder(value) {
  return buildActivationPreview(value, {
    onboardingBuilder: async (onboarding) => {
      const { buildProjectOnboardingDraft } = await import("../src/project-onboarding.mjs");
      return buildProjectOnboardingDraft({
        ...onboarding,
        realpathFn: async (path) => path,
        gitRootFn: async (path) => path,
      });
    },
  });
}

const snapshot = {
  head: "a".repeat(40),
  remoteUrl: "https://github.com/example/project.git",
  repository: "example/project",
};

test("activation readiness exposes only bounded GitHub and runtime booleans", async () => {
  const calls = [];
  const result = await inspectActivationReadiness({
    environment: {
      HOME: "/private/home/should-not-leak",
      GH_PATH: "/usr/bin/true",
      CODEX_PATH: "/usr/bin/true",
      CLAUDE_CODE_PATH: "/missing/claude",
      SECRET_SENTINEL: "must-not-leak",
    },
    openAiCompatibleConfigured: true,
    githubAuthCheck: async (path, environment) => {
      calls.push({ path, environment });
      return true;
    },
  });

  assert.deepEqual(result, {
    schema: "foursday-activation-readiness/v1",
    externalSystemsModified: false,
    github: { cliAvailable: true, authenticated: true },
    runtimes: {
      codex: true,
      claudeCode: false,
      openAiCompatible: true,
      openAiCompatibleConfigurationError: false,
    },
    readyForPilotPreparation: true,
    readyForGovernedExecution: true,
  });
  assert.equal(calls[0].path, "/usr/bin/true");
  assert.doesNotMatch(JSON.stringify(result), /private|SECRET_SENTINEL|must-not-leak/u);
});

test("activation readiness fails closed for missing auth and invalid model configuration", async () => {
  const result = await inspectActivationReadiness({
    environment: {
      GH_PATH: "/usr/bin/true",
      CODEX_PATH: "/missing/codex",
      CLAUDE_CODE_PATH: "/missing/claude",
    },
    openAiCompatibleConfigurationError: true,
    githubAuthCheck: async () => false,
  });

  assert.equal(result.github.cliAvailable, true);
  assert.equal(result.github.authenticated, false);
  assert.equal(result.runtimes.codex, false);
  assert.equal(result.runtimes.claudeCode, false);
  assert.equal(result.runtimes.openAiCompatible, false);
  assert.equal(result.runtimes.openAiCompatibleConfigurationError, true);
  assert.equal(result.readyForPilotPreparation, false);
  assert.equal(result.readyForGovernedExecution, false);
  assert.equal(result.externalSystemsModified, false);
});

async function candidate() {
  return prepareActivationExecution(input, {
    previewBuilder,
    repositoryInspector: async () => snapshot,
    commandBuilder: async () => ({
      executable: "/usr/bin/true",
      args: [],
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    }),
  });
}

test("activation repository inspection requires a clean credential-free GitHub origin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-activation-repository-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await execFileAsync("/usr/bin/git", ["-C", directory, "init", "-b", "main"]);
  await execFileAsync("/usr/bin/git", ["-C", directory, "config", "user.name", "Foursday Test"]);
  await execFileAsync("/usr/bin/git", ["-C", directory, "config", "user.email", "foursday@example.invalid"]);
  await writeFile(join(directory, "README.md"), "fixture\n");
  await execFileAsync("/usr/bin/git", ["-C", directory, "add", "README.md"]);
  await execFileAsync("/usr/bin/git", ["-C", directory, "commit", "-m", "initial"]);
  await execFileAsync("/usr/bin/git", ["-C", directory, "remote", "add", "origin", "git@github.com:Example/Project.git"]);
  await execFileAsync("/usr/bin/git", [
    "-C", directory, "remote", "add", "upstream",
    "https://github.com/Upstream/Project.git",
  ]);
  const snapshot = await inspectActivationRepository(directory);
  assert.equal(snapshot.repository, "example/project");
  assert.equal(snapshot.upstreamRepository, "upstream/project");
  assert.match(snapshot.head, /^[a-f0-9]{40}$/u);
  await writeFile(join(directory, "untracked.txt"), "must block\n");
  await assert.rejects(
    inspectActivationRepository(directory),
    /worktree must be clean/u,
  );
  await rm(join(directory, "untracked.txt"));
  await execFileAsync("/usr/bin/git", [
    "-C", directory, "remote", "set-url", "origin",
    "https://user:password@github.com/example/project.git",
  ]);
  await assert.rejects(
    inspectActivationRepository(directory),
    /without embedded credentials/u,
  );
});

test("activation execution binds Issue, clean repository, command, remote, and full approval", async () => {
  const result = await candidate();
  assert.equal(result.assessment.decision, "REQUIRE_APPROVAL");
  assert.match(result.assessment.plan.objective, /issues\/42/u);
  assert.equal(result.manifest.capabilities.local_test.mode, "approval_required");
  assert.equal(result.manifest.capabilities.git_push.expectedRemoteUrl, snapshot.remoteUrl);
  assert.equal(result.manifest.capabilities.github_pr_draft.repository, "example/project");
  assert.equal(result.manifest.capabilities.github_pr_draft.headRepository, "example/project");
  assert.equal(result.deliveryMode, "same_repository");
  assert.deepEqual(result.manifest.capabilities.github_pr_draft.baseBranches, ["main"]);
  await assert.rejects(
    () => prepareActivationExecution(input, {
      previewBuilder,
      repositoryInspector: async () => ({ ...snapshot, repository: "other/project" }),
      commandBuilder: async () => ({ executable: "/usr/bin/true", args: [] }),
    }),
    /must match origin or the configured upstream/u,
  );
});

test("activation execution binds a fork origin to the exact upstream Issue repository", async () => {
  const forkSnapshot = {
    ...snapshot,
    remoteUrl: "https://github.com/tester/foursday.git",
    repository: "tester/foursday",
    upstreamRemoteUrl: "https://github.com/example/project.git",
    upstreamRepository: "example/project",
  };
  const result = await prepareActivationExecution(input, {
    previewBuilder,
    repositoryInspector: async () => forkSnapshot,
    commandBuilder: async () => ({ executable: "/usr/bin/true", args: [] }),
  });
  assert.equal(result.deliveryMode, "fork_to_upstream");
  assert.equal(result.manifest.capabilities.git_push.expectedRemoteUrl, forkSnapshot.remoteUrl);
  assert.equal(result.manifest.capabilities.github_pr_draft.repository, "example/project");
  assert.equal(result.manifest.capabilities.github_pr_draft.headRepository, "tester/foursday");
  await assert.rejects(
    () => prepareActivationExecution(input, {
      previewBuilder,
      repositoryInspector: async () => ({
        ...forkSnapshot,
        upstreamRepository: "other/upstream",
      }),
      commandBuilder: async () => ({ executable: "/usr/bin/true", args: [] }),
    }),
    /configured upstream/u,
  );
});

test("activation coordinator executes only the approved hash then proposes confirmable outcomes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-activation-execution-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prepared = await candidate();
  const evidence = {
    code_patch: { kind: "unified_diff", verification: "git_apply_check", sha256: "1".repeat(64) },
    local_branch: { kind: "isolated_git_worktree", verification: "isolated_commit_matches_verified_patch", commit: "b".repeat(40) },
    local_test: { kind: "controlled_command", verification: "exit_code_zero", sha256: "2".repeat(64) },
    git_push: { kind: "verified_git_push", verification: "ls_remote_commit_matches", commit: "b".repeat(40) },
    github_pr_draft: {
      kind: "verified_github_pr_draft",
      verification: "gh_pr_view_matches_push_and_intent",
      commit: "b".repeat(40),
      number: 42,
      url: "https://github.com/example/project/pull/42",
      head: "foursday/change-42",
      headRepository: "example/project",
      base: "main",
      state: "OPEN",
      isDraft: true,
    },
  };
  const monotonicTimes = [0, 60_000, 120_000, 420_000, 540_000];
  const coordinator = new ActivationExecutionCoordinator({
    sessionRoot: join(directory, "sessions"),
    prepare: async () => prepared,
    repositoryInspector: async () => snapshot,
    artifactRuntimeFactory: async () => ({ id: "fake" }),
    ghPath: "/usr/bin/true",
    monotonicNow: () => monotonicTimes.shift(),
    adapterFactory: () => Object.fromEntries(
      Object.entries(evidence).map(([capability, value]) => [capability, {
        async execute() { return { verified: true, evidence: value }; },
      }]),
    ),
  });
  t.after(() => coordinator.close());
  const created = await coordinator.create(input);
  assert.equal(created.plan.status, "awaiting_approval");
  assert.equal(created.externalSystemsTouched, false);
  assert.deepEqual(created.repositoryBinding, {
    mode: "same_repository",
    issueRepository: "example/project",
    sourceRepository: "example/project",
    upstreamRepository: undefined,
    startingCommit: snapshot.head,
  });
  await assert.rejects(
    () => coordinator.approveAndExecute(created.sessionId, {
      planHash: "0".repeat(64),
      approved: true,
      reason: "reviewed",
      humanActiveMinutes: 10,
    }),
    /review the current plan again/u,
  );
  const completed = await coordinator.approveAndExecute(created.sessionId, {
    planHash: created.plan.planHash,
    approved: true,
    reason: "I reviewed the immutable five-step plan and repository scope.",
    humanActiveMinutes: 10,
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.evidence.map((item) => item.kind), Object.values(evidence).map((item) => item.kind));
  assert.equal(completed.memoryCandidate.status, "proposed");
  assert.equal(completed.timeReturn.status, "proposed");
  assert.equal(completed.timeReturn.returnedMinutes, 110);
  const proposedEvidence = await coordinator.exportEvidence(created.sessionId);
  assert.equal(proposedEvidence.validationStatus, "awaiting_outcome_confirmation");
  assert.equal(proposedEvidence.plan.planHash, created.plan.planHash);
  assert.equal(proposedEvidence.evidence.length, 5);
  assert.equal(proposedEvidence.evidence[4].head, "foursday/change-42");
  assert.equal(proposedEvidence.evidence[4].headRepository, "example/project");
  assert.equal(proposedEvidence.project.sourceRepository, "example/project");
  assert.equal(proposedEvidence.evidence[4].base, "main");
  assert.equal(proposedEvidence.evidence[4].state, "OPEN");
  assert.equal(proposedEvidence.evidence[4].isDraft, true);
  assert.equal(proposedEvidence.safeguards.mergePerformed, false);
  assert.equal(proposedEvidence.safeguards.deploymentPerformed, false);
  assert.match(proposedEvidence.integrity.digest, /^[a-f0-9]{64}$/u);
  assert.equal(proposedEvidence.integrity.signed, false);
  assert.equal(proposedEvidence.timing, undefined);
  await assert.rejects(
    () => coordinator.exportPublicProof(created.sessionId),
    /not a confirmed closed loop/u,
  );
  const serialized = JSON.stringify(proposedEvidence);
  assert.doesNotMatch(serialized, /\/workspace\/example/u);
  assert.doesNotMatch(serialized, /remoteUrl|rootDirectory|actionToken/u);
  const confirmed = await coordinator.confirmOutcomes(created.sessionId, {
    memoryId: completed.memoryCandidate.id,
    timeReturnId: completed.timeReturn.id,
  });
  assert.equal(confirmed.memory.status, "confirmed");
  assert.equal(confirmed.timeReturn.status, "confirmed");
  assert.deepEqual(confirmed.localJourney, {
    scope: "server_start_to_confirmed_loop",
    serverStartToConfirmedSeconds: 540,
    serverJourneyWithinTenMinutes: true,
    installToPreviewMeasured: false,
  });
  const confirmedEvidence = await coordinator.exportEvidence(created.sessionId);
  assert.equal(confirmedEvidence.validationStatus, "verified_closed_loop");
  assert.equal(confirmedEvidence.outcomes.memory.status, "confirmed");
  assert.equal(confirmedEvidence.outcomes.timeReturn.status, "confirmed");
  assert.deepEqual(confirmedEvidence.timing, {
    schema: "foursday-local-journey-timing/v1",
    scope: "server_start_to_confirmed_loop",
    installToPreviewMeasured: false,
    serverStartToPlanMs: 60_000,
    planReviewMs: 60_000,
    approvedExecutionMs: 300_000,
    outcomeReviewMs: 120_000,
    serverStartToConfirmedMs: 540_000,
  });
  const publicProof = await coordinator.exportPublicProof(created.sessionId);
  assert.equal(publicProof.proof.schema, "foursday-public-pilot-proof/v1");
  assert.equal(publicProof.proof.draftPrUrl, "https://github.com/example/project/pull/42");
  assert.deepEqual(publicProof.proof.localJourney, confirmed.localJourney);
  assert.match(publicProof.markdown, /Alias: tester-XX/u);
  assert.match(publicProof.markdown, /Measured server-start-to-confirmed seconds: 540/u);
  assert.match(publicProof.markdown, /Package download included in measured journey: no/u);
  assert.doesNotMatch(publicProof.markdown, /memory_|time_/u);
  await assert.rejects(
    () => coordinator.confirmOutcomes(created.sessionId, { memoryId: "memory_other" }),
    /does not belong/u,
  );
});
