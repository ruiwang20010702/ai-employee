import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { memoryDeletionConfirmation } from "../src/memory-portability.mjs";
import { migrate } from "../src/migrate.mjs";
import { createPostgresPool } from "../src/postgres.mjs";
import { PostgresStore } from "../src/postgres-store.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const temporaryDatabase = process.env.TEST_DATABASE_TEMP === "true";
const integration = databaseUrl ? test : test.skip;
const sharedSchemaIntegration = databaseUrl && !temporaryDatabase ? test : test.skip;

function config(tenantId) {
  return {
    databaseUrl,
    databasePoolMax: temporaryDatabase ? 1 : 5,
    databaseSsl: false,
    dataKey: Buffer.alloc(32, 7).toString("base64"),
    tenantId,
  };
}

async function fixture(t) {
  const tenantId = `test-${randomUUID()}`;
  const settings = config(tenantId);
  const pool = createPostgresPool(settings);
  if (temporaryDatabase) {
    await pool.query("CREATE TEMP TABLE IF NOT EXISTS _ai_employee_temp_init(value integer)");
  }
  await migrate(pool);
  const store = await new PostgresStore(settings, { pool }).open();
  t.after(async () => {
    await pool.query("DELETE FROM availability_samples WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM checkpoints WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM work_plan_steps WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM work_plan_approvals WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM work_plans WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM memory_items WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM messages WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM tasks WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM settings WHERE tenant_id = $1", [tenantId]);
    await pool.end();
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

integration("PostgreSQL 消息去重、合并和加密存储", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:02.000Z");
  assert.equal(await store.ingestMessages(messages(), base), 2);
  assert.equal(await store.ingestMessages(messages(), base), 0);
  assert.deepEqual(
    [...await store.knownMessageIds(["m2", "missing", "m1", "m1"])].sort(),
    ["m1", "m2"],
  );
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 3_000,
    now: new Date("2026-07-31T10:00:06.000Z"),
  });
  const task = await store.getTask(taskId);
  assert.equal(task.payload.content, "你先看一下\n就是昨天的方案");
  const raw = await store.pool.query(
    `
    SELECT sender_user_id_ciphertext, payload_ciphertext
    FROM tasks WHERE id = $1
  `,
    [taskId],
  );
  assert.match(raw.rows[0].sender_user_id_ciphertext, /^enc:v1:/);
  assert.match(raw.rows[0].payload_ciphertext, /^enc:v1:/);
  assert.equal(raw.rows[0].payload_ciphertext.includes("昨天的方案"), false);
});

integration("PostgreSQL Worker 租约使用 SKIP LOCKED 防止重复领取", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  const [first, second] = await Promise.all([
    store.claimTask({ now: new Date(base.getTime() + 10) }),
    store.claimTask({ now: new Date(base.getTime() + 10) }),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal((first ?? second).id, taskId);
});

integration("PostgreSQL 局部暂停加密保存并审计恢复", async (t) => {
  const store = await fixture(t);
  await store.setScopedPause({
    type: "contact",
    value: "u1",
    paused: true,
    actor: "integration-operator",
    reason: "人工接管",
  });
  assert.equal(await store.isScopedPaused("contact", "u1"), true);
  assert.equal((await store.listScopedPauses())[0].reason, "人工接管");
  const raw = await store.pool.query(
    `SELECT key, value FROM checkpoints
     WHERE tenant_id = $1 AND left(key, 13) = 'scoped_pause:'`,
    [store.tenantId],
  );
  assert.doesNotMatch(`${raw.rows[0].key}${raw.rows[0].value}`, /人工接管|\bu1\b/u);
  await store.setScopedPause({
    type: "contact",
    value: "u1",
    paused: false,
    actor: "integration-operator",
  });
  assert.equal(await store.isScopedPaused("contact", "u1"), false);
  const audit = await store.pool.query(
    `SELECT event_type FROM audit_events
     WHERE tenant_id = $1 AND event_type LIKE 'scope.%'
     ORDER BY occurred_at`,
    [store.tenantId],
  );
  assert.deepEqual(
    audit.rows.map((row) => row.event_type),
    ["scope.paused", "scope.resumed"],
  );
});

integration("PostgreSQL 死亡任务可由负责人审计关闭且不能重复关闭", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    maxAttempts: 1,
    now: new Date(base.getTime() + 10),
  });
  await store.claimTask({ now: new Date(base.getTime() + 10) });
  assert.equal(
    await store.failTask(taskId, new Error("permanent"), new Date(base.getTime() + 20)),
    "dead",
  );
  assert.equal(
    await store.dismissDeadTask(taskId, "operator", "不再重试"),
    "cancelled_operator",
  );
  assert.equal((await store.getTask(taskId)).status, "cancelled_operator");
  await assert.rejects(
    store.dismissDeadTask(taskId, "operator"),
    /Only dead tasks/u,
  );
  const audit = await store.pool.query(
    `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND task_id = $2`,
    [store.tenantId, taskId],
  );
  assert.equal(
    audit.rows.some((row) => row.event_type === "task.dismissed_by_operator"),
    true,
  );
});

