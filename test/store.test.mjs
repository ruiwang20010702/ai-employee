import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { memoryDeletionConfirmation } from "../src/memory-portability.mjs";
import { Store } from "../src/store.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";
import { workPlanMemoryEvidenceScope } from "../src/work-evidence.mjs";
import { buildGraphProjection, createGraphEdge, createGraphNode } from "../src/governed-work-graph.mjs";
import { draftSha256 } from "../src/decision-quality.mjs";

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

function graphFixture(tenantId = "tenant-sqlite", projectId = "graph_project") {
  const observedAt = "2026-08-12T08:00:00.000Z";
  const node = (nodeType, domainId, revision, sensitivity = "internal") => createGraphNode({
    tenantId, projectId, nodeType, domainId, revision, sensitivity, observedAt,
    provenance: { recordType: nodeType, recordId: domainId, recordVersion: revision },
  });
  const authorization = node("authorization", "auth-1", "a".repeat(64), "confidential");
  const step = node("step", "plan-1:step-1", "step-v1");
  const edge = createGraphEdge({
    edgeType: "authorization.permits_step",
    from: authorization,
    to: step,
    phase: "intended",
    authorizationHash: "a".repeat(64),
    observedAt,
    provenance: { recordType: "capability_policy", recordId: "research", recordVersion: "v1" },
  });
  return buildGraphProjection({ nodes: [authorization, step], edges: [edge] });
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

test("连续输入达到总等待上限后必须创建任务", async (t) => {
  const store = await fixture(t);
  const firstAt = new Date("2026-08-10T08:00:00.000Z");
  store.ingestMessages([
    {
      id: "max-wait-1",
      senderUserId: "u1",
      senderName: "测试用户",
      conversationId: "c1",
      createTime: firstAt.toISOString(),
      content: "第一段",
    },
  ], firstAt);
  assert.equal(
    store.nextPendingBundleAt({
      quietWindowMs: 3_000,
      bundleMaxWaitMs: 8_000,
    }).toISOString(),
    new Date(firstAt.getTime() + 3_000).toISOString(),
  );
  const secondAt = new Date(firstAt.getTime() + 7_500);
  store.ingestMessages([
    {
      id: "max-wait-2",
      senderUserId: "u1",
      senderName: "测试用户",
      conversationId: "c1",
      createTime: secondAt.toISOString(),
      content: "第二段",
    },
  ], secondAt);
  assert.equal(
    store.nextPendingBundleAt({
      quietWindowMs: 3_000,
      bundleMaxWaitMs: 8_000,
    }).toISOString(),
    new Date(firstAt.getTime() + 8_000).toISOString(),
  );
  assert.deepEqual(store.createReadyTasks({
    quietWindowMs: 3_000,
    bundleMaxWaitMs: 8_000,
    now: new Date(firstAt.getTime() + 7_999),
  }), []);
  const taskIds = store.createReadyTasks({
    quietWindowMs: 3_000,
    bundleMaxWaitMs: 8_000,
    now: new Date(firstAt.getTime() + 8_000),
  });
  assert.equal(taskIds.length, 1);
  assert.equal(store.getTask(taskIds[0]).payload.content, "第一段\n第二段");
  assert.equal(store.nextPendingBundleAt({
    quietWindowMs: 3_000,
    bundleMaxWaitMs: 8_000,
  }), null);
  assert.throws(
    () => store.createReadyTasks({
      quietWindowMs: 3_000,
      bundleMaxWaitMs: 8_001,
      now: new Date(firstAt.getTime() + 8_001),
    }),
    /8000ms/u,
  );
});

test("显式紧急信号可以提前结束安静窗口", async (t) => {
  const store = await fixture(t);
  const receivedAt = new Date("2026-08-10T08:00:00.000Z");
  store.ingestMessages([{
    id: "early-urgent",
    senderUserId: "u1",
    senderName: "测试用户",
    conversationId: "c1",
    createTime: receivedAt.toISOString(),
    content: "[紧急] 生产服务异常",
  }], receivedAt);
  const taskIds = store.createReadyTasks({
    quietWindowMs: 3_000,
    bundleMaxWaitMs: 8_000,
    now: new Date(receivedAt.getTime() + 100),
  });
  assert.equal(taskIds.length, 1);
  assert.equal(store.getTask(taskIds[0]).payload.content, "[紧急] 生产服务异常");
});

test("消息覆盖对账可批量确认已入库主键", async (t) => {
  const store = await fixture(t);
  store.ingestMessages(messages(), new Date("2026-07-31T10:00:02.000Z"));
  assert.deepEqual(
    [...store.knownMessageIds(["m2", "missing", "m1", "m1"])].sort(),
    ["m1", "m2"],
  );
  assert.deepEqual([...store.knownMessageIds([])], []);
});

test("局部暂停值加密保存且暂停任务不会消耗重试次数", async (t) => {
  const store = await fixture(t);
  store.setScopedPause({
    type: "contact",
    value: "u1",
    paused: true,
    actor: "operator",
    reason: "人工接管",
  });
  assert.equal(store.isScopedPaused("contact", "u1"), true);
  assert.equal(store.listScopedPauses()[0].value, "u1");
  const raw = store.db.prepare(
    "SELECT key, value FROM checkpoints WHERE key LIKE 'scoped_pause:%'",
  ).get();
  assert.doesNotMatch(`${raw.key}${raw.value}`, /人工接管|\bu1\b/u);
  const taskId = enqueueForScopeTest(store);
  const claimed = store.claimTask({ now: new Date("2026-07-31T10:00:00.020Z") });
  assert.equal(claimed.id, taskId);
  assert.equal(claimed.attempts, 1);
  store.deferTaskForPause(taskId, 1_000, new Date("2026-07-31T10:00:00.020Z"));
  assert.equal(store.getTask(taskId).status, "queued");
  assert.equal(store.getTask(taskId).attempts, 0);
  store.setScopedPause({
    type: "contact",
    value: "u1",
    paused: false,
    actor: "operator",
  });
  assert.equal(store.isScopedPaused("contact", "u1"), false);
});

function enqueueForScopeTest(store) {
  const at = new Date("2026-07-31T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), at);
  return store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(at.getTime() + 10),
  })[0];
}

test("同一会话中相隔过久的消息会拆成不同任务", async (t) => {
  const store = await fixture(t);
  const receivedAt = new Date("2026-07-31T10:10:01.000Z");
  store.ingestMessages(
    [
      messages()[0],
      {
        ...messages()[1],
        createTime: "2026-07-31T10:10:00.000Z",
      },
    ],
    receivedAt,
  );
  const taskIds = store.createReadyTasks({
    quietWindowMs: 1,
    bundleGapMs: 120_000,
    maxMessagesPerTask: 20,
    now: new Date(receivedAt.getTime() + 10),
  });
  assert.equal(taskIds.length, 2);
  assert.deepEqual(
    taskIds.map((taskId) => store.getTask(taskId).payload.messages.length),
    [1, 1],
  );
});

test("待审批草稿超过期限后失效", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  const taskId = (() => {
    store.ingestMessages(messages().slice(0, 1), base);
    return store.createReadyTasks({
      quietWindowMs: 1,
      now: new Date(base.getTime() + 10),
    })[0];
  })();
  store.claimTask({ now: new Date(base.getTime() + 10) });
  store.completeDraft(
    taskId,
    {
      shouldReply: true,
      reply: "我先看一下。",
      confidence: 0.9,
      riskLevel: "low",
      reason: "需要回复",
    },
    new Date(base.getTime() + 20),
  );
  assert.equal(
    store.expireAwaitingDrafts({
      before: new Date(base.getTime() + 21),
      now: new Date(base.getTime() + 30),
    }),
    1,
  );
  assert.equal(store.getTask(taskId).status, "expired");
});

test("同一私聊两分钟内的后续任务会让未发送旧草稿和旧审批失效", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-17T10:00:00.000Z");
  ingestSingle(store, { id: "episode-first", at: base, content: "我先说第一点" });
  const [firstId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  store.claimTask({ now: new Date(base.getTime() + 20) });
  store.completeDraft(firstId, {
    shouldReply: true,
    reply: "先按第一点回复。",
    confidence: 0.8,
    riskLevel: "low",
    reason: "需要回复",
  }, new Date(base.getTime() + 30), { supersedeWindowMs: 120_000 });
  assert.equal(store.getTask(firstId).status, "awaiting_approval");
  const manifest = {
    version: 1,
    projectId: "episode-project",
    name: "连续会话项目",
    rootDirectory: "/workspace/episode",
    requesters: ["u1"],
    capabilities: { research: { mode: "automatic" } },
  };
  const oldPlan = store.registerWorkPlan(assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "u1",
      sourceTaskId: firstId,
      objective: "处理第一点",
      steps: [{
        id: "research",
        capability: "research",
        description: "核对第一点",
        expectedEvidence: "事实",
      }],
    },
  }));
  assert.equal(oldPlan.status, "ready");

  const followupAt = new Date(base.getTime() + 60_000);
  ingestSingle(store, { id: "episode-followup", at: followupAt, content: "还有第二点" });
  const [followupId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(followupAt.getTime() + 10),
  });
  store.claimTask({ now: new Date(followupAt.getTime() + 20) });
  const completion = store.completeDraft(followupId, {
    shouldReply: true,
    reply: "我把两点合在一起回复。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "连续会话需要合并",
  }, new Date(followupAt.getTime() + 30), { supersedeWindowMs: 120_000 });
  assert.deepEqual(completion, { status: "awaiting_approval", supersededTaskIds: [firstId] });
  assert.equal(store.getTask(firstId).status, "expired");
  assert.equal(store.getTask(followupId).status, "awaiting_approval");
  assert.equal(store.getWorkPlan(oldPlan.id).status, "cancelled");
  assert.throws(
    () => store.decideTask(firstId, { decision: "approved", actor: "tester" }),
    /not awaiting approval/u,
  );
});

