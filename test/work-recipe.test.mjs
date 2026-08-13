import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { instantiateWorkRecipe, validateWorkRecipe } from "../src/work-recipe.mjs";
import { loadWorkRecipes } from "../src/recipe-library.mjs";
import { assessWorkPlan, validateWorkPlan } from "../src/work-plan.mjs";

test("四个官方工作配方均可加载并实例化", async () => {
  const directory = new URL("../deploy/recipes/", import.meta.url);
  const recipes = await loadWorkRecipes(directory);
  assert.deepEqual([...recipes.keys()].sort(), [
    "code-delivery",
    "daily-report",
    "meeting-follow-up",
    "project-follow-up",
  ]);
  const result = instantiateWorkRecipe(recipes.get("project-follow-up"), {
    projectId: "project_1",
    requesterId: "owner_1",
    projectRoot: "/workspace/project",
    values: { projectFocus: "完成首个真实配方" },
  });
  assert.equal(result.plan.projectId, "project_1");
  assert.match(result.plan.objective, /完成首个真实配方/u);
  assert.equal(result.plan.steps.every((step) => step.workingDirectory === "/workspace/project"), true);
  assert.equal(result.timeReturnProposal.status, "proposed");
  const meeting = instantiateWorkRecipe(recipes.get("meeting-follow-up"), {
    projectId: "project_1", requesterId: "owner_1", projectRoot: "/workspace/project",
    values: {
      meetingTitle: "项目复盘", meetingNotes: "决定先完成安全检查。",
      executorUserIds: ["user-1"], attendeeUserIds: ["user-1", "user-2"],
      decisionStatement: "发布前必须完成安全检查。", decisionFactKey: "decision.release_gate",
      memoryRetentionDays: 90, actionDue: "2026-08-13T10:00:00.000Z",
      followupStart: "2026-08-14T02:00:00.000Z", followupEnd: "2026-08-14T03:00:00.000Z",
    },
  });
  assert.deepEqual(meeting.plan.steps.find((step) => step.id === "create-todo").inputs.executorUserIds, ["user-1"]);
  assert.equal(meeting.plan.steps.some((step) => step.capability === "project_memory_proposal"), true);
  const code = instantiateWorkRecipe(recipes.get("code-delivery"), {
    projectId: "project_1", requesterId: "owner_1", projectRoot: "/workspace/project",
    values: {
      issueUrl: "https://github.com/example/project/issues/42",
      changeRequest: "修复登录",
      testCommandId: "检查",
      baseBranch: "main",
      prTitle: "修复登录",
    },
  });
  assert.deepEqual(code.plan.steps.map((step) => step.capability), [
    "code_patch", "local_branch", "local_test", "git_push", "github_pr_draft",
  ]);
});

test("配方拒绝秘密输入、未知变量和缺失必填值", () => {
  const base = {
    version: 1,
    id: "test-recipe",
    name: "测试配方",
    description: "测试安全边界",
    category: "test",
    objective: "完成 {{title}}",
    baselineMinutes: 10,
    inputs: [{ name: "title", type: "string", description: "标题" }],
    steps: [{
      id: "draft",
      capability: "document_draft",
      description: "撰写 {{title}}",
      workingDirectory: "{{projectRoot}}",
      inputs: {},
      expectedEvidence: "内容哈希",
      rollback: null,
    }],
  };
  assert.throws(
    () => validateWorkRecipe({
      ...base,
      inputs: [{ name: "token", type: "string", secret: true, description: "密钥" }],
    }),
    /cannot persist secret inputs/u,
  );
  assert.throws(
    () => instantiateWorkRecipe(base, {
      projectId: "project_1",
      requesterId: "owner_1",
      projectRoot: "/workspace/project",
      values: {},
    }),
    /Missing recipe input/u,
  );
  assert.throws(
    () => instantiateWorkRecipe({ ...base, objective: "{{unknown}}" }, {
      projectId: "project_1",
      requesterId: "owner_1",
      projectRoot: "/workspace/project",
      values: { title: "标题" },
    }),
    /Unknown recipe variable/u,
  );
  assert.throws(
    () => validateWorkRecipe({
      ...base,
      steps: [{ ...base.steps[0], inputs: { score: Number.NaN } }],
    }),
    /non-finite number/u,
  );
});

test("配方 JSON 不包含密钥字段和值", async () => {
  const recipe = await readFile(new URL("../deploy/recipes/daily-report.json", import.meta.url), "utf8");
  assert.doesNotMatch(recipe, /token|password|secret|api.?key/iu);
});

test("旧计划不新增空配方字段，配方绑定进入计划哈希", async () => {
  const legacy = validateWorkPlan({
    version: 1,
    projectId: "project_1",
    requesterId: "owner_1",
    objective: "兼容旧计划",
    steps: [{
      id: "research",
      capability: "research",
      description: "研究",
      inputs: {},
      expectedEvidence: "结论",
    }],
  });
  assert.equal(Object.hasOwn(legacy, "recipe"), false);
  const manifest = {
    version: 1,
    projectId: "project_1",
    name: "项目",
    rootDirectory: "/workspace/project",
    requesters: ["owner_1"],
    capabilities: { research: { mode: "automatic" } },
  };
  const withoutRecipe = assessWorkPlan({ manifest, plan: legacy });
  const recipe = (await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url)))
    .get("project-follow-up");
  const withRecipe = assessWorkPlan({
    manifest,
    plan: instantiateWorkRecipe(recipe, {
      projectId: "project_1",
      requesterId: "owner_1",
      projectRoot: "/workspace/project",
      values: { projectFocus: "兼容旧计划" },
    }).plan,
  });
  assert.notEqual(withRecipe.planHash, withoutRecipe.planHash);
  assert.equal(withRecipe.plan.recipe.id, "project-follow-up");
});