integration("PostgreSQL 死亡任务重试记录操作审计", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    maxAttempts: 1,
    now: new Date(base.getTime() + 10),
  });
  await store.claimTask({ now: new Date(base.getTime() + 10) });
  await store.failTask(taskId, new Error("old failure"), new Date(base.getTime() + 20));
  await store.retryTask(taskId, new Date(base.getTime() + 30));
  assert.equal((await store.getTask(taskId)).status, "queued");
  const audit = await store.pool.query(
    `SELECT event_type FROM audit_events
     WHERE tenant_id = $1 AND task_id = $2
       AND event_type = 'task.retried_by_operator'`,
    [store.tenantId, taskId],
  );
  assert.equal(audit.rowCount, 1);
});

integration("PostgreSQL 审批、幂等发送账本和审计形成闭环", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await store.claimTask({ now: new Date(base.getTime() + 10) });
  await store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  });
  await store.decideTask(taskId, {
    decision: "approved",
    actor: "integration-test",
  });
  assert.equal((await store.claimApprovedTask()).id, taskId);
  const first = await store.beginSideEffect(taskId, "send_message");
  const second = await store.beginSideEffect(taskId, "send_message");
  assert.equal(first.idempotency_key, second.idempotency_key);
  await store.completeSideEffect(taskId, "send_message", { success: true });
  assert.equal((await store.getTask(taskId)).status, "completed");
  const audit = await store.pool.query(
    "SELECT event_type FROM audit_events WHERE tenant_id = $1 AND task_id = $2",
    [store.tenantId, taskId],
  );
  assert.ok(audit.rows.some((row) => row.event_type === "send.completed"));
});

integration("PostgreSQL 运营指标记录草稿就绪和审批时间", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-05T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await store.claimTask({ now: new Date(base.getTime() + 10) });
  await store.completeDraft(taskId, {
    shouldReply: true,
    reply: "回复",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  }, new Date(base.getTime() + 20));
  await store.decideTask(taskId, {
    decision: "approved",
    actor: "operator",
  }, new Date(base.getTime() + 50));
  await store.claimApprovedTask({ now: new Date(base.getTime() + 50) });
  await store.beginSideEffect(taskId, "send_message", new Date(base.getTime() + 55));
  await store.completeSideEffect(
    taskId,
    "send_message",
    { receipt: "ok" },
    new Date(base.getTime() + 60),
  );
  const report = await store.operationalMetrics({
    since: new Date(base.getTime() - 1),
    now: new Date(base.getTime() + 100),
  });
  assert.equal(report.approvalWait.p95Ms, 30);
  assert.equal(report.lowRiskTasks.successRate, 1);
  assert.equal(report.reliability.sideEffectAuditCoverage, 1);
  assert.doesNotMatch(JSON.stringify(report), /回复|receipt/u);
});