test("同一私聊草稿并发倒序完成时仍只保留最新任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-17T11:00:00.000Z");
  ingestSingle(store, { id: "concurrent-first", at: base, content: "第一句" });
  const [firstId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  assert.equal(store.claimTask({ now: new Date(base.getTime() + 20) }).id, firstId);
  const followupAt = new Date(base.getTime() + 30_000);
  ingestSingle(store, { id: "concurrent-followup", at: followupAt, content: "第二句" });
  const [followupId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(followupAt.getTime() + 10),
  });
  assert.equal(store.claimTask({ now: new Date(followupAt.getTime() + 20) }).id, followupId);
  store.completeDraft(followupId, {
    shouldReply: true,
    reply: "合并后的新草稿",
    confidence: 0.9,
    riskLevel: "low",
    reason: "结合两句",
  }, new Date(followupAt.getTime() + 30), { supersedeWindowMs: 120_000 });
  const olderCompletion = store.completeDraft(firstId, {
    shouldReply: true,
    reply: "已经过时的旧草稿",
    confidence: 0.8,
    riskLevel: "low",
    reason: "只看见第一句",
  }, new Date(followupAt.getTime() + 40), { supersedeWindowMs: 120_000 });
  assert.equal(olderCompletion.status, "expired");
  assert.equal(store.getTask(firstId).status, "expired");
  assert.equal(store.getTask(followupId).status, "awaiting_approval");
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
  assert.equal(
    store.dismissDeadTask(taskId, "operator", "不再重试"),
    "cancelled_operator",
  );
  assert.equal(store.getTask(taskId).status, "cancelled_operator");
  assert.throws(
    () => store.dismissDeadTask(taskId, "operator"),
    /Only dead tasks/u,
  );
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

test("SQLite 移动审批在事务内绑定当前完整草稿哈希", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  store.claimTask({ now: new Date(base.getTime() + 10) });
  store.completeDraft(taskId, {
    shouldReply: true, reply: "当前草稿", confidence: 0.8, riskLevel: "medium", reason: "需要审批",
  });
  assert.throws(() => store.decideTask(taskId, {
    decision: "approved", actor: "dingtalk-mobile", expectedDraftSha256: draftSha256("旧草稿"),
  }), /draft changed/u);
  assert.equal(store.getTask(taskId).status, "awaiting_approval");
  assert.equal(store.decideTask(taskId, {
    decision: "approved", actor: "dingtalk-mobile", expectedDraftSha256: draftSha256("当前草稿"),
  }), "approved");
});

test("非发送态不能创建副作用且缺失账本不能确认完成", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  assert.throws(
    () => store.beginSideEffect(taskId, "send_message", base),
    /Task is not sending/u,
  );
  store.claimTask({ now: new Date(base.getTime() + 20) });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  }, new Date(base.getTime() + 20));
  store.decideTask(taskId, {
    decision: "approved",
    actor: "tester",
  }, new Date(base.getTime() + 30));
  store.claimApprovedTask({ now: new Date(base.getTime() + 30) });
  assert.throws(
    () => store.completeSideEffect(
      taskId,
      "send_message",
      { success: true },
      new Date(base.getTime() + 40),
    ),
    /Side effect was not started/u,
  );
  assert.equal(store.getTask(taskId).status, "sending");
});

function sendClarification(store, taskId, now) {
  store.claimTask({ now });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "请补充目标上线日期。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "缺少决定方案范围的必要信息",
    needsInformation: true,
    relatedToWaitingTask: false,
    workRequest: null,
  }, now);
  store.decideTask(
    taskId,
    { decision: "approved", actor: "tester" },
    now,
  );
  store.claimApprovedTask({ now });
  store.beginSideEffect(taskId, "send_message", now);
  store.completeSideEffect(taskId, "send_message", { success: true }, now);
}

function ingestSingle(store, { id, at, content = "下周一上线" }) {
  store.ingestMessages([{
    id,
    senderUserId: "u1",
    senderName: "测试用户",
    conversationId: "c1",
    createTime: at.toISOString(),
    content,
  }], at);
}

test("澄清问题发送成功后等待同会话补充并继续原任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, { id: "wait-parent", at: base, content: "帮我做上线方案" });
  const [parentId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  const waitingAt = new Date(base.getTime() + 20);
  sendClarification(store, parentId, waitingAt);
  assert.equal(store.getTask(parentId).status, "waiting_information");
  assert.equal(store.getTask(parentId).waiting_information_at, waitingAt.toISOString());

  const answerAt = new Date(base.getTime() + 1_000);
  ingestSingle(store, { id: "wait-answer", at: answerAt });
  const [childId] = store.createReadyTasks({
    quietWindowMs: 1,
    waitingInformationTtlMs: 60_000,
    now: new Date(answerAt.getTime() + 10),
  });
  const child = store.getTask(childId);
  assert.equal(child.continuation_of_task_id, parentId);
  assert.equal(child.payload.waitingTask.clarificationQuestion, "请补充目标上线日期。");
  assert.equal(store.getTask(parentId).status, "continuation_pending");
  assert.equal(store.getTask(parentId).waiting_information_at, waitingAt.toISOString());

  store.claimTask({ now: new Date(answerAt.getTime() + 20) });
  store.completeDraft(childId, {
    shouldReply: true,
    reply: "收到，将按下周一上线规划。",
    confidence: 0.95,
    riskLevel: "medium",
    reason: "补充信息回答了原追问",
    needsInformation: false,
    relatedToWaitingTask: true,
    workRequest: {
      requested: true,
      objective: "制定下周一上线方案",
      projectHint: null,
    },
  }, new Date(answerAt.getTime() + 20));
  assert.equal(store.getTask(parentId).status, "continued");
  assert.equal(
    store.cancelDraftForManualReply(childId, new Date(answerAt.getTime() + 30)),
    true,
  );
  assert.equal(store.getTask(parentId).status, "cancelled_manual");
});

test("追问后的历史补录不冒充补充信息且不吞掉随后真实回答", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, {
    id: "boundary-parent",
    at: base,
    content: "帮我做上线方案",
  });
  const [parentId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 5),
  });
  const waitingAt = new Date(base.getTime() + 20_000);
  sendClarification(store, parentId, waitingAt);

  const historicalAt = new Date(base.getTime() + 10_000);
  const answerAt = new Date(base.getTime() + 30_000);
  store.ingestMessages([
    {
      id: "boundary-old-backfill",
      senderUserId: "u1",
      senderName: "测试用户",
      conversationId: "c1",
      createTime: historicalAt.toISOString(),
      content: "这是追问前遗漏的历史消息",
    },
    {
      id: "boundary-real-answer",
      senderUserId: "u1",
      senderName: "测试用户",
      conversationId: "c1",
      createTime: answerAt.toISOString(),
      content: "下周一上线",
    },
  ], new Date(base.getTime() + 40_000));
  const created = store.createReadyTasks({
    quietWindowMs: 1,
    bundleGapMs: 120_000,
    now: new Date(base.getTime() + 40_010),
  });
  assert.equal(created.length, 2);
  const tasks = created.map((id) => store.getTask(id));
  const oldTask = tasks.find((task) =>
    task.payload.messageIds.includes("boundary-old-backfill"));
  const answerTask = tasks.find((task) =>
    task.payload.messageIds.includes("boundary-real-answer"));
  assert.equal(oldTask.continuation_of_task_id, null);
  assert.equal(oldTask.payload.waitingTask, null);
  assert.equal(answerTask.continuation_of_task_id, parentId);
  assert.equal(
    answerTask.payload.waitingTask.clarificationQuestion,
    "请补充目标上线日期。",
  );
  assert.equal(store.getTask(parentId).status, "continuation_pending");
});

test("追问发送结果人工确认成功后进入等待信息", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, { id: "unknown-clarification", at: base, content: "帮我上线" });
  const [taskId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  store.claimTask({ now: new Date(base.getTime() + 20) });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "请补充上线日期。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "缺少必要信息",
    needsInformation: true,
    relatedToWaitingTask: false,
    workRequest: null,
  }, new Date(base.getTime() + 20));
  store.decideTask(taskId, { decision: "approved", actor: "tester" }, new Date(base.getTime() + 30));
  store.claimApprovedTask({ now: new Date(base.getTime() + 30) });
  store.beginSideEffect(taskId, "send_message", new Date(base.getTime() + 30));
  store.markSideEffectUnknown(taskId, "send_message", new Error("unknown"), new Date(base.getTime() + 40));
  assert.equal(store.getTask(taskId).status, "send_unknown");
  const confirmedAt = new Date(base.getTime() + 50);
  store.resolveUnknownSend(taskId, "sent", "operator", confirmedAt);
  assert.equal(store.getTask(taskId).status, "waiting_information");
  assert.equal(
    store.getTask(taskId).waiting_information_at,
    new Date(base.getTime() + 30).toISOString(),
  );
  const answerAt = new Date(base.getTime() + 45);
  ingestSingle(store, {
    id: "unknown-answer-before-confirmation",
    at: answerAt,
    content: "下周一",
  });
  const [childId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 60),
  });
  assert.equal(store.getTask(childId).continuation_of_task_id, taskId);
});

