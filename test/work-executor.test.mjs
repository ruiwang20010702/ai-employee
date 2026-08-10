import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
import { executeWorkPlan } from "../src/work-executor.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-executor-test-"));
  const store = await new Store(join(directory, "test.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

const manifest = {
  version: 1,
  projectId: "test_project",
  name: "测试项目",
  rootDirectory: "/workspace/project",
  requesters: ["user-1"],
  capabilities: {
    research: { mode: "automatic" },
    document_draft: { mode: "automatic" },
  },
};

function assessment() {
  return assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: "test_project",
      requesterId: "user-1",
      objective: "研究并形成文档",
      steps: [
        {
          id: "research",
          capability: "research",
          description: "完成研究",
          expectedEvidence: "研究结论",
        },
        {
          id: "document",
          capability: "document_draft",
          description: "形成文档",
          expectedEvidence: "文档内容",
        },
      ],
    },
  });
}

test("执行前重新校验策略并逐步保存验证证据", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  const result = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest,
    adapters: {
      research: {
        async execute() {
          return { verified: true, evidence: { summary: "研究完成" } };
        },
      },
      document_draft: {
        async execute() {
          return { verified: true, evidence: { document: "文档草稿" } };
        },
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(store.getWorkPlan(plan.id).status, "completed");
  assert.deepEqual(
    store.listWorkPlanSteps(plan.id).map((step) => step.status),
    ["completed", "completed"],
  );
});

test("外部副作用调用前先持久化不可复用的执行意图", async (t) => {
  const store = await fixture(t);
  const sideEffectManifest = {
    version: 1,
    projectId: "side-effect-project",
    name: "副作用测试",
    rootDirectory: "/workspace/project",
    requesters: ["user-1"],
    capabilities: {
      dingtalk_todo_create: {
        mode: "approval_required",
        allowedExecutorUserIds: ["executor-1"],
        allowedPriorities: ["20"],
        maxTitleChars: 120,
      },
    },
  };
  const assessed = assessWorkPlan({
    manifest: sideEffectManifest,
    plan: {
      version: 1,
      projectId: sideEffectManifest.projectId,
      requesterId: "user-1",
      objective: "创建已批准待办",
      steps: [{
        id: "todo",
        capability: "dingtalk_todo_create",
        description: "创建待办",
        expectedEvidence: "逐字段回读一致",
        rollback: "另行审批删除",
        inputs: {
          title: "完成评审",
          executorUserIds: ["executor-1"],
          priority: "20",
        },
      }],
    },
  });
  const plan = store.registerWorkPlan(assessed);
  store.decideWorkPlan(plan.id, {
    decision: "approved",
    actor: "approver",
    planHash: assessed.planHash,
  });
  let persistedIntent;
  const result = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest: sideEffectManifest,
    adapters: {
      dingtalk_todo_create: {
        async execute() {
          persistedIntent = store.listWorkPlanSteps(plan.id)[0].evidence;
          return { verified: true, evidence: { kind: "verified_todo" } };
        },
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(persistedIntent.kind, "side_effect_intent");
  assert.equal(persistedIntent.capability, "dingtalk_todo_create");
  assert.match(persistedIntent.intentSha256, /^[a-f0-9]{64}$/u);
  assert.equal(persistedIntent.reconciliationRequiredIfInterrupted, true);
});

test("适配器失败时停止后续步骤并记录稳定错误分类", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  let documentRan = false;
  const result = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest,
    adapters: {
      research: {
        async execute() {
          const error = new Error("gateway unavailable with secret details");
          error.executionEvidence = {
            kind: "controlled_command",
            exitCode: 1,
            outputStored: false,
          };
          throw error;
        },
      },
      document_draft: {
        async execute() {
          documentRan = true;
        },
      },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "network_unavailable");
  assert.equal(documentRan, false);
  assert.equal(store.getWorkPlan(plan.id).status, "failed");
  assert.equal(store.listWorkPlanSteps(plan.id)[0].evidence.exitCode, 1);
});

test("副作用完成后取消状态查询失败仍保留回读证据", async (t) => {
  const store = await fixture(t);
  const sideEffectManifest = {
    version: 1,
    projectId: "poll-evidence-project",
    name: "取消查询证据测试",
    rootDirectory: "/workspace/project",
    requesters: ["user-1"],
    capabilities: {
      dingtalk_todo_create: {
        mode: "approval_required",
        allowedExecutorUserIds: ["executor-1"],
        allowedPriorities: ["20"],
        maxTitleChars: 120,
      },
    },
  };
  const assessed = assessWorkPlan({
    manifest: sideEffectManifest,
    plan: {
      version: 1,
      projectId: sideEffectManifest.projectId,
      requesterId: "user-1",
      objective: "创建待办并验证取消查询故障",
      steps: [{
        id: "todo",
        capability: "dingtalk_todo_create",
        description: "创建待办",
        expectedEvidence: "逐字段回读一致",
        rollback: "另行审批删除",
        inputs: {
          title: "完成评审",
          executorUserIds: ["executor-1"],
          priority: "20",
        },
      }],
    },
  });
  const plan = store.registerWorkPlan(assessed);
  store.decideWorkPlan(plan.id, {
    decision: "approved",
    actor: "approver",
    planHash: assessed.planHash,
  });
  const originalCancellationCheck = store.isWorkPlanCancellationRequested.bind(store);
  let sideEffectCompleted = false;
  store.isWorkPlanCancellationRequested = async (...args) => {
    if (sideEffectCompleted) throw new Error("cancellation status unavailable");
    return originalCancellationCheck(...args);
  };
  const evidence = {
    kind: "verified_todo",
    externalId: "todo-verified-1",
    readbackMatched: true,
  };
  const result = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest: sideEffectManifest,
    adapters: {
      dingtalk_todo_create: {
        async execute() {
          sideEffectCompleted = true;
          return { verified: true, evidence };
        },
      },
    },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(store.listWorkPlanSteps(plan.id)[0].evidence, evidence);
});

test("适配器预检失败时不消费审批或执行任何步骤", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  let executed = false;
  await assert.rejects(
    executeWorkPlan({
      store,
      planId: plan.id,
      manifest,
      adapters: {
        research: {
          async preflight() { throw new Error("command is not registered"); },
          async execute() { executed = true; },
        },
        document_draft: { async execute() { executed = true; } },
      },
    }),
    /not registered/u,
  );
  assert.equal(executed, false);
  assert.equal(store.getWorkPlan(plan.id).status, "ready");
});

test("缺少执行适配器时不消费授权", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  await assert.rejects(
    executeWorkPlan({
      store,
      planId: plan.id,
      manifest,
      adapters: { research: { async execute() {} } },
    }),
    /No execution adapter/u,
  );
  assert.equal(store.getWorkPlan(plan.id).status, "ready");
});

