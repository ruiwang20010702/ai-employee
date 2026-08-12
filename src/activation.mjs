import { readFile } from "node:fs/promises";
import { capabilityCatalog } from "./capability-policy.mjs";
import { buildProjectOnboardingDraft } from "./project-onboarding.mjs";
import { assessWorkPlan } from "./work-plan.mjs";
import { instantiateWorkRecipe } from "./work-recipe.mjs";

const issuePath = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/u;

function boundedText(value, name, maximum = 4_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} characters`);
  }
  return normalized;
}

export function parseGitHubIssueUrl(value) {
  let url;
  try {
    url = new URL(boundedText(value, "issueUrl", 2_000));
  } catch {
    throw new Error("issueUrl must be a valid GitHub issue URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password
  ) {
    throw new Error("issueUrl must use https://github.com without credentials");
  }
  const match = url.pathname.match(issuePath);
  if (!match || match[1].endsWith(".") || match[2].endsWith(".")) {
    throw new Error("issueUrl must point to /owner/repository/issues/number");
  }
  const [, owner, repository, number] = match;
  return {
    owner,
    repository,
    number: Number(number),
    repositorySlug: `${owner}/${repository}`,
    canonicalUrl: `https://github.com/${owner}/${repository}/issues/${number}`,
  };
}

async function defaultRecipeLoader() {
  return JSON.parse(await readFile(
    new URL("../deploy/recipes/code-delivery.json", import.meta.url),
    "utf8",
  ));
}

function activationStepCopy(step, changeRequest) {
  const copy = {
    code_patch: {
      title: `Prepare the smallest project-scoped patch for: ${changeRequest}`,
      evidence: "A unified diff that passes git apply --check",
    },
    local_branch: {
      title: "Apply the verified patch in an isolated worktree and create a local commit",
      evidence: "The isolated commit and patch evidence resolve to the same change",
    },
    local_test: {
      title: "Run the test command registered by the project",
      evidence: "Exit code, bounded output, and output hash",
    },
    git_push: {
      title: "Push the verified isolated commit to an authorized project branch",
      evidence: "The remote branch resolves to the exact local commit",
    },
    github_pr_draft: {
      title: "Open a GitHub pull request as a draft",
      evidence: "PR number, URL, draft state, branches, and commit are read back field by field",
    },
  }[step.capability];
  return { id: step.id, capability: step.capability, ...copy };
}

export async function buildActivationPreview(input, {
  onboardingBuilder = buildProjectOnboardingDraft,
  recipeLoader = defaultRecipeLoader,
} = {}) {
  const issue = parseGitHubIssueUrl(input?.issueUrl);
  const rootDirectory = boundedText(input?.rootDirectory, "rootDirectory", 4_096);
  const requesterId = boundedText(input?.requesterId ?? "local-owner", "requesterId", 500);
  const changeRequest = boundedText(input?.changeRequest, "changeRequest", 10_000);
  const projectId = boundedText(input?.projectId, "projectId", 64);
  const projectName = boundedText(input?.projectName, "projectName", 200);
  const baseBranch = boundedText(input?.baseBranch ?? "main", "baseBranch", 200);
  const testCommandId = boundedText(input?.testCommandId ?? "check", "testCommandId", 200);
  const prTitle = boundedText(input?.prTitle ?? changeRequest.slice(0, 100), "prTitle", 120);
  const runtime = ["demo", "codex", "claude-code", "openai-compatible"].includes(input?.runtime)
    ? input.runtime
    : "demo";
  const onboarding = await onboardingBuilder({
    projectId,
    name: projectName,
    rootDirectory,
    requesterIds: [requesterId],
    profile: {
      objective: boundedText(
        input?.objective ?? `Resolve approved GitHub work for ${issue.repositorySlug}`,
        "objective",
        1_000,
      ),
      successCriteria: [
        "Every external effect requires the approved immutable plan",
        "Tests and the draft pull request are read back from the target",
      ],
      milestones: ["Complete the first verified GitHub delivery"],
      collaborationObjects: [issue.repositorySlug],
      selectedRecipeIds: ["code-delivery"],
      memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 90 },
    },
  });
  const recipe = await recipeLoader();
  const instantiated = instantiateWorkRecipe(recipe, {
    projectId,
    requesterId,
    projectRoot: onboarding.manifest.rootDirectory,
    values: {
      issueUrl: issue.canonicalUrl,
      changeRequest,
      testCommandId,
      baseBranch,
      prTitle,
    },
  });
  const assessment = assessWorkPlan({
    manifest: onboarding.manifest,
    plan: instantiated.plan,
  });
  const capabilities = instantiated.plan.steps.map((step) => ({
    name: step.capability,
    level: capabilityCatalog[step.capability]?.level ?? "unknown",
    sideEffect: capabilityCatalog[step.capability]?.sideEffect === true,
    configuredMode: onboarding.manifest.capabilities[step.capability]?.mode ?? "disabled",
  }));
  const blockedCapabilities = capabilities
    .filter((item) => item.configuredMode === "disabled")
    .map((item) => item.name);
  return {
    schema: "foursday-activation/v1",
    stage: "safe_preview",
    runtime,
    issue,
    project: {
      projectId: onboarding.manifest.projectId,
      name: onboarding.manifest.name,
      rootDirectory: onboarding.manifest.rootDirectory,
      requesterId,
    },
    checklist: onboarding.checklist,
    manifest: onboarding.manifest,
    plan: instantiated.plan,
    planHash: assessment.planHash,
    decision: assessment.decision,
    decisionReason: assessment.reason,
    capabilities,
    presentation: {
      steps: instantiated.plan.steps.map((step) => activationStepCopy(step, changeRequest)),
      blockedCapabilities,
    },
    externalSystemsTouched: false,
    formalMemoryWritten: false,
    timeReturnRecorded: false,
    nextAction: "Review and explicitly configure each disabled side-effect capability before execution.",
  };
}