test("首条补充处理中后续消息保持待处理并在链路释放后关联", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, { id: "serial-parent", at: base, content: "帮我做上线方案" });
  const [parentId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  sendClarification(store, parentId, new Date(base.getTime() + 20));
  const firstAt = new Date(base.getTime() + 1_000);
  ingestSingle(store, { id: "serial-first", at: firstAt, content: "周五" });
  const [firstChildId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(firstAt.getTime() + 10),
  });

  const secondAt = new Date(base.getTime() + 2_000);
  ingestSingle(store, { id: "serial-second", at: secondAt, content: "改成下周一" });
  assert.deepEqual(store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(secondAt.getTime() + 10),
  }), []);
  assert.equal(store.getTask(parentId).status, "continuation_pending");
  assert.equal(
    store.nextPendingBundleAt({
      quietWindowMs: 1,
      now: new Date(secondAt.getTime() + 10),
    }).toISOString(),
    new Date(secondAt.getTime() + 1_010).toISOString(),
  );

  store.claimTask({ now: new Date(secondAt.getTime() + 20) });
  store.completeDraft(firstChildId, {
    shouldReply: false,
    reply: "",
    confidence: 0.8,
    riskLevel: "low",
    reason: "第一条不是最终补充",
    needsInformation: false,
    relatedToWaitingTask: false,
    workRequest: null,
  }, new Date(secondAt.getTime() + 20));
  const [secondChildId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(secondAt.getTime() + 30),
  });
  assert.equal(store.getTask(secondChildId).continuation_of_task_id, parentId);
  assert.deepEqual(store.getTask(secondChildId).payload.messageIds, ["serial-second"]);
});

test("同一次合并扫描只预留一条等待链补充", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, { id: "same-sweep-parent", at: base, content: "帮我做上线方案" });
  const [parentId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  sendClarification(store, parentId, new Date(base.getTime() + 20));
  const firstAt = new Date(base.getTime() + 1_000);
  ingestSingle(store, { id: "same-sweep-first", at: firstAt, content: "周五" });
  ingestSingle(store, {
    id: "same-sweep-second",
    at: new Date(firstAt.getTime() + 1),
    content: "更正为下周一",
  });
  const created = store.createReadyTasks({
    quietWindowMs: 1,
    maxMessagesPerTask: 1,
    now: new Date(firstAt.getTime() + 10),
  });
  assert.equal(created.length, 1);
  assert.equal(store.getTask(created[0]).continuation_of_task_id, parentId);
  assert.equal(
    store.db.prepare("SELECT status FROM messages WHERE id = ?").get("same-sweep-second").status,
    "pending",
  );
  store.claimTask({ now: new Date(firstAt.getTime() + 20) });
  store.completeDraft(created[0], {
    shouldReply: false,
    reply: "",
    confidence: 0.9,
    riskLevel: "low",
    reason: "第一段属于补充信息",
    needsInformation: false,
    relatedToWaitingTask: true,
    workRequest: null,
  }, new Date(firstAt.getTime() + 20));
  assert.equal(store.getTask(parentId).status, "waiting_information");
  const [secondChildId] = store.createReadyTasks({
    quietWindowMs: 1,
    maxMessagesPerTask: 1,
    now: new Date(firstAt.getTime() + 30),
  });
  assert.equal(store.getTask(secondChildId).continuation_of_task_id, parentId);
  assert.deepEqual(
    store.getTask(secondChildId).payload.messageIds,
    ["same-sweep-second"],
  );
});

test("无关消息恢复原等待；多个等待任务时不自动关联", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, { id: "ambiguous-parent", at: base, content: "帮我做上线方案" });
  const [parentId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  sendClarification(store, parentId, new Date(base.getTime() + 20));

  const unrelatedAt = new Date(base.getTime() + 1_000);
  ingestSingle(store, { id: "unrelated-question", at: unrelatedAt, content: "另外预算是多少？" });
  const [secondId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(unrelatedAt.getTime() + 10) });
  store.claimTask({ now: new Date(unrelatedAt.getTime() + 20) });
  store.completeDraft(secondId, {
    shouldReply: true,
    reply: "请补充预算范围。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "这是独立问题且缺少预算范围",
    needsInformation: true,
    relatedToWaitingTask: false,
    workRequest: null,
  }, new Date(unrelatedAt.getTime() + 20));
  assert.equal(store.getTask(parentId).status, "waiting_information");
  store.decideTask(secondId, { decision: "approved", actor: "tester" }, new Date(unrelatedAt.getTime() + 30));
  store.claimApprovedTask({ now: new Date(unrelatedAt.getTime() + 30) });
  store.beginSideEffect(secondId, "send_message", new Date(unrelatedAt.getTime() + 30));
  store.completeSideEffect(secondId, "send_message", { success: true }, new Date(unrelatedAt.getTime() + 30));

  const nextAt = new Date(base.getTime() + 2_000);
  ingestSingle(store, { id: "ambiguous-answer", at: nextAt, content: "100 万" });
  const [thirdId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(nextAt.getTime() + 10) });
  assert.equal(store.getTask(thirdId).continuation_of_task_id, null);
  assert.equal(store.getTask(thirdId).payload.waitingTask, null);
  assert.equal(store.getTask(parentId).status, "waiting_information");
  assert.equal(store.getTask(secondId).status, "waiting_information");
});

test("等待超时后原任务过期且新消息不关联", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, { id: "expired-parent", at: base, content: "帮我做上线方案" });
  const [parentId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  sendClarification(store, parentId, new Date(base.getTime() + 20));
  const lateAt = new Date(base.getTime() + 61_000);
  ingestSingle(store, { id: "late-answer", at: lateAt });
  const [childId] = store.createReadyTasks({
    quietWindowMs: 1,
    waitingInformationTtlMs: 60_000,
    now: new Date(lateAt.getTime() + 10),
  });
  assert.equal(store.getTask(parentId).status, "expired");
  assert.equal(store.getTask(childId).continuation_of_task_id, null);
});

test("补充消息处理死亡时恢复原等待任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, { id: "failure-parent", at: base, content: "帮我做上线方案" });
  const [parentId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  sendClarification(store, parentId, new Date(base.getTime() + 20));
  const answerAt = new Date(base.getTime() + 1_000);
  ingestSingle(store, { id: "failure-answer", at: answerAt });
  const [childId] = store.createReadyTasks({
    quietWindowMs: 1,
    maxAttempts: 1,
    now: new Date(answerAt.getTime() + 10),
  });
  store.claimTask({ now: new Date(answerAt.getTime() + 20) });
  assert.equal(store.failTask(childId, new Error("permanent"), new Date(answerAt.getTime() + 20)), "dead");
  assert.equal(store.getTask(parentId).status, "waiting_information");
  store.retryTask(childId, new Date(answerAt.getTime() + 30));
  assert.equal(store.getTask(parentId).status, "continuation_pending");
  store.claimTask({ now: new Date(answerAt.getTime() + 40) });
  store.completeDraft(childId, {
    shouldReply: true,
    reply: "收到，继续处理。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "重试后确认是补充信息",
    needsInformation: false,
    relatedToWaitingTask: true,
    workRequest: null,
  }, new Date(answerAt.getTime() + 40));
  assert.equal(store.getTask(parentId).status, "continued");
});

test("后续消息处理前发现人工接管会关闭原等待任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, { id: "manual-parent", at: base, content: "帮我做上线方案" });
  const [parentId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  sendClarification(store, parentId, new Date(base.getTime() + 20));
  const answerAt = new Date(base.getTime() + 1_000);
  ingestSingle(store, { id: "manual-answer", at: answerAt });
  const [childId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(answerAt.getTime() + 10) });
  store.claimTask({ now: new Date(answerAt.getTime() + 20) });
  store.completeDraft(childId, {
    shouldReply: false,
    reply: "",
    confidence: 1,
    riskLevel: "low",
    reason: "负责人已经人工回复",
    needsInformation: false,
    relatedToWaitingTask: false,
    workRequest: null,
    decisionSource: "manual_reply_check",
    decisionKind: "manual_reply",
  }, new Date(answerAt.getTime() + 20));
  assert.equal(store.getTask(parentId).status, "cancelled_manual");
});

test("补充任务生成期间人工接管会释放 continuation_pending 父任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  ingestSingle(store, {
    id: "manual-processing-parent",
    at: base,
    content: "帮我做上线方案",
  });
  const [parentId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  sendClarification(store, parentId, new Date(base.getTime() + 20));
  const answerAt = new Date(base.getTime() + 1_000);
  ingestSingle(store, { id: "manual-processing-answer", at: answerAt });
  const [childId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(answerAt.getTime() + 10),
  });
  store.claimTask({ now: new Date(answerAt.getTime() + 20) });
  assert.equal(store.getTask(childId).status, "processing");
  assert.equal(store.getTask(parentId).status, "continuation_pending");
  assert.equal(
    store.cancelDraftForManualReply(childId, new Date(answerAt.getTime() + 30)),
    true,
  );
  assert.equal(store.getTask(parentId).status, "cancelled_manual");
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
  assert.equal(store.ingestMessages(messages().slice(0, 1), new Date("2021-01-02T00:00:00.000Z")), 0);
});