test("全局暂停时不消费计划授权", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  store.setPaused(true);
  await assert.rejects(
    executeWorkPlan({
      store,
      planId: plan.id,
      manifest,
      adapters: {
        research: { async execute() {} },
        document_draft: { async execute() {} },
      },
    }),
    /System is paused/u,
  );
  assert.equal(store.getWorkPlan(plan.id).status, "ready");
});

test("能力暂停时不消费计划授权", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  store.setScopedPause({
    type: "capability",
    value: "research",
    paused: true,
    actor: "operator",
  });
  await assert.rejects(
    executeWorkPlan({
      store,
      planId: plan.id,
      manifest,
      adapters: {
        research: { async execute() {} },
        document_draft: { async execute() {} },
      },
    }),
    /scope is paused/u,
  );
  assert.equal(store.getWorkPlan(plan.id).status, "ready");
});

test("项目策略收紧后旧的自动授权不能继续执行", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  const stricter = structuredClone(manifest);
  stricter.capabilities.research.mode = "approval_required";
  await assert.rejects(
    executeWorkPlan({
      store,
      planId: plan.id,
      manifest: stricter,
      adapters: {
        research: { async execute() {} },
        document_draft: { async execute() {} },
      },
    }),
    /authorization changed/u,
  );
  assert.equal(store.getWorkPlan(plan.id).status, "ready");
});

