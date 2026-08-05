import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
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

function enqueue(store, id = "m1") {
  const base = new Date("2020-01-01T10:00:00.000Z");
  store.ingestMessages(
    [
      {
        id,
        senderUserId: "u1",
        senderName: "测试用户",
        conversationId: "c1",
        createTime: base.toISOString(),
        content: "帮我看看这个方案",
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
};

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
  assert.deepEqual(cursors, [null, "task-99"]);
  assert.equal(result, 101);
  assert.equal(cancelled, 101);
});

test("草稿阶段上下文或人工复查暂不可用时安全降级", async (t) => {
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
  assert.equal(store.getTask(taskId).status, "awaiting_approval");
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