test("监听器和 Worker 并发启动时共享同一密钥和数据库", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-concurrent-test-"));
  const databasePath = join(directory, "shared.sqlite");
  const stores = Array.from({ length: 8 }, () => new Store(databasePath));
  const [first, second] = stores;
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all(stores.map((store) => store.open()));
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

test("记忆必须确认后才能检索，过期和撤销后立即失效", async (t) => {
  const store = await fixture(t);
  const proposed = store.proposeMemory(
    {
      type: "project",
      subject: "单词项目",
      projectId: "vocab_project",
      statement: "交付前必须核对实际批次覆盖。",
      sourceType: "document",
      sourceId: "doc-1",
      confidence: 0.9,
      createdBy: "tester",
    },
    new Date("2026-08-04T10:00:00.000Z"),
  );
  assert.equal(store.searchMemories({ query: "批次" }).length, 0);
  store.confirmMemory(proposed, "approver", new Date("2026-08-04T10:01:00.000Z"));
  assert.equal(store.searchMemories({ query: "批次" }).length, 1);
  store.revokeMemory(proposed, "approver", new Date("2026-08-04T10:02:00.000Z"));
  assert.equal(store.searchMemories({ query: "批次" }).length, 0);

  const expired = store.proposeMemory({
    type: "principle",
    subject: "交付原则",
    statement: "这是短期原则。",
    sourceType: "user_confirmation",
    sourceId: "chat-1",
    expiresAt: "2026-08-04T11:00:00.000Z",
    createdBy: "tester",
  });
  store.confirmMemory(expired, "approver");
  assert.equal(
    store.searchMemories({
      query: "短期",
      now: new Date("2026-08-04T12:00:00.000Z"),
    }).length,
    0,
  );
});

test("gbrain 记忆必须持有未过期来源访问租约", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-05T08:00:00.000Z");
  const id = store.proposeMemory({
    type: "knowledge",
    subject: "项目规则",
    projectId: "project_1",
    statement: "上线前必须复核。",
    sourceType: "gbrain",
    sourceId: "projects/one/rule",
    createdBy: "owner",
  }, now);
  assert.throws(
    () => store.confirmMemory(id, "owner", now),
    /source access must be verified/u,
  );
  store.setMemorySourceAccess(id, {
    status: "verified",
    reason: "exact_source_verified",
    checkedAt: now,
    expiresAt: new Date(now.getTime() + 900_000),
    sourceVersion: "live-v1",
  }, "system:memory-source", now);
  assert.equal(store.getMemory(id).source_version, "live-v1");
  store.setMemorySourceAccess(id, {
    status: "verified",
    reason: "authority_exact_content_rebound",
    checkedAt: new Date(now.getTime() + 1_000),
    expiresAt: new Date(now.getTime() + 900_000),
    sourceVersion: "live-v2",
  }, "system:memory-source", new Date(now.getTime() + 1_000));
  assert.equal(store.getMemory(id).source_version, "live-v2");
  store.confirmMemory(id, "owner", now);
  assert.equal(store.searchMemories({
    type: "knowledge",
    now: new Date(now.getTime() + 899_999),
  }).length, 1);
  assert.equal(store.searchMemories({
    type: "knowledge",
    now: new Date(now.getTime() + 900_000),
  }).length, 0);
  store.setMemorySourceAccess(id, {
    status: "unavailable",
    reason: "source_unavailable",
    checkedAt: new Date(now.getTime() + 900_000),
  }, "system:memory-source");
  assert.equal(store.getMemory(id).source_access_status, "unavailable");
});

test("新记忆确认时会撤销被替代的旧记忆", async (t) => {
  const store = await fixture(t);
  const oldId = store.proposeMemory({
    type: "principle",
    subject: "文档格式",
    statement: "使用旧格式。",
    sourceType: "user_confirmation",
    sourceId: "chat-old",
    createdBy: "tester",
  });
  store.confirmMemory(oldId, "approver");
  const newId = store.proposeMemory({
    type: "principle",
    subject: "文档格式",
    statement: "使用新格式。",
    sourceType: "user_confirmation",
    sourceId: "chat-new",
    supersedesId: oldId,
    createdBy: "tester",
  });
  store.confirmMemory(newId, "approver");
  assert.equal(store.listMemories({ status: "confirmed" }).length, 1);
  assert.equal(store.listMemories({ status: "revoked" })[0].id, oldId);
});

test("冲突记忆必须显式替代旧事实且重复候选不能确认", async (t) => {
  const store = await fixture(t);
  const base = {
    type: "project", subject: "发布口径", projectId: "p1",
    sourceType: "operator", sourceId: "source", createdBy: "owner",
    scope: { factKey: "release-rule" },
  };
  const oldId = store.proposeMemory({ ...base, statement: "旧口径" });
  store.confirmMemory(oldId, "owner");
  const duplicateId = store.proposeMemory({
    ...base, statement: "旧口径", sourceId: "duplicate",
  });
  assert.throws(() => store.confirmMemory(duplicateId, "owner"), /duplicates/u);
  const replacementId = store.proposeMemory({
    ...base, statement: "新口径", sourceId: "replacement",
  });
  assert.throws(() => store.confirmMemory(replacementId, "owner"), /supersedesId/u);
  store.confirmMemory(replacementId, "owner", new Date(), { supersedesId: oldId });
  const report = store.memoryConflictMetrics();
  assert.equal(report.activeConflictGroups, 0);
  assert.equal(report.conflictCandidates, 1);
});

test("记忆永久删除要求绑定确认值并擦除全部业务正文", async (t) => {
  const store = await fixture(t);
  const id = store.proposeMemory({
    type: "person",
    subject: "敏感联系人",
    statement: "不再保留的个人信息。",
    sourceType: "chat",
    sourceId: "private-chat-1",
    scope: { relation: "private" },
    createdBy: "owner",
    sensitivity: "confidential",
  });
  assert.throws(
    () => store.deleteMemory(id, "owner", "DELETE-WRONG"),
    /confirmation/u,
  );
  assert.equal(
    store.deleteMemory(id, "owner", memoryDeletionConfirmation(id)),
    "deleted",
  );
  assert.equal(store.listMemories({ limit: 100 }).length, 0);
  const row = store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id);
  assert.equal(row.deleted_at != null, true);
  assert.equal(store.cipher.decrypt(row.subject_ciphertext), "");
  assert.equal(store.cipher.decrypt(row.statement_ciphertext), "");
  assert.equal(store.cipher.decrypt(row.source_id_ciphertext), "");
  assert.deepEqual(JSON.parse(store.cipher.decrypt(row.scope_ciphertext)), {});
  assert.equal(row.project_id, null);
  assert.throws(
    () => store.deleteMemory(id, "owner", memoryDeletionConfirmation(id)),
    /cannot be deleted/u,
  );
});

