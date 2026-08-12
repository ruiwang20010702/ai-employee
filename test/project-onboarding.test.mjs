import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectOnboardingDraft } from "../src/project-onboarding.mjs";

test("项目接入草案默认只开放低风险草稿能力", async () => {
  const result = await buildProjectOnboardingDraft({
    projectId: "personal_project",
    name: "个人项目",
    rootDirectory: "/workspace/project",
    requesterIds: ["owner-1"],
    profile: {
      objective: "减少重复工作",
      successCriteria: ["结果可回读"],
      selectedRecipeIds: ["project-follow-up"],
      memoryScope: { allowedTypes: ["project", "principle"], retentionDays: 90 },
    },
    realpathFn: async (value) => value,
    gitRootFn: async (value) => value,
  });
  assert.equal(result.externalSideEffectsEnabled, false);
  assert.equal(result.manifest.capabilities.research.mode, "automatic");
  assert.equal(result.manifest.capabilities.code_patch.mode, "approval_required");
  assert.equal(result.manifest.capabilities.local_branch.mode, "approval_required");
  assert.equal(result.manifest.capabilities.git_push.mode, "disabled");
  assert.equal(result.manifest.capabilities.production_deploy.mode, "disabled");
  assert.equal(result.manifest.profile.objective, "减少重复工作");
  assert.deepEqual(result.manifest.profile.selectedRecipeIds, ["project-follow-up"]);
  assert.equal(result.checklist.at(-1).status, "blocked");
});

test("项目接入拒绝越界记忆范围和非绝对目录", async () => {
  await assert.rejects(
    () => buildProjectOnboardingDraft({
      projectId: "project_1",
      name: "项目",
      rootDirectory: "relative",
      requesterIds: ["owner"],
      profile: { objective: "目标" },
    }),
    /rootDirectory must be absolute/u,
  );
  await assert.rejects(
    () => buildProjectOnboardingDraft({
      projectId: "project_1",
      name: "项目",
      rootDirectory: "/workspace/project",
      requesterIds: ["owner"],
      profile: {
        objective: "目标",
        memoryScope: { allowedTypes: ["secret"], retentionDays: 90 },
      },
      realpathFn: async (value) => value,
      gitRootFn: async (value) => value,
    }),
    /unsupported type/u,
  );
  await assert.rejects(
    () => buildProjectOnboardingDraft({
      projectId: "project_1",
      name: "项目",
      rootDirectory: "/workspace/project/subdirectory",
      requesterIds: ["owner"],
      profile: { objective: "目标" },
      realpathFn: async (value) => value,
      gitRootFn: async () => "/workspace/project",
    }),
    /Git repository root/u,
  );
});
