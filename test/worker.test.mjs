import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
import {
  processApprovedTask,
  processDraftTask,
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
