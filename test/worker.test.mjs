import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";
import {
  processApprovedTask,
  processDraftTask,
  reconcileManualReplies,
  runWorker,
} from "../src/worker.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-worker-test-"));
  const store = await new Store(join(directory, "test.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function enqueue(
  store,
  id = "m1",
  content = "帮我看看这个方案",
  senderUserId = "u1",
) {
  const base = new Date("2020-01-01T10:00:00.000Z");
  store.ingestMessages(
    [
      {
        id,
        senderUserId,
        senderName: "测试用户",
        conversationId: "c1",
        createTime: base.toISOString(),
        content,
      },
    ],
    base,
  );
  return store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  })[0];
}

const baseConfig = {
  capabilities: new Set(["draft_reply"]),
  codexPath: "/fake/codex",
  selfUserId: null,
  targetUserIds: ["u1"],
  targetGroupIds: [],
};

const manualTakeoverManifest = {
  version: 1,
  projectId: "manual_takeover_project",
  name: "人工接管测试项目",
  rootDirectory: "/workspace/manual-takeover",
  requesters: ["u1"],
  capabilities: {
    code_patch: { mode: "approval_required" },
  },
};

function manualTakeoverAssessment(sourceTaskId, objective = "完成修改") {
  return assessWorkPlan({
    manifest: manualTakeoverManifest,
    plan: {
      version: 1,
      projectId: manualTakeoverManifest.projectId,
      requesterId: "u1",
      sourceTaskId,
      objective,
      steps: [{
        id: "code",
        capability: "code_patch",
        description: objective,
        workingDirectory: manualTakeoverManifest.rootDirectory,
        expectedEvidence: "代码差异",
      }],
    },
  });
}

function completeSourceTask(
  store,
  id,
  reply = "我先形成计划。",
) {
  const taskId = enqueue(store, id, "请完成修改");
  const base = new Date("2020-01-01T10:00:00.000Z");
  store.claimTask({ now: new Date(base.getTime() + 20) });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply,
    confidence: 0.9,
    riskLevel: "medium",
    reason: "明确工作请求",
  }, new Date(base.getTime() + 30));
  store.decideTask(
    taskId,
    { decision: "approved", actor: "tester" },
    new Date(base.getTime() + 40),
  );
  store.claimApprovedTask({ now: new Date(base.getTime() + 50) });
  store.beginSideEffect(taskId, "send_message", new Date(base.getTime() + 60));
  store.completeSideEffect(
    taskId,
    "send_message",
    { success: true, messageId: `${id}-ai-message` },
    new Date(base.getTime() + 70),
  );
  return taskId;
}

test("Worker 失败后任务保留并可重试", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  const dws = {
    async fetchDirect() {
      return [];
    },
  };
  await processDraftTask({
    store,
    dws,
    config: baseConfig,
    async generator() {
      throw new Error("Codex timeout");
    },
  });
  assert.equal(store.getTask(taskId).status, "queued");
  assert.equal(store.getTask(taskId).attempts, 1);
});

test("Worker 只生成草稿并进入待审批", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  const dws = {
    async fetchDirect() {
      return [{ content: "上下文" }];
    },
  };
  await processDraftTask({
    store,
    dws,
    config: baseConfig,
    async generator(event, options) {
      assert.equal(event.taskId, taskId);
      assert.equal(options.conversation.length, 1);
      return {
        shouldReply: true,
        reply: "我先看一下。",
        confidence: 0.9,
        riskLevel: "low",
        reason: "对方提出请求",
      };
    },
  });
  assert.equal(store.getTask(taskId).status, "awaiting_approval");
});

test("询问能力时依据当前授权确定性回答且不调用 Codex", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "capability-question", "你这个 AI 员工能做什么？");
  let generated = false;
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config: {
      ...baseConfig,
      capabilities: new Set(["draft_reply", "work_plan_proposal"]),
    },
    async generator() { generated = true; },
  });
  const task = store.getTask(taskId);
  assert.equal(generated, false);
  assert.equal(task.status, "awaiting_approval");
  assert.equal(task.result.decisionSource, "capability_catalog");
  assert.match(task.result.reply, /真实发送关闭/u);
  assert.match(task.result.reply, /计划自动执行关闭/u);
  assert.doesNotMatch(task.result.reply, /计划提案/u);
});

