import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-test-"));
  const store = await new Store(join(directory, "test.sqlite")).open();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function messages() {
  return [
    {
      id: "m1",
      senderUserId: "u1",
      senderName: "测试用户",
      conversationId: "c1",
      createTime: "2026-07-31T10:00:00.000Z",
      content: "你先看一下",
    },
    {
      id: "m2",
      senderUserId: "u1",
      senderName: "测试用户",
      conversationId: "c1",
      createTime: "2026-07-31T10:00:01.000Z",
      content: "就是昨天的方案",
    },
  ];
}

test("消息幂等入库并在安静窗口后合并为一个任务", async (t) => {
  const store = await fixture(t);
  const receivedAt = new Date("2026-07-31T10:00:02.000Z");
  assert.equal(store.ingestMessages(messages(), receivedAt), 2);
  assert.equal(store.ingestMessages(messages(), receivedAt), 0);
  assert.deepEqual(
    store.createReadyTasks({
      quietWindowMs: 3_000,
      now: new Date("2026-07-31T10:00:04.000Z"),
    }),
    [],
  );
  const taskIds = store.createReadyTasks({
    quietWindowMs: 3_000,
    now: new Date("2026-07-31T10:00:06.000Z"),
  });
  assert.equal(taskIds.length, 1);
  const task = store.getTask(taskIds[0]);
  assert.equal(task.payload.messages.length, 2);
  assert.equal(task.payload.content, "你先看一下\n就是昨天的方案");
  assert.deepEqual(
    store.createReadyTasks({
      quietWindowMs: 3_000,
      now: new Date("2026-07-31T10:01:00.000Z"),
    }),
    [],
  );
});

test("任务失败后重试，达到上限才进入死信", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({
    quietWindowMs: 1,
    maxAttempts: 2,
    now: new Date(base.getTime() + 10),
  });
  const first = store.claimTask({ now: new Date(base.getTime() + 10) });
  assert.equal(first.id, taskId);
  assert.equal(
    store.failTask(taskId, new Error("temporary"), new Date(base.getTime() + 10)),
    "queued",
  );
  assert.equal(store.claimTask({ now: new Date(base.getTime() + 500) }), null);
  const second = store.claimTask({ now: new Date(base.getTime() + 2_010) });
  assert.equal(second.id, taskId);
  assert.equal(
    store.failTask(
      taskId,
      new Error("permanent"),
      new Date(base.getTime() + 2_010),
    ),
    "dead",
  );
  assert.equal(store.getTask(taskId).status, "dead");
});

test("租约过期后任务可以恢复处理", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  assert.equal(
    store.claimTask({
      leaseMs: 1_000,
      now: new Date(base.getTime() + 10),
    }).id,
    taskId,
  );
  assert.equal(store.claimTask({ now: new Date(base.getTime() + 500) }), null);
  assert.equal(
    store.claimTask({ now: new Date(base.getTime() + 1_011) }).id,
    taskId,
  );
});

test("外发必须经过审批并记录幂等副作用", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  store.claimTask({ now: new Date(base.getTime() + 10) });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.8,
    riskLevel: "low",
    reason: "需要回应",
  });
  assert.equal(store.getTask(taskId).status, "awaiting_approval");
  store.decideTask(taskId, { decision: "approved", actor: "tester" });
  assert.equal(store.claimApprovedTask().id, taskId);
  const effect = store.beginSideEffect(taskId, "send_message");
  assert.equal(effect.status, "started");
  assert.equal(
    store.beginSideEffect(taskId, "send_message").idempotency_key,
    effect.idempotency_key,
  );
  store.completeSideEffect(taskId, "send_message", { success: true });
  assert.equal(store.getTask(taskId).status, "completed");
});

test("暂停开关持久化", async (t) => {
  const store = await fixture(t);
  assert.equal(store.isPaused(), false);
  store.setPaused(true);
  assert.equal(store.isPaused(), true);
  store.setPaused(false);
  assert.equal(store.isPaused(), false);
});

test("消息正文和任务载荷不会以明文落盘", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const rawMessage = store.db
    .prepare("SELECT content FROM messages WHERE id = 'm1'")
    .get();
  assert.match(rawMessage.content, /^enc:v1:/);
  assert.equal(rawMessage.content.includes("你先看一下"), false);

  const [taskId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  const rawTask = store.db
    .prepare("SELECT payload_json FROM tasks WHERE id = ?")
    .get(taskId);
  assert.match(rawTask.payload_json, /^enc:v1:/);
  assert.equal(rawTask.payload_json.includes("你先看一下"), false);
  assert.equal(store.getTask(taskId).payload.content, "你先看一下");
});

test("保留期清理只删除已经结束的旧任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2020-01-01T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  store.claimTask({ now: new Date(base.getTime() + 10) });
  store.completeDraft(
    taskId,
    {
      shouldReply: false,
      reply: "",
      confidence: 1,
      riskLevel: "low",
      reason: "无需回复",
    },
    base,
  );
  assert.equal(
    store.purgeCompleted({ before: new Date("2021-01-01T00:00:00.000Z") }),
    1,
  );
  assert.equal(store.getTask(taskId), null);
});

test("监听器和 Worker 并发启动时共享同一密钥和数据库", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-concurrent-test-"));
  const databasePath = join(directory, "shared.sqlite");
  const first = new Store(databasePath);
  const second = new Store(databasePath);
  t.after(async () => {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([first.open(), second.open()]);
  const base = new Date("2026-07-31T10:00:00.000Z");
  first.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = first.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  assert.equal(
    second.claimTask({ now: new Date(base.getTime() + 10) }).id,
    taskId,
  );
  assert.equal(second.getTask(taskId).payload.content, "你先看一下");
});

test("数据密钥不匹配时在启动阶段直接失败", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-key-test-"));
  const databasePath = join(directory, "encrypted.sqlite");
  const previous = process.env.AI_EMPLOYEE_DATA_KEY;
  try {
    process.env.AI_EMPLOYEE_DATA_KEY = Buffer.alloc(32, 1).toString("base64");
    const first = await new Store(databasePath).open();
    first.close();
    process.env.AI_EMPLOYEE_DATA_KEY = Buffer.alloc(32, 2).toString("base64");
    await assert.rejects(
      () => new Store(databasePath).open(),
      /data key does not match/,
    );
  } finally {
    if (previous === undefined) delete process.env.AI_EMPLOYEE_DATA_KEY;
    else process.env.AI_EMPLOYEE_DATA_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