test("按人隐私擦除绑定实时快照并清空任务、消息、记忆和人工标注", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-05T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  store.claimTask({ now: new Date(base.getTime() + 10) });
  let blocked = store.previewPrivacyErasure({ personId: "u1" }, new Date(base.getTime() + 20));
  assert.equal(blocked.confirmation, null);
  assert.equal(blocked.blocked.tasks, 1);
  store.completeDraft(taskId, {
    shouldReply: false,
    reply: "",
    confidence: 0.9,
    riskLevel: "low",
    reason: "无需回复",
  }, new Date(base.getTime() + 20));
  store.upsertDecisionReview(taskId, {
    expectedShouldReply: false,
    reviewer: "u1",
    note: "含个人信息的标注",
  }, new Date(base.getTime() + 30));
  const first = store.previewPrivacyErasure({ personId: "u1" }, new Date(base.getTime() + 40));
  assert.match(first.confirmation, /^ERASE-/u);
  assert.equal(JSON.stringify(first).includes("u1"), false);
  const memoryId = store.proposeMemory({
    type: "person",
    subject: "u1",
    statement: "个人敏感陈述",
    sourceType: "chat",
    sourceId: "private-message",
    createdBy: "u1",
  }, new Date(base.getTime() + 41));
  const derivedMemory = store.proposeMemoryCandidate({
    type: "principle",
    subject: "organization",
    statement: "消息中形成的协作原则",
    sourceType: "dingtalk_message",
    sourceId: "m1",
    sourceVersion: taskId,
    scope: { factKey: "collaboration.principle" },
    confidence: 0.9,
    sensitivity: "internal",
    expiresAt: new Date(base.getTime() + 86_400_000),
    createdBy: "system:memory-candidate",
  }, new Date(base.getTime() + 41));
  assert.throws(
    () => store.erasePrivacyData({ personId: "u1" }, first.confirmation, "operator", new Date(base.getTime() + 50)),
    /current snapshot/u,
  );
  const preview = store.previewPrivacyErasure({ personId: "u1" }, new Date(base.getTime() + 50));
  const result = store.erasePrivacyData(
    { personId: "u1" },
    preview.confirmation,
    "operator",
    new Date(base.getTime() + 50),
  );
  assert.equal(result.erased, true);
  assert.equal(store.getTask(taskId), null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
  assert.equal(store.ingestMessages(messages().slice(0, 1), new Date(base.getTime() + 60)), 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
  const rawTask = store.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  assert.ok(rawTask.privacy_erased_at);
  assert.deepEqual(JSON.parse(store.cipher.decrypt(rawTask.payload_json)), {});
  const rawMemory = store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(memoryId);
  assert.ok(rawMemory.deleted_at);
  assert.equal(store.cipher.decrypt(rawMemory.statement_ciphertext), "");
  assert.ok(store.db.prepare(
    "SELECT deleted_at FROM memory_items WHERE id = ?",
  ).get(derivedMemory.id).deleted_at);
  const review = store.db.prepare("SELECT * FROM decision_reviews WHERE task_id = ?").get(taskId);
  assert.equal(review, undefined);
  assert.equal(store.previewPrivacyErasure({ personId: "u1" }).eligibleTotal, 0);
});

test("按项目擦除覆盖计划、来源任务和项目记忆但不接受活动计划", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-05T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  store.claimTask({ now: new Date(base.getTime() + 10) });
  store.completeDraft(taskId, {
    shouldReply: false, reply: "", confidence: 0.9, riskLevel: "low", reason: "无需回复",
  }, new Date(base.getTime() + 20));
  const manifest = {
    version: 1,
    projectId: "privacy_project",
    name: "隐私测试",
    rootDirectory: "/workspace/privacy",
    requesters: ["u1"],
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = store.registerWorkPlan(assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: "privacy_project",
      requesterId: "u1",
      sourceTaskId: taskId,
      objective: "项目敏感目标",
      steps: [{ id: "research", capability: "research", description: "研究", expectedEvidence: "结论" }],
    },
  }), new Date(base.getTime() + 30));
  assert.equal(store.previewPrivacyErasure({ projectId: "privacy_project" }).blocked.workPlans, 1);
  store.requestWorkPlanCancellation(plan.id, "operator", new Date(base.getTime() + 40));
  store.appendGraphProjection(
    graphFixture("tenant-sqlite", "privacy_project"),
    new Date(base.getTime() + 40),
  );
  const memoryId = store.proposeMemory({
    type: "project",
    subject: "项目口径",
    projectId: "privacy_project",
    statement: "项目敏感陈述",
    sourceType: "operator",
    sourceId: "source",
    createdBy: "operator",
  }, new Date(base.getTime() + 41));
  store.db.prepare(
    `INSERT INTO capability_budget_usage(
       project_key, project_id_ciphertext, authorization_hash, capability,
       limit_count, used_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    store.cipher.fingerprint("privacy_project"),
    store.cipher.encrypt("privacy_project"),
    "a".repeat(64),
    "research",
    1,
    1,
    new Date(base.getTime() + 42).toISOString(),
    new Date(base.getTime() + 42).toISOString(),
  );
  const preview = store.previewPrivacyErasure({ projectId: "privacy_project" }, new Date(base.getTime() + 50));
  assert.equal(preview.counts.tasks, 1);
  assert.equal(preview.counts.workPlans, 1);
  assert.equal(preview.counts.memories, 1);
  assert.equal(preview.counts.capabilityBudgets, 1);
  assert.equal(preview.counts.graphNodes, 2);
  assert.equal(preview.counts.graphEdges, 1);
  store.erasePrivacyData(
    { projectId: "privacy_project" }, preview.confirmation, "operator", new Date(base.getTime() + 50),
  );
  assert.equal(store.getWorkPlan(plan.id), null);
  assert.equal(store.getTask(taskId), null);
  const rawPlan = store.db.prepare("SELECT * FROM work_plans WHERE id = ?").get(plan.id);
  assert.equal(rawPlan.project_id, "deleted");
  assert.deepEqual(JSON.parse(store.cipher.decrypt(rawPlan.plan_ciphertext)), {});
  assert.ok(store.db.prepare("SELECT deleted_at FROM memory_items WHERE id = ?").get(memoryId).deleted_at);
  const retainedBudget = store.db.prepare(
    "SELECT * FROM capability_budget_usage",
  ).get();
  assert.equal(store.cipher.decrypt(retainedBudget.project_id_ciphertext), "");
  assert.equal(retainedBudget.used_count, 1);
  assert.equal(store.listGraphNodes({
    tenantId: "tenant-sqlite", projectId: "privacy_project",
  }).length, 0);
  assert.equal(store.listGraphEdges({
    tenantId: "tenant-sqlite", projectId: "privacy_project",
  }).length, 0);
  assert.throws(
    () => store.registerWorkPlan(assessWorkPlan({
      manifest,
      plan: {
        version: 1,
        projectId: "privacy_project",
        requesterId: "u1",
        sourceTaskId: taskId,
        objective: "项目敏感目标",
        steps: [{ id: "research", capability: "research", description: "研究", expectedEvidence: "结论" }],
      },
    })),
    /source task is no longer actionable|cannot be recreated/u,
  );
});

test("时间擦除遇到未归档消息或仍生效的暂停范围会整体阻止", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-01T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  store.setScopedPause({
    type: "contact", value: "u1", paused: true, actor: "operator", reason: "处理中",
  }, base);
  const preview = store.previewPrivacyErasure(
    { before: "2026-08-02T00:00:00.000Z" },
    new Date("2026-08-05T00:00:00.000Z"),
  );
  assert.equal(preview.confirmation, null);
  assert.equal(preview.blocked.messages, 1);
  assert.equal(preview.blocked.scopedPauses, 1);
});

test("按时间擦除不会重置安全能力预算", async (t) => {
  const store = await fixture(t);
  const old = new Date("2026-08-01T10:00:00.000Z");
  store.proposeMemory({
    type: "principle",
    subject: "organization",
    statement: "已过期的临时口径",
    sourceType: "operator",
    sourceId: "old-source",
    createdBy: "operator",
  }, old);
  store.db.prepare(
    `INSERT INTO capability_budget_usage(
       project_key, project_id_ciphertext, authorization_hash, capability,
       limit_count, used_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
  ).run(
    store.cipher.fingerprint("retained_budget_project"),
    store.cipher.encrypt("retained_budget_project"),
    "b".repeat(64),
    "research",
    old.toISOString(),
    old.toISOString(),
  );
  const now = new Date("2026-08-05T00:00:00.000Z");
  const preview = store.previewPrivacyErasure(
    { before: "2026-08-02T00:00:00.000Z" },
    now,
  );
  assert.equal(preview.counts.capabilityBudgets, 0);
  store.erasePrivacyData(
    { before: "2026-08-02T00:00:00.000Z" },
    preview.confirmation,
    "operator",
    now,
  );
  const retained = store.db.prepare(
    "SELECT used_count FROM capability_budget_usage",
  ).get();
  assert.equal(retained.used_count, 1);
});

function assessedPlan(description = "形成代码补丁") {
  const manifest = {
    version: 1,
    projectId: "test_project",
    name: "测试项目",
    rootDirectory: "/workspace/project",
    requesters: ["user-1"],
    capabilities: { code_patch: { mode: "approval_required" } },
  };
  return assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: "test_project",
      requesterId: "user-1",
      objective: "完成修改",
      steps: [
        {
          id: "code",
          capability: "code_patch",
          description,
          workingDirectory: "/workspace/project",
          expectedEvidence: "代码差异",
        },
      ],
    },
  });
}

async function legacyWorkPlanDatabase(
  t,
  statuses,
  { removeCapabilitySchema = false } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ai-employee-legacy-plan-"));
  const databasePath = join(directory, "legacy.sqlite");
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const seed = await new Store(databasePath).open();
  stores.push(seed);
  const assessments = statuses.map((status, index) =>
    assessedPlan(`018 旧计划 ${status} ${index}`));
  const plans = assessments.map((assessment) => seed.registerWorkPlan(assessment));
  const seedNow = new Date("2026-08-10T08:00:00.000Z");
  statuses.forEach((status, index) => {
    if (["approved", "executing", "verifying"].includes(status)) {
      seed.decideWorkPlan(plans[index].id, {
        decision: "approved",
        actor: "legacy-approver",
      }, seedNow);
    }
    if (["executing", "verifying"].includes(status)) {
      seed.consumeWorkPlanAuthorization(
        plans[index].id,
        new Date(seedNow.getTime() + 1_000),
      );
    }
    if (seed.getWorkPlan(plans[index].id).status !== status) {
      seed.db.prepare(
        "UPDATE work_plans SET status = ? WHERE id = ?",
      ).run(status, plans[index].id);
    }
  });
  seed.close();

  const legacyDb = new DatabaseSync(databasePath);
  try {
    legacyDb.exec(`
      DROP TRIGGER IF EXISTS work_plans_capability_budget_insert_guard;
      DROP TRIGGER IF EXISTS work_plans_capability_budget_update_guard;
    `);
    if (removeCapabilitySchema) {
      legacyDb.exec(`
        DROP TABLE capability_budget_usage;
        ALTER TABLE work_plans DROP COLUMN capability_budget_ciphertext;
        ALTER TABLE work_plans DROP COLUMN authorization_hash;
      `);
    } else {
      legacyDb.exec(`
        UPDATE work_plans
        SET authorization_hash = NULL, capability_budget_ciphertext = NULL;
      `);
    }
  } finally {
    legacyDb.close();
  }
  return {
    assessments,
    databasePath,
    plans,
    createStore() {
      const store = new Store(databasePath);
      stores.push(store);
      return store;
    },
  };
}