integration("PostgreSQL 保存组件心跳并返回深度健康状态", async (t) => {
  const store = await fixture(t);
  await store.recordHeartbeat("listener");
  await store.recordHeartbeat("worker");
  const health = await store.health();
  assert.ok(health.database);
  assert.ok(health.heartbeats.listener);
  assert.ok(health.heartbeats.worker);
});

integration("PostgreSQL 持久化入口可用性且同分钟从严合并", async (t) => {
  const store = await fixture(t);
  await store.recordAvailabilitySample(true, {
    now: new Date("2026-08-05T10:00:10Z"),
    intervalMs: 60_000,
  });
  await store.recordAvailabilitySample(false, {
    now: new Date("2026-08-05T10:00:50Z"),
    intervalMs: 60_000,
  });
  const metrics = await store.availabilityMetrics({
    now: new Date("2026-08-05T10:02:00Z"),
    intervalMs: 60_000,
    windowMs: 5 * 60_000,
  });
  assert.equal(metrics.expectedSamples, 2);
  assert.equal(metrics.recordedSamples, 1);
  assert.equal(metrics.readySamples, 0);
  assert.equal(metrics.missingSamples, 1);
});

integration("PostgreSQL 保存影子判断人工标注", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await store.claimTask({ now: new Date(base.getTime() + 10) });
  await store.completeDraft(taskId, {
    shouldReply: false,
    reply: "",
    confidence: 0.9,
    riskLevel: "low",
    reason: "无需回复",
    decisionSource: "hard-rule",
    decisionKind: "closed_loop",
  });
  await store.upsertDecisionReview(taskId, {
    expectedShouldReply: false,
    reviewer: "integration-test",
    note: "确认",
  });
  const [review] = await store.listDecisionReviews({ taskId });
  assert.equal(review.predictedShouldReply, false);
  assert.equal(review.expectedShouldReply, false);
  assert.equal(review.decisionCurrent, true);
  assert.equal(review.note, "确认");
  assert.equal(review.senderName, "测试用户");
  assert.equal(review.senderUserId, "u1");
  assert.equal(review.conversationId, "c1");
  const history = await store.pool.query(
    `SELECT COUNT(*)::int AS count, string_agg(note_ciphertext, ',') AS notes
     FROM decision_review_events WHERE tenant_id = $1 AND task_id = $2`,
    [store.tenantId, taskId],
  );
  assert.equal(history.rows[0].count, 1);
  assert.doesNotMatch(history.rows[0].notes, /确认/u);
});

integration("PostgreSQL 会拆分消息批次并让过期待审批草稿失效", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages(
    [
      messages()[0],
      {
        ...messages()[1],
        createTime: "2026-07-31T10:10:00.000Z",
      },
    ],
    new Date("2026-07-31T10:10:01.000Z"),
  );
  const taskIds = await store.createReadyTasks({
    quietWindowMs: 1,
    bundleGapMs: 120_000,
    now: new Date("2026-07-31T10:10:02.000Z"),
  });
  assert.equal(taskIds.length, 2);
  const task = await store.claimTask({
    now: new Date("2026-07-31T10:10:02.000Z"),
  });
  await store.completeDraft(
    task.id,
    {
      shouldReply: true,
      reply: "我先看一下。",
      confidence: 0.9,
      riskLevel: "low",
      reason: "需要回复",
    },
    new Date("2026-07-31T10:10:03.000Z"),
  );
  assert.equal(
    await store.expireAwaitingDrafts({
      before: new Date("2026-07-31T10:10:04.000Z"),
      now: new Date("2026-07-31T10:10:05.000Z"),
    }),
    1,
  );
  assert.equal((await store.getTask(task.id)).status, "expired");
});

