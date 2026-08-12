import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  processNextWorkPlan,
  reconcileGovernedWorkGraphs,
  runPlanExecutor,
} from "../src/plan-executor.mjs";
import { Store } from "../src/store.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-plan-runner-"));
  const projectsDirectory = join(directory, "projects");
  await mkdir(projectsDirectory);
  const store = await new Store(join(directory, "test.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, projectsDirectory, store };
}

function project(rootDirectory) {
  return {
    version: 1,
    projectId: "project_1",
    name: "测试项目",
    rootDirectory,
    requesters: ["user_1"],
    capabilities: { research: { mode: "automatic" } },
  };
}

function plan(manifest) {
  return assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "user_1",
      objective: "完成项目研究",
      steps: [{
        id: "research",
        capability: "research",
        description: "分析项目",
        expectedEvidence: "研究结果",
      }],
    },
  });
}

test("常驻执行器只在全局能力开启后领取已授权计划", async (t) => {
  const { directory, projectsDirectory, store } = await fixture(t);
  const manifest = project(directory);
  await writeFile(join(projectsDirectory, "project.json"), JSON.stringify(manifest));
  const registered = store.registerWorkPlan(plan(manifest));
  let executions = 0;
  const config = {
    capabilities: new Set(),
    projectsDirectory,
    planExecutionLeaseMs: 1_000,
    planExecutionLeaseRenewMs: 100,
  };
  const adapters = { research: { async execute() { executions += 1; return { verified: true, evidence: { kind: "research" } }; } } };
  assert.equal(await processNextWorkPlan({ store, config, adapters, executionOwner: "executor_1" }), false);
  assert.equal(store.getWorkPlan(registered.id).status, "ready");
  config.capabilities.add("work_plan_execution");
  assert.equal(await processNextWorkPlan({ store, config, adapters, executionOwner: "executor_1" }), true);
  assert.equal(executions, 1);
  assert.equal(store.getWorkPlan(registered.id).status, "completed");
});

test("项目清单缺失时不消费计划授权", async (t) => {
  const { directory, projectsDirectory, store } = await fixture(t);
  const manifest = project(directory);
  const registered = store.registerWorkPlan(plan(manifest));
  const config = {
    capabilities: new Set(["work_plan_execution"]),
    projectsDirectory,
    planExecutionLeaseMs: 1_000,
    planExecutionLeaseRenewMs: 100,
  };
  assert.equal(await processNextWorkPlan({ store, config, adapters: {}, executionOwner: "executor_1" }), false);
  assert.equal(store.getWorkPlan(registered.id).status, "ready");
});

test("项目暂停时执行器不消费计划，恢复后继续", async (t) => {
  const { directory, projectsDirectory, store } = await fixture(t);
  const manifest = project(directory);
  await writeFile(join(projectsDirectory, "project.json"), JSON.stringify(manifest));
  const registered = store.registerWorkPlan(plan(manifest));
  store.setScopedPause({
    type: "project",
    value: manifest.projectId,
    paused: true,
    actor: "operator",
  });
  let executions = 0;
  const config = {
    capabilities: new Set(["work_plan_execution"]),
    projectsDirectory,
    planExecutionLeaseMs: 1_000,
    planExecutionLeaseRenewMs: 100,
  };
  const adapters = {
    research: {
      async execute() {
        executions += 1;
        return { verified: true, evidence: { kind: "research" } };
      },
    },
  };
  assert.equal(
    await processNextWorkPlan({ store, config, adapters, executionOwner: "executor_1" }),
    false,
  );
  assert.equal(store.getWorkPlan(registered.id).status, "ready");
  store.setScopedPause({
    type: "project",
    value: manifest.projectId,
    paused: false,
    actor: "operator",
  });
  assert.equal(
    await processNextWorkPlan({ store, config, adapters, executionOwner: "executor_1" }),
    true,
  );
  assert.equal(executions, 1);
});

test("常驻执行器停止时立即唤醒并安全关闭存储", async () => {
  let closed = false;
  const store = {
    async open() { return this; },
    async recordHeartbeat() {},
    async recoverExpiredWorkPlans() { return 0; },
    async isPaused() { return false; },
    async listWorkPlans() { return []; },
    async close() { closed = true; },
  };
  const executor = await runPlanExecutor({
    store,
    adapters: {},
    config: {
      capabilities: new Set(),
      planExecutorPollMs: 60_000,
      heartbeatMs: 30_000,
    },
  });
  const startedAt = Date.now();
  await executor.stop();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(closed, true);
});

test("终态图投影失败后可由领域事实确定性补齐且重放不重复", async (t) => {
  const { directory, projectsDirectory, store } = await fixture(t);
  const manifest = project(directory);
  await writeFile(join(projectsDirectory, "project.json"), JSON.stringify(manifest));
  const registered = store.registerWorkPlan(plan(manifest));
  const originalAppend = store.appendGraphProjection.bind(store);
  let appendCalls = 0;
  store.appendGraphProjection = (projection, observedAt) => {
    appendCalls += 1;
    if (appendCalls === 2) throw new Error("simulated_terminal_graph_failure");
    return originalAppend(projection, observedAt);
  };
  const config = {
    tenantId: "local",
    capabilities: new Set(["work_plan_execution"]),
    projectsDirectory,
    recipesDirectory: join(directory, "recipes"),
    planExecutionLeaseMs: 1_000,
    planExecutionLeaseRenewMs: 100,
  };
  await mkdir(config.recipesDirectory);
  const adapters = {
    research: {
      async execute() {
        return { verified: true, evidence: { kind: "research" } };
      },
    },
  };

  assert.equal(await processNextWorkPlan({
    store,
    config,
    adapters,
    executionOwner: "executor_1",
  }), true);
  assert.equal(store.getWorkPlan(registered.id).status, "completed");
  assert.equal(
    store.listGraphEdges({
      tenantId: "local",
      projectId: manifest.projectId,
      edgeType: "plan.produces_outcome",
    }).length,
    0,
  );

  store.appendGraphProjection = originalAppend;
  assert.deepEqual(
    await reconcileGovernedWorkGraphs({ store, config }),
    { changed: 1, failed: 0 },
  );
  assert.equal(
    store.listGraphEdges({
      tenantId: "local",
      projectId: manifest.projectId,
      edgeType: "plan.produces_outcome",
    }).length,
    1,
  );
  assert.deepEqual(
    await reconcileGovernedWorkGraphs({ store, config }),
    { changed: 0, failed: 0 },
  );
});