test("SQLite 018 会取消缺少预算绑定的未执行旧计划并允许重新登记", async (t) => {
  const legacy = await legacyWorkPlanDatabase(t, [
    "ready",
    "awaiting_approval",
    "approved",
  ]);
  const store = await legacy.createStore().open();

  for (const plan of legacy.plans) {
    const migrated = store.getWorkPlan(plan.id);
    assert.equal(migrated.status, "cancelled");
    assert.equal(migrated.authorization_hash, null);
    assert.equal(migrated.capability_budget, null);
    assert.ok(migrated.cancel_requested_at);
    assert.equal(migrated.cancel_requested_by, "system:migration-018");
    const [step] = store.listWorkPlanSteps(plan.id);
    assert.equal(step.status, "cancelled");
    assert.ok(step.completed_at);
    assert.match(step.error, /system:migration-018/u);
  }

  const restoredAt = new Date("2026-08-10T10:00:00.000Z");
  const restoredIndex = 2;
  const restored = store.registerWorkPlan(
    legacy.assessments[restoredIndex],
    restoredAt,
  );
  assert.equal(restored.id, legacy.plans[restoredIndex].id);
  assert.equal(restored.status, "awaiting_approval");
  assert.equal(
    restored.authorization_hash,
    legacy.assessments[restoredIndex].authorizationHash,
  );
  assert.deepEqual(
    restored.capability_budget,
    legacy.assessments[restoredIndex].capabilityBudget,
  );
  assert.equal(restored.approval_version, 2);
  assert.equal(restored.cancel_requested_at, null);
  assert.equal(restored.cancel_requested_by, null);
  const [restoredStep] = store.listWorkPlanSteps(restored.id);
  assert.equal(restoredStep.status, "pending");
  assert.equal(restoredStep.completed_at, null);
  assert.equal(restoredStep.error, null);

  store.decideWorkPlan(restored.id, {
    decision: "approved",
    actor: "approver",
  }, new Date(restoredAt.getTime() + 1_000));
  assert.equal(
    store.consumeWorkPlanAuthorization(
      restored.id,
      new Date(restoredAt.getTime() + 2_000),
    ),
    true,
  );
  assert.equal(store.isWorkPlanCancellationRequested(restored.id), false);
});

test("SQLite 018 数据库门禁拒绝旧执行器写入无预算可执行计划", async (t) => {
  const legacy = await legacyWorkPlanDatabase(t, ["ready"]);
  const store = await legacy.createStore().open();
  const migrated = store.getWorkPlan(legacy.plans[0].id);
  assert.equal(migrated.status, "cancelled");
  assert.equal(migrated.authorization_hash, null);
  assert.equal(migrated.capability_budget, null);
  store.close();

  const timestamp = "2026-08-10T10:00:00.000Z";
  const oldExecutor = new DatabaseSync(legacy.databasePath);
  try {
    const insert = oldExecutor.prepare(
      `INSERT INTO work_plans(
         id, project_id, requester_key, requester_ciphertext,
         objective_ciphertext, plan_ciphertext, plan_hash, max_level,
         policy_decision, status, created_at, updated_at
       ) VALUES (?, 'project', 'requester', 'ciphertext', 'ciphertext',
         'ciphertext', ?, 'L1', 'ALLOW', ?, ?, ?)`,
    );
    assert.throws(
      () => insert.run(
        "old-executor-insert",
        "old-executor-insert-hash",
        "ready",
        timestamp,
        timestamp,
      ),
      /capability budget authorization is required/u,
    );

    insert.run(
      "historical-cancelled",
      "historical-cancelled-hash",
      "cancelled",
      timestamp,
      timestamp,
    );
    assert.throws(
      () => oldExecutor.prepare(
        "UPDATE work_plans SET status = 'approved' WHERE id = ?",
      ).run("historical-cancelled"),
      /capability budget authorization is required/u,
    );
    assert.equal(
      oldExecutor.prepare(
        "SELECT status FROM work_plans WHERE id = 'historical-cancelled'",
      ).get().status,
      "cancelled",
    );
  } finally {
    oldExecutor.close();
  }
});