sharedSchemaIntegration("PostgreSQL 复合外键阻止跨租户关联任务", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await first.ingestMessages(messages().slice(0, 1), base);
  await second.ingestMessages(messages().slice(0, 1), base);
  const [firstTaskId] = await first.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await assert.rejects(
    second.pool.query(
      `
      UPDATE messages
      SET task_id = $1
      WHERE tenant_id = $2 AND platform_message_id = 'm1'
    `,
      [firstTaskId, second.tenantId],
    ),
    (error) => error.code === "23503",
  );
});

integration("PostgreSQL 正式记忆包含确认、来源、过期和撤销门禁", async (t) => {
  const store = await fixture(t);
  const id = await store.proposeMemory({
    type: "project",
    subject: "测试项目",
    projectId: "test_project",
    statement: "上线前必须运行真实验证。",
    sourceType: "document",
    sourceId: "source-1",
    expiresAt: "2026-08-04T12:00:00.000Z",
    createdBy: "integration-test",
  });
  assert.equal((await store.searchMemories({ query: "验证" })).length, 0);
  await store.confirmMemory(id, "approver", new Date("2026-08-04T10:00:00.000Z"));
  const found = await store.searchMemories({
    query: "验证",
    now: new Date("2026-08-04T11:00:00.000Z"),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].source_id, "source-1");
  assert.equal(
    (
      await store.searchMemories({
        query: "验证",
        now: new Date("2026-08-04T13:00:00.000Z"),
      })
    ).length,
    0,
  );
  await store.revokeMemory(id, "approver");
  assert.equal((await store.searchMemories({ query: "验证" })).length, 0);
});

integration("PostgreSQL 冲突记忆必须显式替代且不产生双活事实", async (t) => {
  const store = await fixture(t);
  const base = {
    type: "project", subject: "发布口径", projectId: "p1",
    sourceType: "operator", sourceId: "source", createdBy: "owner",
    scope: { factKey: "release-rule" },
  };
  const oldId = await store.proposeMemory({ ...base, statement: "旧口径" });
  await store.confirmMemory(oldId, "owner");
  const replacementId = await store.proposeMemory({
    ...base, statement: "新口径", sourceId: "replacement",
  });
  await assert.rejects(store.confirmMemory(replacementId, "owner"), /supersedesId/u);
  await store.confirmMemory(replacementId, "owner", new Date(), { supersedesId: oldId });
  const report = await store.memoryConflictMetrics();
  assert.equal(report.activeConflictGroups, 0);
  assert.equal((await store.listMemories({ status: "confirmed" })).length, 1);
});

integration("PostgreSQL 记忆永久删除擦除正文并保留无正文审计", async (t) => {
  const store = await fixture(t);
  const id = await store.proposeMemory({
    type: "person",
    subject: "待删除联系人",
    statement: "待删除的敏感陈述。",
    sourceType: "chat",
    sourceId: "private-source",
    scope: { relation: "private" },
    sensitivity: "confidential",
    createdBy: "owner",
  });
  await assert.rejects(
    store.deleteMemory(id, "owner", "DELETE-WRONG"),
    /confirmation/u,
  );
  assert.equal(
    await store.deleteMemory(id, "owner", memoryDeletionConfirmation(id)),
    "deleted",
  );
  assert.equal((await store.listMemories({ limit: 100 })).length, 0);
  const raw = await store.pool.query(
    `SELECT * FROM memory_items WHERE tenant_id = $1 AND id = $2`,
    [store.tenantId, id],
  );
  assert.equal(raw.rowCount, 1);
  assert.equal(store.cipher.decrypt(raw.rows[0].subject_ciphertext), "");
  assert.equal(store.cipher.decrypt(raw.rows[0].statement_ciphertext), "");
  assert.equal(store.cipher.decrypt(raw.rows[0].source_id_ciphertext), "");
  assert.deepEqual(JSON.parse(store.cipher.decrypt(raw.rows[0].scope_ciphertext)), {});
  assert.equal(raw.rows[0].project_id, null);
  const audit = await store.pool.query(
    `SELECT actor, details_ciphertext FROM audit_events
     WHERE tenant_id = $1 AND event_type = 'memory.deleted'
     ORDER BY occurred_at DESC LIMIT 1`,
    [store.tenantId],
  );
  assert.equal(audit.rowCount, 1);
  const details = JSON.parse(store.cipher.decrypt(audit.rows[0].details_ciphertext));
  assert.deepEqual(details, { memoryId: id, erased: true });
  assert.equal(JSON.stringify(details).includes("敏感"), false);
});

