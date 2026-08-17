import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControlledWorkAdapters } from "../src/work-adapters.mjs";
import { executeWorkPlan } from "../src/work-executor.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";
import { instantiateWorkRecipe } from "../src/work-recipe.mjs";
import { loadWorkRecipes } from "../src/recipe-library.mjs";
import { buildProjectDashboard } from "../src/project-dashboard.mjs";
import { Store } from "../src/store.mjs";
import { buildWeeklyDelegationQueue } from "../src/weekly-delegation-queue.mjs";

test("Foursday 影子闭环把主动项目记忆和本人确认的时间返还汇入驾驶舱", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foursday-self-shadow-"));
  const store = await new Store(join(directory, "shadow.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const manifest = {
    version: 1,
    projectId: "foursday_self_shadow",
    name: "Foursday 自身影子项目",
    rootDirectory: "/workspace/foursday",
    requesters: ["owner"],
    profile: {
      objective: "用 Foursday 验证 Foursday",
      successCriteria: ["项目事实和返还时间均可追溯"],
      milestones: ["完成一次项目记忆影子闭环"],
      collaborationObjects: [],
      selectedRecipeIds: ["project-memory-update"],
      memoryScope: { allowedTypes: ["project"], retentionDays: 90 },
    },
    capabilities: {
      research: { mode: "automatic" },
      document_draft: { mode: "automatic" },
      project_memory_proposal: {
        mode: "approval_required",
        allowedFactKeyPrefixes: ["milestone."],
        maxRetentionDays: 90,
        maxRuns: 1,
      },
    },
  };
  const recipes = await loadWorkRecipes(new URL("../deploy/recipes/", import.meta.url));
  const recipe = recipes.get("project-memory-update");
  const now = new Date("2026-08-13T06:00:00.000Z");
  const unverifiedQueue = buildWeeklyDelegationQueue({
    manifests: [manifest],
    recipes: [...recipes.values()],
    plans: [],
    timeReturns: [],
    now,
  });
  assert.equal(unverifiedQueue.items[0].recipeId, "project-memory-update");
  assert.equal(unverifiedQueue.items[0].evidenceStatus, "needs_validation");
  assert.equal(unverifiedQueue.projectedVerifiedReturnedMinutes, 0);
  const instantiated = instantiateWorkRecipe(recipe, {
    projectId: manifest.projectId,
    requesterId: "owner",
    projectRoot: manifest.rootDirectory,
    values: {
      projectFocus: "项目记忆与时间返还闭环",
      memoryStatement: "Foursday 已完成一次证据绑定的项目记忆影子闭环。",
      memoryFactKey: "milestone.memory_shadow_loop",
      memoryRetentionDays: 90,
    },
  });
  const assessment = assessWorkPlan({ manifest, plan: instantiated.plan });
  assert.equal(assessment.decision, "REQUIRE_APPROVAL");
  const plan = store.registerWorkPlan(assessment);
  store.decideWorkPlan(plan.id, {
    decision: "approved",
    actor: "owner",
    reason: "仅执行隔离 SQLite 影子闭环",
    planHash: assessment.planHash,
  });
  const document = "# 影子证据\n\nFoursday 已完成一次证据绑定的项目记忆影子闭环。";
  const memoryAdapter = createControlledWorkAdapters({
    codexPath: "/bin/false",
    store,
  }).project_memory_proposal;
  const execution = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest,
    adapters: {
      research: {
        async execute() {
          return {
            verified: true,
            evidence: {
              kind: "research_markdown",
              sha256: createHash("sha256").update("影子研究证据").digest("hex"),
              verification: "isolated_shadow_fixture",
            },
          };
        },
      },
      document_draft: {
        async execute() {
          return {
            verified: true,
            evidence: {
              kind: "document_markdown",
              content: document,
              bytes: Buffer.byteLength(document),
              sha256: createHash("sha256").update(document).digest("hex"),
              verification: "isolated_shadow_fixture",
            },
          };
        },
      },
      project_memory_proposal: memoryAdapter,
    },
  });
  assert.equal(execution.status, "completed");
  const candidate = store.listMemories({ projectId: manifest.projectId, limit: 10 })[0];
  assert.equal(candidate.status, "proposed");
  assert.equal(candidate.scope.evidenceStepId, "draft-memory-review");
  store.confirmMemory(candidate.id, "owner");
  const timeReturn = store.proposeTimeReturn(plan.id, 10, "owner", now);
  assert.equal(timeReturn.returnedMinutes, 25);
  store.decideTimeReturn(timeReturn.id, "confirmed", "owner", now);
  const dashboard = buildProjectDashboard({
    manifest,
    plans: store.listWorkPlans({ limit: 10 }),
    memories: store.listMemories({ projectId: manifest.projectId, limit: 10 }),
    timeReturns: store.listTimeReturns({ projectId: manifest.projectId }),
    recipes: [...recipes.values()],
    planSteps: new Map([[plan.id, store.listWorkPlanSteps(plan.id)]]),
    now,
  });
  assert.equal(dashboard.memory.confirmed, 1);
  assert.equal(dashboard.plans.completed, 1);
  assert.equal(dashboard.timeReturn.returnedMinutes, 25);
  assert.equal(dashboard.timeReturn.automationCoverage, 0.7143);
  assert.equal(dashboard.timeReturn.weeklyReturnedMinutes, 25);
  assert.equal(dashboard.timeReturn.weeklyAutomationCoverage, 0.7143);
  assert.equal(dashboard.timeReturn.evidenceBoundary, "confirmed_verified_outcomes_only");
  const verifiedQueue = buildWeeklyDelegationQueue({
    manifests: [manifest],
    recipes: [...recipes.values()],
    plans: store.listWorkPlans({ limit: 10 }),
    timeReturns: store.listTimeReturns({ projectId: manifest.projectId }),
    now,
  });
  assert.equal(verifiedQueue.weeklyReturnedMinutes, 25);
  assert.equal(verifiedQueue.remainingMinutes, 455);
  assert.equal(verifiedQueue.items[0].recipeId, "project-memory-update");
  assert.equal(verifiedQueue.items[0].evidenceStatus, "verified_history");
  assert.equal(verifiedQueue.items[0].conservativeReturnedMinutes, 25);
  assert.equal(verifiedQueue.projectedVerifiedReturnedMinutes, 25);
});