test("SQLite 018 遇到缺少预算绑定的执行中旧计划时整体回滚", async (t) => {
  const legacy = await legacyWorkPlanDatabase(
    t,
    ["executing", "verifying"],
    { removeCapabilitySchema: true },
  );
  const store = legacy.createStore();
  await assert.rejects(
    store.open(),
    /legacy work plans are executing/u,
  );
  assert.equal(store.db, null);

  const raw = new DatabaseSync(legacy.databasePath);
  try {
    const columns = new Set(
      raw.prepare("PRAGMA table_info(work_plans)").all().map((row) => row.name),
    );
    assert.equal(columns.has("authorization_hash"), false);
    assert.equal(columns.has("capability_budget_ciphertext"), false);
    assert.equal(
      raw.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'capability_budget_usage'`,
      ).get().count,
      0,
    );
    assert.deepEqual(
      raw.prepare(
        "SELECT status FROM work_plans ORDER BY status",
      ).all().map((row) => row.status),
      ["executing", "verifying"],
    );
    assert.equal(
      raw.prepare(
        "SELECT COUNT(*) AS count FROM work_plan_steps WHERE status = 'pending'",
      ).get().count,
      2,
    );
  } finally {
    raw.close();
  }
});

test("任务计划审批绑定哈希、有效期和单次消费", async (t) => {
  const store = await fixture(t);
  const registered = store.registerWorkPlan(
    assessedPlan(),
    new Date("2026-08-04T10:00:00.000Z"),
  );
  assert.equal(registered.status, "awaiting_approval");
  assert.equal(store.listWorkPlans({ status: "awaiting_approval" })[0].id, registered.id);
  store.decideWorkPlan(
    registered.id,
    {
      decision: "approved",
      actor: "approver",
      expiresAt: "2026-08-04T12:00:00.000Z",
    },
    new Date("2026-08-04T10:01:00.000Z"),
  );
  assert.equal(
    store.consumeWorkPlanAuthorization(
      registered.id,
      new Date("2026-08-04T11:00:00.000Z"),
    ),
    true,
  );
  assert.equal(store.listWorkPlans({ status: "executing" })[0].id, registered.id);
  assert.throws(
    () =>
      store.consumeWorkPlanAuthorization(
        registered.id,
        new Date("2026-08-04T11:01:00.000Z"),
      ),
    /not authorized/u,
  );
});

test("SQLite 项目工作历史在存储层绑定项目、时间窗口和当前计划", async (t) => {
  const store = await fixture(t);
  const complete = (assessment, hour) => {
    const registered = store.registerWorkPlan(
      assessment,
      new Date(`2026-08-13T0${hour}:00:00.000Z`),
    );
    store.decideWorkPlan(registered.id, {
      decision: "approved",
      actor: "owner",
      expiresAt: "2026-08-13T12:00:00.000Z",
    }, new Date(`2026-08-13T0${hour}:01:00.000Z`));
    store.consumeWorkPlanAuthorization(
      registered.id,
      new Date(`2026-08-13T0${hour}:02:00.000Z`),
    );
    store.updateWorkPlanStep(registered.id, "code", {
      status: "completed",
      evidence: {
        kind: "unified_diff",
        sha256: "d".repeat(64),
        verification: "git_apply_check",
      },
    }, new Date(`2026-08-13T0${hour}:03:00.000Z`));
    store.finishWorkPlan(
      registered.id,
      { success: true },
      new Date(`2026-08-13T0${hour}:04:00.000Z`),
    );
    return registered;
  };
  const included = complete(assessedPlan("当日完成"), 1);
  const excluded = complete(assessedPlan("当前日报计划"), 2);
  const history = store.listProjectWorkHistory({
    projectId: "test_project",
    start: "2026-08-13T00:00:00.000Z",
    end: "2026-08-14T00:00:00.000Z",
    excludePlanHash: excluded.plan_hash,
    limit: 10,
  });
  assert.deepEqual(history.map((plan) => plan.id), [included.id]);
  assert.equal(history[0].steps[0].evidence.kind, "unified_diff");
  assert.deepEqual(store.listProjectWorkHistory({
    projectId: "other_project",
    start: "2026-08-13T00:00:00.000Z",
    end: "2026-08-14T00:00:00.000Z",
    limit: 10,
  }), []);
  assert.throws(
    () => store.listProjectWorkHistory({
      projectId: "test_project",
      start: "invalid",
      end: "2026-08-14T00:00:00.000Z",
    }),
    /query is invalid/u,
  );
});

test("计划变化会生成新任务且不能复用旧审批", async (t) => {
  const store = await fixture(t);
  const oldPlan = store.registerWorkPlan(assessedPlan("旧计划"));
  store.decideWorkPlan(oldPlan.id, {
    decision: "approved",
    actor: "approver",
  });
  const changed = store.registerWorkPlan(assessedPlan("新计划"));
  assert.notEqual(changed.id, oldPlan.id);
  assert.equal(changed.status, "awaiting_approval");
  assert.throws(
    () => store.consumeWorkPlanAuthorization(changed.id),
    /not authorized/u,
  );
});

test("计划修订产生新编号、废止旧计划并强制重新审批", async (t) => {
  const store = await fixture(t);
  const oldPlan = store.registerWorkPlan(assessedPlan("旧计划"));
  const revised = store.reviseWorkPlan(
    oldPlan.id,
    assessedPlan("修订后的计划"),
    "operator",
  );
  assert.notEqual(revised.id, oldPlan.id);
  assert.equal(revised.status, "awaiting_approval");
  assert.equal(revised.supersedes_work_plan_id, oldPlan.id);
  assert.equal(revised.revision_actor, "operator");
  assert.equal(store.getWorkPlan(oldPlan.id).status, "superseded");
  assert.throws(
    () => store.consumeWorkPlanAuthorization(oldPlan.id),
    /not authorized/u,
  );
  assert.throws(
    () => store.consumeWorkPlanAuthorization(revised.id),
    /not authorized/u,
  );
  store.decideWorkPlan(revised.id, {
    decision: "approved",
    actor: "approver",
  });
  assert.equal(store.consumeWorkPlanAuthorization(revised.id), true);
  assert.throws(
    () => store.reviseWorkPlan(oldPlan.id, assessedPlan("再次修订"), "operator"),
    /can no longer be revised/u,
  );
});

test("未执行计划可以按任务单独取消", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "cancel_project",
    name: "取消测试",
    rootDirectory: "/workspace/cancel",
    requesters: ["user-1"],
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = store.registerWorkPlan(assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: "cancel_project",
      requesterId: "user-1",
      objective: "稍后取消",
      steps: [{ id: "research", capability: "research", description: "研究", expectedEvidence: "结果" }],
    },
  }));
  assert.equal(store.requestWorkPlanCancellation(plan.id, "operator"), "cancelled");
  assert.equal(store.getWorkPlan(plan.id).status, "cancelled");
  assert.equal(store.listWorkPlanSteps(plan.id)[0].status, "cancelled");
  assert.equal(store.requestWorkPlanCancellation(plan.id, "operator"), "cancelled");
});

test("人工接管会取消未执行计划并请求安全停止执行中计划", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-10T08:00:00.000Z");
  const manifest = {
    version: 1,
    projectId: "manual_takeover_project",
    name: "人工接管测试",
    rootDirectory: "/workspace/manual-takeover",
    requesters: ["u1"],
    capabilities: { research: { mode: "automatic", maxRuns: 5 } },
  };
  const enqueueSourceTask = (suffix, offsetMs) => {
    const receivedAt = new Date(base.getTime() + offsetMs);
    store.ingestMessages([{
      ...messages()[0],
      id: `manual-takeover-${suffix}`,
      conversationId: `manual-takeover-${suffix}`,
      createTime: receivedAt.toISOString(),
      content: `请研究${suffix}`,
    }], receivedAt);
    const [taskId] = store.createReadyTasks({
      quietWindowMs: 1,
      now: new Date(receivedAt.getTime() + 10),
    });
    store.claimTask({ now: new Date(receivedAt.getTime() + 10) });
    store.completeDraft(taskId, {
      shouldReply: true,
      reply: "已形成执行计划。",
      confidence: 0.95,
      riskLevel: "low",
      reason: "识别为工作请求",
      decisionSource: "model",
      decisionKind: "work_request",
    }, new Date(receivedAt.getTime() + 20));
    return taskId;
  };
  const assessmentFor = (taskId, objective) => assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "u1",
      sourceTaskId: taskId,
      objective,
      steps: [{
        id: "research",
        capability: "research",
        description: objective,
        expectedEvidence: "研究结果",
      }],
    },
  });

  const readyTaskId = enqueueSourceTask("ready", 0);
  const readyAssessment = assessmentFor(readyTaskId, "尚未开始的研究");
  const readyPlan = store.registerWorkPlan(readyAssessment);
  assert.equal(readyPlan.status, "ready");
  assert.equal(store.cancelDraftForManualReply(readyTaskId), true);
  assert.equal(store.getTask(readyTaskId).status, "cancelled_manual");
  assert.equal(store.getWorkPlan(readyPlan.id).status, "cancelled");
  assert.equal(store.listWorkPlanSteps(readyPlan.id)[0].status, "cancelled");
  assert.throws(
    () => store.registerWorkPlan(readyAssessment),
    /source task is no longer actionable/u,
  );

  const executingTaskId = enqueueSourceTask("executing", 1_000);
  const executingPlan = store.registerWorkPlan(
    assessmentFor(executingTaskId, "已经开始的研究"),
  );
  assert.equal(store.consumeWorkPlanAuthorization(executingPlan.id), true);
  assert.equal(store.cancelDraftForManualReply(executingTaskId), true);
  const stopped = store.getWorkPlan(executingPlan.id);
  assert.equal(stopped.status, "executing");
  assert.ok(stopped.cancel_requested_at);
  assert.equal(stopped.cancel_requested_by, "system:manual-reply");
  assert.throws(
    () => store.consumeWorkPlanAuthorization(executingPlan.id),
    /source task is no longer actionable|not authorized/u,
  );
});

test("人工判断标注加密保存并可覆盖修正", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-04T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), now);
  const readyAt = new Date(now.getTime() + 10);
  const [taskId] = store.createReadyTasks({ quietWindowMs: 1, now: readyAt });
  const task = store.claimTask({ now: readyAt });
  store.completeDraft(task.id, {
    shouldReply: false,
    reply: "",
    confidence: 0.9,
    riskLevel: "low",
    reason: "无需回复",
    decisionSource: "hard-rule",
    decisionKind: "closed_loop",
  }, now);
  store.upsertDecisionReview(taskId, {
    expectedShouldReply: false,
    reviewer: "reviewer",
    note: "人工确认无需回复",
  }, now);
  let [review] = store.listDecisionReviews({ taskId });
  assert.equal(review.predictedShouldReply, false);
  assert.equal(review.expectedShouldReply, false);
  assert.equal(review.note, "人工确认无需回复");
  assert.equal(review.senderName, "测试用户");
  assert.equal(review.senderUserId, "u1");
  assert.equal(review.conversationId, "c1");
  assert.equal(review.decisionCurrent, true);
  store.upsertDecisionReview(taskId, {
    expectedShouldReply: true,
    reviewer: "reviewer",
    note: "修正",
  }, new Date(now.getTime() + 1000));
  [review] = store.listDecisionReviews({ taskId });
  assert.equal(review.expectedShouldReply, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM decision_reviews").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM decision_review_events").get().count, 2);
  assert.doesNotMatch(
    store.db.prepare("SELECT group_concat(note_ciphertext) AS notes FROM decision_review_events").get().notes,
    /人工确认|修正/u,
  );
});

test("运营指标使用真实草稿就绪与审批时间且不返回业务正文", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-05T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  store.claimTask({ now: new Date(base.getTime() + 10) });
  store.completeDraft(taskId, {
    shouldReply: true,
    reply: "回复",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  }, new Date(base.getTime() + 20));
  store.decideTask(taskId, {
    decision: "approved",
    actor: "operator",
  }, new Date(base.getTime() + 50));
  store.claimApprovedTask({ now: new Date(base.getTime() + 50) });
  store.beginSideEffect(taskId, "send_message", new Date(base.getTime() + 55));
  store.completeSideEffect(
    taskId,
    "send_message",
    { receipt: "ok" },
    new Date(base.getTime() + 60),
  );
  const report = store.operationalMetrics({
    since: new Date(base.getTime() - 1),
    now: new Date(base.getTime() + 100),
  });
  assert.equal(report.approvalWait.p95Ms, 30);
  assert.equal(report.lowRiskTasks.successRate, 1);
  assert.equal(report.reliability.sideEffectAuditCoverage, 1);
  assert.doesNotMatch(JSON.stringify(report), /回复|receipt/u);
});

test("入口可用性同分钟从严合并并把缺测计为不可用", async (t) => {
  const store = await fixture(t);
  store.recordAvailabilitySample(true, {
    now: new Date("2026-08-05T10:00:10Z"),
    intervalMs: 60_000,
  });
  store.recordAvailabilitySample(false, {
    now: new Date("2026-08-05T10:00:50Z"),
    intervalMs: 60_000,
  });
  const metrics = store.availabilityMetrics({
    now: new Date("2026-08-05T10:02:00Z"),
    intervalMs: 60_000,
    windowMs: 5 * 60_000,
  });
  assert.equal(metrics.expectedSamples, 2);
  assert.equal(metrics.recordedSamples, 1);
  assert.equal(metrics.readySamples, 0);
  assert.equal(metrics.missingSamples, 1);
  assert.equal(metrics.availability, 0);
  assert.equal(metrics.targetMet, null);
});

test("计划终态会形成原会话待审批结果草稿且保持幂等", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-04T10:00:00.000Z");
  store.ingestMessages(messages().slice(0, 1), now);
  const readyAt = new Date(now.getTime() + 10);
  const [sourceTaskId] = store.createReadyTasks({ quietWindowMs: 1, now: readyAt });
  store.claimTask({ now: readyAt });
  store.completeDraft(sourceTaskId, {
    shouldReply: false, reply: "", confidence: 1, riskLevel: "low",
    reason: "转为工作计划", decisionSource: "model", decisionKind: "work_request",
  }, readyAt);
  const manifest = {
    version: 1, projectId: "notice_project", name: "回传测试",
    rootDirectory: "/workspace/notice", requesters: ["u1"],
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = store.registerWorkPlan(assessWorkPlan({
    manifest,
    plan: {
      version: 1, projectId: manifest.projectId, requesterId: "u1",
      sourceTaskId, objective: "完成研究",
      steps: [{ id: "research", capability: "research", description: "研究", expectedEvidence: "结果" }],
    },
  }));
  store.consumeWorkPlanAuthorization(plan.id, readyAt);
  store.updateWorkPlanStep(plan.id, "research", { status: "completed", evidence: { verified: true } }, readyAt);
  store.finishWorkPlan(plan.id, { success: true }, readyAt);
  const first = store.ensureWorkPlanResultDraft(plan.id, readyAt);
  const second = store.ensureWorkPlanResultDraft(plan.id, readyAt);
  assert.equal(first.id, second.id);
  assert.equal(first.status, "awaiting_approval");
  assert.equal(first.conversation_id, "c1");
  assert.equal(first.payload.sourceWorkPlanId, plan.id);
  assert.equal(store.listTasks({ limit: 100 }).filter((task) => task.id === first.id).length, 1);
});

test("时间返还只统计带完整证据且经本人确认的配方计划", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "time_project",
    name: "时间返还项目",
    rootDirectory: "/workspace/time",
    requesters: ["owner"],
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = store.registerWorkPlan(assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "owner",
      recipe: {
        id: "project-follow-up",
        version: 1,
        baselineMinutes: 60,
        baselineMethod: "user_confirmed",
      },
      objective: "完成项目跟进",
      steps: [{
        id: "research",
        capability: "research",
        description: "核对进展",
        expectedEvidence: "已核对来源的项目进展",
      }],
    },
  }));
  store.consumeWorkPlanAuthorization(plan.id);
  assert.throws(
    () => store.proposeTimeReturn(plan.id, 15, "owner"),
    /completed work plan/u,
  );
  store.updateWorkPlanStep(plan.id, "research", {
    status: "completed",
    evidence: { kind: "research", verification: "source_checked", sha256: "a".repeat(64) },
  });
  store.finishWorkPlan(plan.id, { success: true });
  const proposal = store.proposeTimeReturn(plan.id, 15, "owner");
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.returnedMinutes, 45);
  assert.equal(proposal.outcomeEvidence.planHash, plan.plan_hash);
  assert.throws(
    () => store.proposeTimeReturn(plan.id, 15, "owner"),
    /already exists/u,
  );
  const confirmed = store.decideTimeReturn(proposal.id, "confirmed", "owner");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(store.listTimeReturns({ projectId: manifest.projectId }).length, 1);

  const preview = store.previewPrivacyErasure({ projectId: manifest.projectId });
  assert.equal(preview.counts.timeReturns, 1);
  store.erasePrivacyData(
    { projectId: manifest.projectId },
    preview.confirmation,
    "owner",
  );
  assert.equal(store.listTimeReturns({ projectId: manifest.projectId }).length, 0);
});

test("已确认影子证据时间返还独立于生产计划、保持幂等并可按项目擦除", async (t) => {
  const store = await fixture(t);
  const proof = {
    projectId: "shadow_project",
    recipeId: "project-follow-up",
    evidenceSha256: "a".repeat(64),
    planHash: "b".repeat(64),
    repositoryCommit: "c".repeat(40),
    baselineMinutes: 45,
    humanActiveMinutes: 5,
    baselineMethod: "user_confirmed",
    confirmedAt: "2026-08-13T10:00:00.000Z",
    outcomeEvidence: {
      kind: "confirmed_shadow_recipe_evidence",
      steps: [{ stepId: "research", sha256: "d".repeat(64) }],
    },
  };
  const first = store.importConfirmedShadowTimeReturn(
    proof,
    "owner",
    new Date("2026-08-13T11:00:00.000Z"),
  );
  assert.equal(first.created, true);
  assert.equal(first.entry.workPlanId, null);
  assert.equal(first.entry.sourceType, "shadow_evidence");
  assert.equal(first.entry.returnedMinutes, 40);
  const repeated = store.importConfirmedShadowTimeReturn(proof, "owner");
  assert.equal(repeated.created, false);
  const reordered = store.importConfirmedShadowTimeReturn({
    ...proof,
    outcomeEvidence: {
      steps: [{ sha256: "d".repeat(64), stepId: "research" }],
      kind: "confirmed_shadow_recipe_evidence",
    },
  }, "owner");
  assert.equal(reordered.created, false);
  assert.equal(store.listTimeReturns({ projectId: "shadow_project" }).length, 1);
  assert.throws(
    () => store.importConfirmedShadowTimeReturn({ ...proof, humanActiveMinutes: 6 }, "owner"),
    /different facts/u,
  );
  const preview = store.previewPrivacyErasure({ projectId: "shadow_project" });
  assert.equal(preview.counts.timeReturns, 1);
  store.erasePrivacyData({ projectId: "shadow_project" }, preview.confirmation, "owner");
  assert.equal(store.listTimeReturns({ projectId: "shadow_project" }).length, 0);
});

test("项目记忆候选绑定计划哈希、保持幂等且必须人工确认", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1, projectId: "memory_project", name: "项目记忆",
    rootDirectory: "/workspace/memory", requesters: ["owner"],
    profile: {
      objective: "形成可追溯决策", successCriteria: [], milestones: [], collaborationObjects: [],
      selectedRecipeIds: ["meeting-follow-up"],
      memoryScope: { allowedTypes: ["project"], retentionDays: 90 },
    },
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = store.registerWorkPlan(assessWorkPlan({
    manifest,
    plan: {
      version: 1, projectId: manifest.projectId, requesterId: "owner",
      recipe: { id: "meeting-follow-up", version: 1, baselineMinutes: 40, baselineMethod: "user_confirmed" },
      objective: "会议闭环",
      steps: [{ id: "research", capability: "research", description: "核对", expectedEvidence: "事实" }],
    },
  }));
  const evidence = {
    kind: "research_markdown",
    sha256: "a".repeat(64),
    verification: "source_checked",
  };
  store.updateWorkPlanStep(plan.id, "research", {
    status: "completed",
    evidence,
  });
  const input = {
    type: "project", subject: manifest.projectId, projectId: manifest.projectId,
    statement: "发布前必须完成安全检查。", sourceId: plan.plan_hash,
    sourceVersion: "meeting-follow-up@1",
    scope: workPlanMemoryEvidenceScope({
      factKey: "decision.release_gate", stepId: "research", evidence,
    }),
    confidence: 1, sensitivity: "internal",
    expiresAt: "2026-11-10T00:00:00.000Z", createdBy: "owner",
  };
  const first = store.proposeWorkPlanMemory(input, new Date("2026-08-12T00:00:00.000Z"));
  const second = store.proposeWorkPlanMemory(input, new Date("2026-08-12T00:01:00.000Z"));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
  assert.equal(store.getMemory(first.id).status, "proposed");
  assert.throws(
    () => store.proposeWorkPlanMemory({
      ...input,
      scope: { ...input.scope, evidenceSha256: "f".repeat(64) },
    }),
    /evidence is not verifiable/u,
  );
  const personPreview = store.previewPrivacyErasure({ personId: "owner" });
  assert.equal(personPreview.counts.memories, 1);
  assert.equal(store.confirmMemory(first.id, "owner", new Date("2026-08-12T00:02:00.000Z")), "confirmed");
  assert.throws(
    () => store.proposeWorkPlanMemory({ ...input, sourceId: "f".repeat(64) }),
    /not verifiable/u,
  );
});

test("SQLite 受治理工作图追加写入幂等、加密且查询强制项目范围", async (t) => {
  const store = await fixture(t);
  const graph = graphFixture();
  const first = store.appendGraphProjection(graph);
  assert.deepEqual(first, {
    graphVersion: 1,
    insertedNodes: 2,
    existingNodes: 0,
    insertedEdges: 1,
    existingEdges: 0,
  });
  const second = store.appendGraphProjection(graph);
  assert.equal(second.insertedNodes, 0);
  assert.equal(second.existingNodes, 2);
  assert.equal(second.insertedEdges, 0);
  assert.equal(second.existingEdges, 1);
  const nodes = store.listGraphNodes({ tenantId: "tenant-sqlite", projectId: "graph_project" });
  const edges = store.listGraphEdges({
    tenantId: "tenant-sqlite", projectId: "graph_project", phase: "intended",
  });
  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].edgeType, "authorization.permits_step");
  const raw = store.db.prepare(
    "SELECT payload_ciphertext FROM governed_graph_edges LIMIT 1",
  ).get();
  assert.match(raw.payload_ciphertext, /^enc:v1:/u);
  assert.equal(raw.payload_ciphertext.includes("capability_policy"), false);
  assert.throws(() => store.listGraphNodes({ tenantId: "tenant-sqlite" }), /tenantId and projectId/u);
  assert.throws(() => store.listGraphEdges({
    tenantId: "tenant-sqlite", projectId: "graph_project", limit: 501,
  }), /between 1 and 500/u);
});
