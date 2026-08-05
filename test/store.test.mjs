import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";

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