integration("PostgreSQL 记忆导出审计不保存目标路径或正文", async (t) => {
  const store = await fixture(t);
  await store.recordMemoryExport({
    actor: "owner",
    projectId: "project_1",
    includeContent: true,
    count: 2,
    destination: "/private/export/memories.json",
  });
  const audit = await store.pool.query(
    `SELECT details_ciphertext FROM audit_events
     WHERE tenant_id = $1 AND event_type = 'memory.exported'
     ORDER BY occurred_at DESC LIMIT 1`,
    [store.tenantId],
  );
  const details = JSON.parse(store.cipher.decrypt(audit.rows[0].details_ciphertext));
  assert.equal(details.projectId, "project_1");
  assert.equal(details.includeContent, true);
  assert.equal(details.count, 2);
  assert.match(details.destinationFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(details).includes("/private/export"), false);
});

integration("PostgreSQL 任务计划审批绑定哈希并只能消费一次", async (t) => {
  const store = await fixture(t);
  const assessment = assessWorkPlan({
    manifest: {
      version: 1,
      projectId: "test_project",
      name: "测试项目",
      rootDirectory: "/workspace/project",
      requesters: ["user-1"],
      capabilities: { code_patch: { mode: "approval_required" } },
    },
    plan: {
      version: 1,
      projectId: "test_project",
      requesterId: "user-1",
      objective: "形成代码补丁",
      steps: [
        {
          id: "code",
          capability: "code_patch",
          description: "修改代码",
          workingDirectory: "/workspace/project",
          expectedEvidence: "代码差异",
        },
      ],
    },
  });
  const plan = await store.registerWorkPlan(
    assessment,
    new Date("2026-08-04T10:00:00.000Z"),
  );
  assert.equal(
    (await store.listWorkPlans({ status: "awaiting_approval" }))[0].id,
    plan.id,
  );
  await store.decideWorkPlan(
    plan.id,
    {
      decision: "approved",
      actor: "approver",
      expiresAt: "2026-08-04T12:00:00.000Z",
    },
    new Date("2026-08-04T10:01:00.000Z"),
  );
  assert.equal(
    await store.consumeWorkPlanAuthorization(
      plan.id,
      new Date("2026-08-04T11:00:00.000Z"),
      {
        owner: "executor_1",
        leaseExpiresAt: new Date("2026-08-04T11:05:00.000Z"),
      },
    ),
    true,
  );
  assert.equal(
    await store.renewWorkPlanLease(
      plan.id,
      "executor_1",
      new Date("2026-08-04T11:06:00.000Z"),
      new Date("2026-08-04T11:01:00.000Z"),
    ),
    true,
  );
  await store.updateWorkPlanStep(plan.id, "code", { status: "executing" });
  await store.updateWorkPlanStep(plan.id, "code", {
    status: "verifying",
    evidence: { diff: "verified" },
  });
  await store.updateWorkPlanStep(plan.id, "code", {
    status: "completed",
    evidence: { diff: "verified" },
  });
  await store.finishWorkPlan(plan.id, { success: true });
  assert.equal((await store.getWorkPlan(plan.id)).execution_owner, null);
  assert.equal((await store.listWorkPlanSteps(plan.id))[0].evidence.diff, "verified");
  await assert.rejects(
    store.consumeWorkPlanAuthorization(
      plan.id,
      new Date("2026-08-04T11:01:00.000Z"),
    ),
    /not authorized/u,
  );
});

