import assert from "node:assert/strict";
import test from "node:test";
import { buildActivationPreview, parseGitHubIssueUrl } from "../src/activation.mjs";

test("GitHub issue URL is canonical and credential-free", () => {
  assert.deepEqual(parseGitHubIssueUrl("https://github.com/example/project/issues/42?tab=activity"), {
    owner: "example", repository: "project", number: 42,
    repositorySlug: "example/project",
    canonicalUrl: "https://github.com/example/project/issues/42",
  });
  for (const value of [
    "http://github.com/example/project/issues/42",
    "https://token@github.com/example/project/issues/42",
    "https://example.com/example/project/issues/42",
    "https://github.com/example/project/pull/42",
  ]) assert.throws(() => parseGitHubIssueUrl(value), /issueUrl/u);
});

test("activation preview reuses the real recipe and keeps every external effect locked", async () => {
  const preview = await buildActivationPreview({
    projectId: "example-project",
    projectName: "Example project",
    rootDirectory: "/workspace/example",
    requesterId: "owner-1",
    runtime: "codex",
    issueUrl: "https://github.com/example/project/issues/42",
    changeRequest: "Fix the documented startup error without changing public APIs.",
    testCommandId: "check",
    baseBranch: "main",
    prTitle: "fix: keep startup compatible",
  }, {
    onboardingBuilder: async (input) => {
      const { buildProjectOnboardingDraft } = await import("../src/project-onboarding.mjs");
      return buildProjectOnboardingDraft({
        ...input,
        realpathFn: async (value) => value,
        gitRootFn: async (value) => value,
      });
    },
  });
  assert.equal(preview.schema, "foursday-activation/v1");
  assert.equal(preview.runtime, "codex");
  assert.deepEqual(preview.plan.steps.map((step) => step.capability), [
    "code_patch", "local_branch", "local_test", "git_push", "github_pr_draft",
  ]);
  assert.match(preview.planHash, /^[a-f0-9]{64}$/u);
  assert.match(preview.plan.objective, /https:\/\/github\.com\/example\/project\/issues\/42/u);
  assert.equal(preview.decision, "DENY");
  assert.equal(preview.externalSystemsTouched, false);
  assert.equal(preview.formalMemoryWritten, false);
  assert.equal(preview.timeReturnRecorded, false);
  assert.equal(
    preview.capabilities
      .filter((item) => item.sideEffect)
      .every((item) => item.configuredMode !== "automatic"),
    true,
  );
  assert.deepEqual(
    Object.fromEntries(preview.capabilities.map((item) => [item.name, item.configuredMode])),
    {
      code_patch: "approval_required",
      local_branch: "approval_required",
      local_test: "disabled",
      git_push: "disabled",
      github_pr_draft: "disabled",
    },
  );
  assert.equal(preview.presentation.steps.length, 5);
  assert.equal(preview.presentation.steps.every((step) => !/[\u4e00-\u9fff]/u.test(step.title)), true);
  assert.deepEqual(preview.presentation.blockedCapabilities, [
    "local_test", "git_push", "github_pr_draft",
  ]);
});