test("联系人暂停时不调用 Codex 且不消耗重试次数", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "paused-contact");
  store.setScopedPause({
    type: "contact",
    value: "u1",
    paused: true,
    actor: "operator",
  });
  let generated = false;
  await processDraftTask({
    store,
    dws: {},
    config: baseConfig,
    async generator() { generated = true; },
  });
  assert.equal(generated, false);
  assert.equal(store.getTask(taskId).status, "queued");
  assert.equal(store.getTask(taskId).attempts, 0);
});

test("群聊暂停时不调用 Codex 且不消耗重试次数", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "paused-group");
  store.setScopedPause({
    type: "group",
    value: "c1",
    paused: true,
    actor: "operator",
  });
  let generated = false;
  await processDraftTask({
    store,
    dws: {},
    config: { ...baseConfig, targetGroupIds: ["c1"] },
    async generator() { generated = true; },
  });
  assert.equal(generated, false);
  assert.equal(store.getTask(taskId).status, "queued");
  assert.equal(store.getTask(taskId).attempts, 0);
});

test("明确工作请求只创建计划提案而不自动执行", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "work-request");
  let proposed = 0;
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config: {
      ...baseConfig,
      capabilities: new Set(["draft_reply", "work_plan_proposal"]),
    },
    async generator() {
      return {
        shouldReply: true,
        reply: "我先形成计划，等你审批。",
        confidence: 0.9,
        riskLevel: "medium",
        reason: "这是明确工作请求",
        workRequest: {
          requested: true,
          objective: "整理方案",
          projectHint: "",
        },
      };
    },
    async planProposer({ task, draft }) {
      proposed += 1;
      assert.equal(task.id, taskId);
      assert.equal(draft.workRequest.objective, "整理方案");
      return { created: true, planId: "plan-1" };
    },
  });
  assert.equal(proposed, 1);
  assert.equal(store.getTask(taskId).status, "awaiting_approval");
});

test("缺少必要信息时只生成追问且不创建工作计划", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "needs-information", "帮我上线");
  let proposed = 0;
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config: {
      ...baseConfig,
      capabilities: new Set(["draft_reply", "work_plan_proposal"]),
    },
    async generator(event) {
      assert.equal(event.waitingTask, null);
      return {
        shouldReply: true,
        reply: "请问目标上线日期是什么时候？",
        confidence: 0.9,
        riskLevel: "low",
        reason: "缺少上线日期",
        needsInformation: true,
        relatedToWaitingTask: false,
        workRequest: {
          requested: true,
          objective: "上线",
          projectHint: null,
        },
      };
    },
    async planProposer() { proposed += 1; },
  });
  assert.equal(proposed, 0);
  assert.equal(store.getTask(taskId).status, "awaiting_approval");
});

test("判定不应回复时即使模型输出工作请求也不提计划", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "no-reply-work-request", "只做记录");
  let proposed = 0;
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config: {
      ...baseConfig,
      capabilities: new Set(["draft_reply", "work_plan_proposal"]),
    },
    async generator() {
      return {
        shouldReply: false,
        reply: "",
        confidence: 0.9,
        riskLevel: "low",
        reason: "不应回复",
        workRequest: {
          requested: true,
          objective: "不应被提案的计划",
          projectHint: "",
        },
      };
    },
    async planProposer() {
      proposed += 1;
      return { created: true, planId: "unexpected" };
    },
  });
  assert.equal(proposed, 0);
  assert.equal(store.getTask(taskId).status, "no_reply");
});

