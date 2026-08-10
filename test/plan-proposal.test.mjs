import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
import { proposeWorkPlanForTask } from "../src/plan-proposal.mjs";

async function fixture(t, projectCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), "ai-plan-proposal-"));
  const root = join(directory, "project");
  const projectsDirectory = join(directory, "projects");
  await Promise.all([mkdir(root), mkdir(projectsDirectory)]);
  for (let index = 0; index < projectCount; index += 1) {
    await writeFile(join(projectsDirectory, `project-${index}.json`), JSON.stringify({
      version: 1,
      projectId: `project_${index}`,
      name: `项目${index}`,
      rootDirectory: root,
      requesters: ["user-1"],
      capabilities: { research: { mode: "automatic" } },
    }));
  }
  const fakeCodex = join(directory, "fake-codex");
  const output = JSON.stringify({
    steps: [{
      id: "研究",
      capability: "research",
      description: "分析项目内资料",
      workingDirectory: root,
      inputs: {},
      expectedEvidence: "带项目路径的研究结论",
      rollback: null,
    }],
  });
  await writeFile(fakeCodex, [
    "#!/bin/sh",
    "target=''",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = '--output-last-message' ]; then shift; target=\"$1\"; fi",
    "  shift",
    "done",
    "cat >/dev/null",
    `printf '%s' '${output.replaceAll("'", "'\\''")}' > \"$target\"`,
  ].join("\n"), { mode: 0o700 });
  await chmod(fakeCodex, 0o700);
  const store = await new Store(join(directory, "store.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    config: {
      capabilities: new Set(["draft_reply", "work_plan_proposal"]),
      projectsDirectory,
      codexPath: fakeCodex,
    },
  };
}

function enqueueSourceTask(store, suffix = "source") {
  const receivedAt = new Date("2026-08-10T08:00:00.000Z");
  store.ingestMessages([{
    id: `plan-proposal-${suffix}`,
    senderUserId: "user-1",
    senderName: "测试用户",
    conversationId: `plan-proposal-${suffix}`,
    createTime: receivedAt.toISOString(),
    content: "请形成研究计划",
  }], receivedAt);
  const [taskId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(receivedAt.getTime() + 10),
  });
  store.claimTask({ now: new Date(receivedAt.getTime() + 10) });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "已形成计划草稿。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "工作请求",
    decisionKind: "work_request",
  }, new Date(receivedAt.getTime() + 20));
  return taskId;
}

test("明确工作请求会在唯一授权项目中形成计划提案", async (t) => {
  const { store, config } = await fixture(t);
  const sourceTaskId = enqueueSourceTask(store);
  const result = await proposeWorkPlanForTask({
    store,
    config,
    task: { id: sourceTaskId, sender_user_id: "user-1" },
    draft: {
      workRequest: {
        requested: true,
        objective: "调研当前项目并形成结论",
        projectHint: "",
      },
    },
  });
  assert.equal(result.created, true);
  assert.equal(result.status, "ready");
  assert.equal(store.getWorkPlan(result.planId).plan.sourceTaskId, sourceTaskId);
  assert.equal(store.getWorkPlan(result.planId).objective, "调研当前项目并形成结论");
});

test("计划生成后注册前的人工接管复查可以阻止落库", async (t) => {
  const { store, config } = await fixture(t);
  const sourceTaskId = enqueueSourceTask(store, "guard");
  let checked = 0;
  const result = await proposeWorkPlanForTask({
    store,
    config,
    task: { id: sourceTaskId, sender_user_id: "user-1" },
    draft: {
      workRequest: {
        requested: true,
        objective: "规划期间负责人已经人工回复",
        projectHint: "",
      },
    },
    async beforeRegister() {
      checked += 1;
      return false;
    },
  });
  assert.equal(checked, 1);
  assert.equal(result.created, false);
  assert.equal(result.reason, "registration_guard_rejected");
  assert.equal(store.listWorkPlans({ limit: 10 }).length, 0);
});

test("项目暂停时不调用 Codex 生成新计划", async (t) => {
  const { store, config } = await fixture(t);
  store.setScopedPause({
    type: "project",
    value: "project_0",
    paused: true,
    actor: "operator",
  });
  const result = await proposeWorkPlanForTask({
    store,
    config,
    task: { id: "task-paused", sender_user_id: "user-1" },
    draft: {
      workRequest: {
        requested: true,
        objective: "暂停期间不要规划",
        projectHint: "",
      },
    },
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "project_paused");
  assert.equal(store.listWorkPlans({ limit: 10 }).length, 0);
});

test("多个可用项目且没有明确提示时不猜项目", async (t) => {
  const { store, config } = await fixture(t, 2);
  const result = await proposeWorkPlanForTask({
    store,
    config,
    task: { sender_user_id: "user-1" },
    draft: {
      workRequest: {
        requested: true,
        objective: "整理方案",
        projectHint: "",
      },
    },
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "project_is_ambiguous");
  assert.equal(result.eligibleProjectCount, 2);
});

test("未授权请求人不能借工作请求读取项目", async (t) => {
  const { store, config } = await fixture(t);
  const result = await proposeWorkPlanForTask({
    store,
    config,
    task: { sender_user_id: "other-user" },
    draft: {
      workRequest: {
        requested: true,
        objective: "读取项目",
        projectHint: "project_0",
      },
    },
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, "requester_has_no_project");
});