integration("PostgreSQL 计划修订废止旧计划并记录审计链", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "revision_project",
    name: "修订测试",
    rootDirectory: "/workspace/revision",
    requesters: ["user-1"],
    capabilities: { code_patch: { mode: "approval_required" } },
  };
  const makeAssessment = (description) => assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "user-1",
      objective: "修订代码计划",
      steps: [{
        id: "code",
        capability: "code_patch",
        description,
        workingDirectory: manifest.rootDirectory,
        expectedEvidence: "代码差异",
      }],
    },
  });
  const oldPlan = await store.registerWorkPlan(makeAssessment("旧步骤"));
  const revised = await store.reviseWorkPlan(
    oldPlan.id,
    makeAssessment("新步骤"),
    "integration-operator",
  );
  assert.equal((await store.getWorkPlan(oldPlan.id)).status, "superseded");
  assert.equal(revised.status, "awaiting_approval");
  assert.equal(revised.supersedes_work_plan_id, oldPlan.id);
  assert.equal(revised.revision_actor, "integration-operator");
  await assert.rejects(
    store.consumeWorkPlanAuthorization(oldPlan.id),
    /not authorized/u,
  );
  const audit = await store.pool.query(
    `SELECT actor, details_ciphertext FROM audit_events
     WHERE tenant_id = $1 AND event_type = 'work_plan.revised'`,
    [store.tenantId],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].actor, "integration-operator");
  const details = JSON.parse(store.cipher.decrypt(audit.rows[0].details_ciphertext));
  assert.equal(details.previousWorkPlanId, oldPlan.id);
  assert.equal(details.revisedWorkPlanId, revised.id);
});

integration("PostgreSQL 支持单计划取消", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "cancel_project",
    name: "取消测试",
    rootDirectory: "/workspace/cancel",
    requesters: ["user-1"],
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = await store.registerWorkPlan(assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "user-1",
      objective: "取消计划",
      steps: [{ id: "research", capability: "research", description: "研究", expectedEvidence: "结果" }],
    },
  }));
  assert.equal(
    await store.requestWorkPlanCancellation(plan.id, "integration-test"),
    "cancelled",
  );
  assert.equal((await store.getWorkPlan(plan.id)).status, "cancelled");
  assert.equal((await store.listWorkPlanSteps(plan.id))[0].status, "cancelled");
});

integration("PostgreSQL 幂等创建计划结果回传草稿", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-04T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [sourceTaskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await store.claimTask({ now: new Date(base.getTime() + 10) });
  await store.completeDraft(sourceTaskId, {
    shouldReply: false, reply: "", confidence: 1, riskLevel: "low",
    reason: "转为计划", decisionSource: "model", decisionKind: "work_request",
  });
  const manifest = {
    version: 1, projectId: "notice_project", name: "结果回传",
    rootDirectory: "/workspace/notice", requesters: ["u1"],
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = await store.registerWorkPlan(assessWorkPlan({
    manifest,
    plan: {
      version: 1, projectId: manifest.projectId, requesterId: "u1",
      sourceTaskId, objective: "研究",
      steps: [{ id: "research", capability: "research", description: "研究", expectedEvidence: "结果" }],
    },
  }));
  await store.consumeWorkPlanAuthorization(plan.id, base);
  await store.updateWorkPlanStep(plan.id, "research", { status: "completed", evidence: { verified: true } }, base);
  await store.finishWorkPlan(plan.id, { success: true }, base);
  const first = await store.ensureWorkPlanResultDraft(plan.id, base);
  const second = await store.ensureWorkPlanResultDraft(plan.id, base);
  assert.equal(first.id, second.id);
  assert.equal(first.status, "awaiting_approval");
  assert.equal(first.conversation_id, "c1");
});