test("没有发送能力时，即使已审批也不会外发", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  store.claimTask({ now: new Date("2026-07-31T10:00:00.010Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  let sent = false;
  const result = await processApprovedTask({
    store,
    dws: {
      async sendText() {
        sent = true;
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
  });
  assert.equal(result, false);
  assert.equal(sent, false);
  assert.equal(store.getTask(taskId).status, "approved");
});

test("联系人暂停时已批准草稿也不会发送", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "paused-send");
  store.claimTask({ now: new Date("2026-07-31T10:00:00.010Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "暂不发送",
    confidence: 0.9,
    riskLevel: "low",
    reason: "测试",
  });
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  store.setScopedPause({
    type: "contact",
    value: "u1",
    paused: true,
    actor: "operator",
  });
  let sent = false;
  await processApprovedTask({
    store,
    config: {
      ...baseConfig,
      selfUserId: "self",
      capabilities: new Set(["draft_reply", "send_message"]),
      targetGroupIds: [],
    },
    dws: {
      async sendText() { sent = true; },
    },
  });
  assert.equal(sent, false);
  assert.equal(store.getTask(taskId).status, "approved");
  assert.equal(store.getTask(taskId).last_error, "contact_paused");
});

test("群聊暂停时已批准草稿也不会发送", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "paused-group-send");
  store.claimTask({ now: new Date("2026-07-31T10:00:00.010Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "暂不发送",
    confidence: 0.9,
    riskLevel: "low",
    reason: "测试",
  });
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  store.setScopedPause({
    type: "group",
    value: "c1",
    paused: true,
    actor: "operator",
  });
  let sent = false;
  await processApprovedTask({
    store,
    config: {
      ...baseConfig,
      selfUserId: "self",
      capabilities: new Set([
        "draft_reply",
        "send_message",
        "send_group_message",
      ]),
      targetGroupIds: ["c1"],
    },
    dws: {
      async sendGroupText() { sent = true; },
    },
  });
  assert.equal(sent, false);
  assert.equal(store.getTask(taskId).status, "approved");
  assert.equal(store.getTask(taskId).last_error, "group_paused");
});

test("审批、人工回复检查和幂等键全部满足后才发送", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  store.claimTask({ now: new Date("2026-07-31T10:00:00.010Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  let sent;
  await processApprovedTask({
    store,
    dws: {
      async hasManualReply() {
        return { known: true, replied: false };
      },
      async sendText(input) {
        sent = input;
        return { success: true };
      },
    },
    config: {
      ...baseConfig,
      selfUserId: "self",
      capabilities: new Set(["draft_reply", "send_message"]),
    },
  });
  assert.equal(sent.idempotencyKey, taskId);
  assert.equal(store.getTask(taskId).status, "completed");
});

test("最终发送前拒绝已不在用户白名单中的原始发件人", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(
    store,
    "unexpected-sender",
    "请处理这个请求",
    "unexpected-user",
  );
  store.claimTask({ now: new Date("2026-07-31T10:00:00.010Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先处理。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  let manualReplyChecked = false;
  let sent = false;
  await processApprovedTask({
    store,
    dws: {
      async hasManualReply() { manualReplyChecked = true; },
      async sendText() { sent = true; },
    },
    config: {
      ...baseConfig,
      selfUserId: "self",
      targetUserIds: ["allowlisted-user"],
      capabilities: new Set(["draft_reply", "send_message"]),
    },
  });
  assert.equal(manualReplyChecked, false);
  assert.equal(sent, false);
  assert.equal(store.getTask(taskId).status, "approved");
  assert.equal(store.getTask(taskId).last_error, "sender_not_allowlisted");
});

test("白名单群消息不要求发件人同时位于私聊白名单", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "group-sender", "@我 请处理", "group-member");
  store.claimTask({ now: new Date("2026-07-31T10:00:00.010Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "收到，我来处理。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  let sent = false;
  await processApprovedTask({
    store,
    dws: {
      async hasManualReply() {
        return { known: true, replied: false };
      },
      async sendGroupText() {
        sent = true;
        return { success: true };
      },
    },
    config: {
      ...baseConfig,
      selfUserId: "self",
      targetUserIds: [],
      targetGroupIds: ["c1"],
      capabilities: new Set([
        "draft_reply",
        "send_message",
        "send_group_message",
      ]),
    },
  });
  assert.equal(sent, true);
  assert.equal(store.getTask(taskId).status, "completed");
});

test("DWS 未返回明确成功回执时进入发送结果未知", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "unknown-receipt");
  store.claimTask({ now: new Date("2026-07-31T10:00:00.010Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  await processApprovedTask({
    store,
    dws: {
      async hasManualReply() {
        return { known: true, replied: false };
      },
      async sendText() {
        return { result: [] };
      },
    },
    config: {
      ...baseConfig,
      selfUserId: "self",
      capabilities: new Set(["draft_reply", "send_message"]),
    },
  });
  const task = store.getTask(taskId);
  assert.equal(task.status, "send_unknown");
  assert.match(task.last_error, /explicit success receipt/u);
});

test("检测到人工已经回复时取消发送", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  store.claimTask({ now: new Date("2026-07-31T10:00:00.010Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  await processApprovedTask({
    store,
    dws: {
      async hasManualReply() {
        return { known: true, replied: true };
      },
    },
    config: {
      ...baseConfig,
      selfUserId: "self",
      capabilities: new Set(["draft_reply", "send_message"]),
    },
  });
  assert.equal(store.getTask(taskId).status, "cancelled_manual");
});

test("草稿生成后人工回复会自动取消待审批", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  store.claimTask({ now: new Date("2020-01-01T10:00:00.020Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  const cancelled = await reconcileManualReplies({
    store,
    dws: {
      async fetchBySenderAll({ senderUserId }) {
        assert.equal(senderUserId, "self");
        return [
          {
            conversationId: "c1",
            createTime: "2020-01-01T10:01:00.000Z",
          },
        ];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
    now: new Date("2020-01-01T10:02:00.000Z"),
  });
  assert.equal(cancelled, 1);
  assert.equal(store.getTask(taskId).status, "cancelled_manual");
});

test("其他会话的人工回复不会取消草稿", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  store.claimTask({ now: new Date("2020-01-01T10:00:00.020Z") });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  const cancelled = await reconcileManualReplies({
    store,
    dws: {
      async fetchBySenderAll() {
        return [
          {
            conversationId: "c2",
            createTime: "2020-01-01T10:01:00.000Z",
          },
        ];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
  });
  assert.equal(cancelled, 0);
  assert.equal(store.getTask(taskId).status, "awaiting_approval");
});

test("人工回复复查会分页覆盖超过一百条待审批草稿", async () => {
  const tasks = Array.from({ length: 101 }, (_, index) => ({
    id: `task-${index}`,
    created_at: new Date(1_000_000 - index).toISOString(),
    conversation_id: "c1",
    payload: { latestCreateTime: "2020-01-01T10:00:00.000Z" },
  }));
  const cursors = [];
  let pageIndex = 0;
  let cancelled = 0;
  const result = await reconcileManualReplies({
    store: {
      async listTasks({ beforeId, limit }) {
        cursors.push(beforeId ?? null);
        const start = pageIndex * limit;
        pageIndex += 1;
        return tasks.slice(start, start + limit);
      },
      async cancelDraftForManualReply() {
        cancelled += 1;
        return true;
      },
    },
    dws: {
      async fetchBySenderAll() {
        return [
          {
            conversationId: "c1",
            createTime: "2020-01-01T10:01:00.000Z",
          },
        ];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
    limit: 100,
  });
  assert.deepEqual(cursors, [null, "task-99", null]);
  assert.equal(result, 101);
  assert.equal(cancelled, 101);
});

test("来源任务已完成后人工回复仍会取消待审批计划", async (t) => {
  const store = await fixture(t);
  const taskId = completeSourceTask(store, "completed-plan-source");
  const plan = store.registerWorkPlan(
    manualTakeoverAssessment(taskId, "尚未执行的修改"),
    new Date("2020-01-01T10:00:00.080Z"),
  );
  assert.equal(store.getTask(taskId).status, "completed");
  assert.equal(plan.status, "awaiting_approval");

  const cancelled = await reconcileManualReplies({
    store,
    dws: {
      async fetchBySenderAll() {
        return [{
          conversationId: "c1",
          createTime: "2020-01-01T10:01:00.000Z",
          content: "我来接手处理。",
          raw: {},
        }];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
    now: new Date("2020-01-01T10:02:00.000Z"),
  });
  assert.equal(cancelled, 1);
  assert.equal(store.getTask(taskId).status, "completed");
  assert.equal(store.getWorkPlan(plan.id).status, "cancelled");
  assert.equal(store.listWorkPlanSteps(plan.id)[0].status, "cancelled");
});

test("来源任务已完成后人工回复会对执行中计划提出取消请求", async (t) => {
  const store = await fixture(t);
  const taskId = completeSourceTask(store, "executing-plan-source");
  const plan = store.registerWorkPlan(
    manualTakeoverAssessment(taskId, "正在执行的修改"),
    new Date("2020-01-01T10:00:00.080Z"),
  );
  store.decideWorkPlan(
    plan.id,
    { decision: "approved", actor: "tester" },
    new Date("2020-01-01T10:00:00.090Z"),
  );
  assert.equal(
    store.consumeWorkPlanAuthorization(
      plan.id,
      new Date("2020-01-01T10:00:00.100Z"),
    ),
    true,
  );

  const cancelled = await reconcileManualReplies({
    store,
    dws: {
      async fetchBySenderAll() {
        return [{
          conversationId: "c1",
          createTime: "2020-01-01T10:01:00.000Z",
          content: "这个我自己继续。",
          raw: {},
        }];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
    now: new Date("2020-01-01T10:02:00.000Z"),
  });
  const updated = store.getWorkPlan(plan.id);
  assert.equal(cancelled, 1);
  assert.equal(updated.status, "executing");
  assert.ok(updated.cancel_requested_at);
  assert.equal(updated.cancel_requested_by, "system:manual-reply");
});

test("活动计划来源任务不会把 AI 标记消息误判为人工接管", async (t) => {
  const store = await fixture(t);
  const reply = "我先形成计划。";
  const taskId = completeSourceTask(store, "automated-plan-source", reply);
  const plan = store.registerWorkPlan(
    manualTakeoverAssessment(taskId, "等待审批的修改"),
    new Date("2020-01-01T10:00:00.080Z"),
  );

  const cancelled = await reconcileManualReplies({
    store,
    dws: {
      async fetchBySenderAll() {
        return [{
          conversationId: "c1",
          createTime: "2020-01-01T10:01:00.000Z",
          content: reply,
          raw: { aiTag: true },
        }];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
    now: new Date("2020-01-01T10:02:00.000Z"),
  });
  assert.equal(cancelled, 0);
  assert.equal(store.getWorkPlan(plan.id).status, "awaiting_approval");
});

test("活动计划扫描会扩大数量窗口并覆盖全部来源任务", async () => {
  const plans = Array.from({ length: 3 }, (_, index) => ({
    id: `plan-${index}`,
    plan: { sourceTaskId: `source-${index}` },
  }));
  const requestedLimits = [];
  const loadedTaskIds = [];
  const cancelledTaskIds = [];
  const result = await reconcileManualReplies({
    store: {
      async listTasks() { return []; },
      async listWorkPlans({ status, limit }) {
        if (status !== "awaiting_approval") return [];
        requestedLimits.push(limit);
        return plans.slice(0, limit);
      },
      async getTask(id) {
        loadedTaskIds.push(id);
        return {
          id,
          status: "completed",
          conversation_id: "c1",
          payload: { latestCreateTime: "2020-01-01T10:00:00.000Z" },
        };
      },
      async cancelDraftForManualReply(id) {
        cancelledTaskIds.push(id);
        return false;
      },
    },
    dws: {
      async fetchBySenderAll() {
        return [{
          conversationId: "c1",
          createTime: "2020-01-01T10:01:00.000Z",
          content: "人工接管",
          raw: {},
        }];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
    limit: 2,
    now: new Date("2020-01-01T10:02:00.000Z"),
  });
  assert.deepEqual(requestedLimits, [2, 4]);
  assert.deepEqual(loadedTaskIds.sort(), ["source-0", "source-1", "source-2"]);
  assert.deepEqual(cancelledTaskIds.sort(), ["source-0", "source-1", "source-2"]);
  assert.equal(result, 3);
});

test("人工接管会关闭等待任务且不会把 AI 自己的追问误判为人工回复", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "waiting-manual", "帮我上线");
  const waitingAt = new Date("2020-01-01T10:00:00.020Z");
  store.claimTask({ now: waitingAt });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "请补充上线日期。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "缺少必要信息",
    needsInformation: true,
    relatedToWaitingTask: false,
    workRequest: null,
  }, waitingAt);
  store.decideTask(taskId, { decision: "approved", actor: "tester" }, waitingAt);
  store.claimApprovedTask({ now: waitingAt });
  store.beginSideEffect(taskId, "send_message", waitingAt);
  store.completeSideEffect(taskId, "send_message", { success: true }, waitingAt);

  const automatedReply = await reconcileManualReplies({
    store,
    dws: {
      async fetchBySenderAll() {
        return [{
          conversationId: "c1",
          createTime: new Date(waitingAt.getTime() + 1_000).toISOString(),
          content: "请补充上线日期。",
          raw: {},
        }];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
  });
  assert.equal(automatedReply, 0);
  assert.equal(store.getTask(taskId).status, "waiting_information");

  const manual = await reconcileManualReplies({
    store,
    dws: {
      async fetchBySenderAll() {
        return [{
          conversationId: "c1",
          createTime: new Date(waitingAt.getTime() + 1_000).toISOString(),
          content: "我来接手处理。",
          raw: {},
        }];
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
  });
  assert.equal(manual, 1);
  assert.equal(store.getTask(taskId).status, "cancelled_manual");
});

test("补充消息到达前的人工接管仍会关闭整条等待链", async (t) => {
  const store = await fixture(t);
  const parentId = enqueue(store, "waiting-chain-parent", "帮我上线");
  const waitingAt = new Date("2020-01-01T10:00:00.020Z");
  store.claimTask({ now: waitingAt });
  store.completeDraft(parentId, {
    shouldReply: true,
    reply: "请补充上线日期。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "缺少必要信息",
    needsInformation: true,
    relatedToWaitingTask: false,
    workRequest: null,
  }, waitingAt);
  store.decideTask(parentId, {
    decision: "approved",
    actor: "tester",
  }, waitingAt);
  store.claimApprovedTask({ now: waitingAt });
  store.beginSideEffect(parentId, "send_message", waitingAt);
  store.completeSideEffect(
    parentId,
    "send_message",
    { success: true },
    waitingAt,
  );

  const answerAt = new Date(waitingAt.getTime() + 2_000);
  store.ingestMessages([{
    id: "waiting-chain-answer",
    senderUserId: "u1",
    senderName: "测试用户",
    conversationId: "c1",
    createTime: answerAt.toISOString(),
    content: "下周一上线",
  }], answerAt);
  const [childId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(answerAt.getTime() + 10),
  });
  let generated = false;
  await processDraftTask({
    store,
    dws: {
      async hasManualReply({ after }) {
        assert.equal(new Date(after).toISOString(), waitingAt.toISOString());
        return { known: true, replied: true };
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
    async generator() {
      generated = true;
      throw new Error("人工接管后不应生成草稿");
    },
  });
  assert.equal(generated, false);
  assert.equal(store.getTask(childId).status, "no_reply");
  assert.equal(store.getTask(parentId).status, "cancelled_manual");
});

test("草稿生成期间出现人工回复时不落草稿、记忆或工作计划", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "manual-during-generation", "帮我整理并上线方案");
  let checks = 0;
  let proposed = 0;
  await processDraftTask({
    store,
    dws: {
      async hasManualReply() {
        checks += 1;
        return { known: true, replied: checks >= 2 };
      },
      async fetchDirect() { return []; },
    },
    config: {
      ...baseConfig,
      selfUserId: "self",
      capabilities: new Set(["draft_reply", "work_plan_proposal"]),
    },
    async generator() {
      return {
        shouldReply: true,
        reply: "我先形成计划。",
        confidence: 0.9,
        riskLevel: "medium",
        reason: "明确工作请求",
        memoryCandidates: [{
          type: "person",
          statement: "对方偏好简短回复。",
          factKey: "communication.reply_length",
          sensitivity: "internal",
          retentionDays: 90,
          confidence: 0.9,
          projectHint: "",
          sourceMessageId: "manual-during-generation",
        }],
        workRequest: {
          requested: true,
          objective: "整理并上线方案",
          projectHint: "",
        },
      };
    },
    async planProposer() {
      proposed += 1;
      return { created: true, planId: "should-not-exist" };
    },
  });
  assert.equal(checks, 2);
  assert.equal(proposed, 0);
  assert.equal(store.getTask(taskId).status, "cancelled_manual");
  assert.equal(store.listMemories({ status: "proposed" }).length, 0);
});

test("计划生成期间出现人工回复时注册前再次阻止计划", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store, "manual-during-planning", "帮我整理并上线方案");
  let checks = 0;
  let registered = 0;
  await processDraftTask({
    store,
    dws: {
      async hasManualReply() {
        checks += 1;
        return { known: true, replied: checks >= 3 };
      },
      async fetchDirect() { return []; },
    },
    config: {
      ...baseConfig,
      selfUserId: "self",
      capabilities: new Set(["draft_reply", "work_plan_proposal"]),
    },
    async generator() {
      return {
        shouldReply: true,
        reply: "我先形成计划。",
        confidence: 0.9,
        riskLevel: "medium",
        reason: "明确工作请求",
        workRequest: {
          requested: true,
          objective: "整理并上线方案",
          projectHint: "",
        },
      };
    },
    async planProposer({ beforeRegister }) {
      if (await beforeRegister()) registered += 1;
      return { created: false, reason: "registration_guard_rejected" };
    },
  });
  assert.equal(checks, 3);
  assert.equal(registered, 0);
  assert.equal(store.getTask(taskId).status, "cancelled_manual");
});

test("人工复查持续不可用时不落草稿或计划并进入安全重试", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  let generated = false;
  await processDraftTask({
    store,
    dws: {
      async hasManualReply() {
        throw new Error("gateway unavailable for secret-user");
      },
      async fetchDirect() {
        throw new Error("network unavailable for secret-user");
      },
    },
    config: { ...baseConfig, selfUserId: "self" },
    async generator(_event, options) {
      generated = true;
      assert.deepEqual(options.conversation, []);
      return {
        shouldReply: true,
        reply: "我先看一下。",
        confidence: 0.8,
        riskLevel: "low",
        reason: "需要回复",
      };
    },
  });
  assert.equal(generated, true);
  assert.equal(store.getTask(taskId).status, "queued");
  assert.equal(store.getTask(taskId).attempts, 1);
});

test("群聊草稿不调用无权限的完整群历史接口", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  let fetchedGroup = false;
  await processDraftTask({
    store,
    dws: {
      async fetchGroup() {
        fetchedGroup = true;
        throw new Error("forbidden");
      },
    },
    config: {
      ...baseConfig,
      targetGroupIds: ["c1"],
    },
    async generator(event, options) {
      assert.equal(event.chatType, "group");
      assert.deepEqual(options.conversation, []);
      return {
        shouldReply: false,
        reply: "",
        confidence: 1,
        riskLevel: "low",
        reason: "无需回复",
      };
    },
  });
  assert.equal(fetchedGroup, false);
  assert.equal(store.getTask(taskId).status, "no_reply");
});

test("草稿只使用已确认且非机密的正式记忆", async (t) => {
  const store = await fixture(t);
  const taskId = enqueue(store);
  const confirmed = store.proposeMemory({
    type: "person",
    subject: "u1",
    statement: "对方偏好简短回复。",
    sourceType: "user_confirmation",
    sourceId: "source-1",
    createdBy: "tester",
  });
  store.confirmMemory(confirmed, "approver");
  const confidential = store.proposeMemory({
    type: "person",
    subject: "u1",
    statement: "不能进入回复上下文的机密内容。",
    sourceType: "user_confirmation",
    sourceId: "source-2",
    sensitivity: "confidential",
    createdBy: "tester",
  });
  store.confirmMemory(confidential, "approver");
  store.proposeMemory({
    type: "principle",
    subject: "回复原则",
    statement: "尚未确认的候选内容。",
    sourceType: "inference",
    sourceId: "source-3",
    createdBy: "tester",
  });
  await processDraftTask({
    store,
    dws: { async fetchDirect() { return []; } },
    config: baseConfig,
    async generator(_event, options) {
      assert.deepEqual(
        options.memories.map((memory) => memory.statement),
        ["对方偏好简短回复。"],
      );
      return {
        shouldReply: false,
        reply: "",
        confidence: 1,
        riskLevel: "low",
        reason: "无需回复",
      };
    },
  });
  assert.equal(store.getTask(taskId).status, "no_reply");
});

test("全局暂停时仍检测人工接管并请求停止执行中计划", async (t) => {
  const store = await fixture(t);
  const sourceTaskId = completeSourceTask(store, "paused-executing-source");
  const plan = store.registerWorkPlan(
    manualTakeoverAssessment(sourceTaskId, "暂停期间的执行计划"),
    new Date("2020-01-01T10:00:00.080Z"),
  );
  store.decideWorkPlan(
    plan.id,
    { decision: "approved", actor: "tester" },
    new Date("2020-01-01T10:00:00.090Z"),
  );
  store.consumeWorkPlanAuthorization(
    plan.id,
    new Date("2020-01-01T10:00:00.100Z"),
  );
  const queuedTaskId = enqueue(store, "paused-new-task", "暂停时不应生成草稿");
  store.setPaused(true);

  let resolveScanned;
  const scanned = new Promise((resolve) => { resolveScanned = resolve; });
  let generated = 0;
  let worker;
  try {
    worker = await runWorker({
      store,
      dws: {
        async fetchBySenderAll() {
          resolveScanned();
          return [{
            conversationId: "c1",
            createTime: "2020-01-01T10:01:00.000Z",
            content: "我来接管这个执行任务。",
            raw: {},
          }];
        },
      },
      config: {
        ...baseConfig,
        selfUserId: "self",
        workerPollMs: 60_000,
        heartbeatMs: 30_000,
        manualReplyRecheckMs: 1_000,
      },
      async generator() {
        generated += 1;
        throw new Error("暂停时不应生成草稿");
      },
    });
    let timeout;
    await Promise.race([
      scanned,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("暂停期间未执行人工接管检查")),
          1_000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (store.getWorkPlan(plan.id).cancel_requested_at) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const updatedPlan = store.getWorkPlan(plan.id);
    assert.equal(updatedPlan.status, "executing");
    assert.ok(updatedPlan.cancel_requested_at);
    assert.equal(updatedPlan.cancel_requested_by, "system:manual-reply");
    assert.equal(generated, 0);
    assert.equal(store.getTask(queuedTaskId).status, "queued");
  } finally {
    await worker?.stop();
  }
});

test("Worker 停止时会立即唤醒，不等待完整轮询周期", async (t) => {
  const store = await fixture(t);
  const worker = await runWorker({
    store,
    dws: {},
    config: {
      ...baseConfig,
      workerPollMs: 60_000,
      heartbeatMs: 30_000,
    },
  });
  const startedAt = Date.now();
  await worker.stop();
  assert.ok(Date.now() - startedAt < 1_000);
});
