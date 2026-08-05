import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processNextWorkPlan } from "../src/plan-executor.mjs";
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
