import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilityBudgetForPlan } from "../src/capability-budget.mjs";
import { Store } from "../src/store.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-budget-"));
  const store = await new Store(join(directory, "state.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function manifest(maxRuns = 1) {
  return {
    version: 1,
    projectId: "budget_project",
    name: "预算项目",
    rootDirectory: "/workspace/budget",
    requesters: ["requester-1"],
    capabilities: {
      research: { mode: "automatic", maxRuns },
    },
  };
}

function assessment(objective, authorization = manifest()) {
  return assessWorkPlan({
    manifest: authorization,
    plan: {
      version: 1,
      projectId: "budget_project",
      requesterId: "requester-1",
      objective,
      steps: [{
        id: "research",
        capability: "research",
        description: objective,
        inputs: {},
        expectedEvidence: "研究结果",
      }],
    },
  });
}

test("能力次数预算跨计划持久扣减且授权变化后独立计数", async (t) => {
  const store = await fixture(t);
  const firstAssessment = assessment("第一次研究");
  const secondAssessment = assessment("第二次研究");
  assert.equal(firstAssessment.authorizationHash, secondAssessment.authorizationHash);
  const first = store.registerWorkPlan(firstAssessment);
  const second = store.registerWorkPlan(secondAssessment);
  assert.equal(store.consumeWorkPlanAuthorization(first.id, new Date(), {
    capabilityBudget: capabilityBudgetForPlan(firstAssessment, manifest()),
  }), true);
  assert.throws(
    () => store.consumeWorkPlanAuthorization(second.id, new Date(), {
      capabilityBudget: capabilityBudgetForPlan(secondAssessment, manifest()),
    }),
    /budget exhausted/u,
  );
  assert.deepEqual(store.listCapabilityBudgetUsage(), [{
    projectId: "budget_project",
    authorizationHash: firstAssessment.authorizationHash,
    capability: "research",
    limit: 1,
    used: 1,
    remaining: 0,
    updatedAt: store.listCapabilityBudgetUsage()[0].updatedAt,
  }]);

  const expandedManifest = manifest(2);
  const thirdAssessment = assessment("新授权后的研究", expandedManifest);
  assert.notEqual(thirdAssessment.authorizationHash, firstAssessment.authorizationHash);
  const third = store.registerWorkPlan(thirdAssessment);
  assert.equal(store.consumeWorkPlanAuthorization(third.id, new Date(), {
    capabilityBudget: capabilityBudgetForPlan(thirdAssessment, expandedManifest),
  }), true);
  assert.equal(store.listCapabilityBudgetUsage().length, 2);
});

test("调用方伪造授权哈希不能建立新的预算命名空间", async (t) => {
  const store = await fixture(t);
  const current = assessment("验证授权绑定");
  const plan = store.registerWorkPlan(current);
  const forged = {
    ...capabilityBudgetForPlan(current, manifest()),
    authorizationHash: "f".repeat(64),
  };

  assert.throws(
    () => store.consumeWorkPlanAuthorization(plan.id, new Date(), {
      capabilityBudget: forged,
    }),
    /does not match the registered work plan/u,
  );
  assert.equal(store.listCapabilityBudgetUsage().length, 0);
  assert.equal(store.consumeWorkPlanAuthorization(plan.id, new Date(), {
    capabilityBudget: capabilityBudgetForPlan(current, manifest()),
  }), true);
  assert.equal(store.listCapabilityBudgetUsage().length, 1);
});