test("执行过程中项目授权变化会阻止后续副作用", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  let manifestReads = 0;
  let secondStepRan = false;
  const result = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest,
    manifestProvider: async () => {
      manifestReads += 1;
      if (manifestReads === 1) return manifest;
      const revoked = structuredClone(manifest);
      revoked.capabilities.document_draft.mode = "disabled";
      return revoked;
    },
    adapters: {
      research: { async execute() { return { verified: true, evidence: { done: true } }; } },
      document_draft: { async execute() { secondStepRan = true; } },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "document");
  assert.equal(secondStepRan, false);
});

test("运行中取消会保留当前步骤证据并阻止后续步骤", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  let secondStepRan = false;
  const result = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest,
    adapters: {
      research: {
        async execute() {
          store.requestWorkPlanCancellation(plan.id, "operator");
          return { verified: true, evidence: { completedBeforeCancellation: true } };
        },
      },
      document_draft: { async execute() { secondStepRan = true; } },
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelledBeforeStep, "document");
  assert.equal(secondStepRan, false);
  assert.equal(store.getWorkPlan(plan.id).status, "cancelled");
  assert.deepEqual(
    store.listWorkPlanSteps(plan.id).map((step) => step.status),
    ["completed", "cancelled"],
  );
});

test("可中断步骤收到取消请求后确认终止当前执行", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  let secondStepRan = false;
  let started;
  const stepStarted = new Promise((resolve) => { started = resolve; });
  const execution = executeWorkPlan({
    store,
    planId: plan.id,
    manifest,
    cancellationPollMs: 50,
    adapters: {
      research: {
        interruptible: true,
        async execute({ signal }) {
          started();
          return new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("interrupted");
              error.code = "WORK_PLAN_CANCELLED";
              error.executionEvidence = {
                kind: "controlled_command",
                verification: "operator_interrupt_confirmed",
                outputStored: false,
              };
              reject(error);
            }, { once: true });
          });
        },
      },
      document_draft: {
        async execute() { secondStepRan = true; },
      },
    },
  });
  await stepStarted;
  store.requestWorkPlanCancellation(plan.id, "operator");
  const result = await execution;
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelledDuringStep, "research");
  assert.equal(result.interruptConfirmed, true);
  assert.equal(secondStepRan, false);
  assert.equal(store.getWorkPlan(plan.id).status, "cancelled");
  assert.deepEqual(
    store.listWorkPlanSteps(plan.id).map((step) => step.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(store.listWorkPlanSteps(plan.id)[0].error, "operator_interrupted");
});

test("计划执行期间续租并在完成后清除租约", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  const adapter = {
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { verified: true, evidence: { kind: "verified" } };
    },
  };
  const result = await executeWorkPlan({
    store,
    planId: plan.id,
    manifest,
    adapters: { research: adapter, document_draft: adapter },
    executionOwner: "executor_1",
    leaseMs: 100,
    leaseRenewMs: 20,
  });
  assert.equal(result.status, "completed");
  assert.equal(store.getWorkPlan(plan.id).execution_owner, null);
  assert.equal(store.getWorkPlan(plan.id).lease_expires_at, null);
});

test("过期执行租约只标记中断，不自动重放副作用", async (t) => {
  const store = await fixture(t);
  const plan = store.registerWorkPlan(assessment());
  const startedAt = new Date("2026-08-04T00:00:00.000Z");
  store.consumeWorkPlanAuthorization(plan.id, startedAt, {
    owner: "dead_executor",
    leaseExpiresAt: new Date("2026-08-04T00:01:00.000Z"),
  });
  store.updateWorkPlanStep(plan.id, "research", { status: "executing" }, startedAt);
  assert.equal(store.recoverExpiredWorkPlans(new Date("2026-08-04T00:02:00.000Z")), 1);
  assert.equal(store.getWorkPlan(plan.id).status, "failed");
  assert.equal(store.listWorkPlanSteps(plan.id)[0].error, "execution_interrupted");
  assert.throws(() => store.consumeWorkPlanAuthorization(plan.id), /not authorized/u);
});
