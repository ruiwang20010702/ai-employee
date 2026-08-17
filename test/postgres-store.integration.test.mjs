import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { validateProjectManifest } from "../src/capability-policy.mjs";
import { memoryDeletionConfirmation } from "../src/memory-portability.mjs";
import { migrate } from "../src/migrate.mjs";
import { createPostgresPool } from "../src/postgres.mjs";
import { PostgresStore } from "../src/postgres-store.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";
import { workPlanMemoryEvidenceScope } from "../src/work-evidence.mjs";
import { capabilityBudgetForPlan } from "../src/capability-budget.mjs";
import { buildGraphProjection, createGraphEdge, createGraphNode } from "../src/governed-work-graph.mjs";
import {
  applyProjectMemorySync,
  previewProjectMemorySync,
} from "../src/project-memory-sync.mjs";

const execFileAsync = promisify(execFile);

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

integration("PostgreSQL 影子连接由数据库会话强制只读", async (t) => {
  const pool = createPostgresPool(config(`readonly-${randomUUID()}`), {
    readOnly: true,
  });
  t.after(() => pool.end());
  const setting = await pool.query("SHOW default_transaction_read_only");
  assert.equal(setting.rows[0].default_transaction_read_only, "on");
  await assert.rejects(
    () => pool.query("CREATE TEMP TABLE ai_employee_readonly_probe(value integer)"),
    { code: "25006" },
  );
});

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
    await pool.query("DELETE FROM governed_graph_edges WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM governed_graph_nodes WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM shadow_time_return_entries WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM time_return_entries WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM work_trigger_runs WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM work_triggers WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM availability_samples WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM checkpoints WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM work_plan_steps WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM work_plan_approvals WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM work_plans WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM capability_budget_usage WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM memory_items WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM messages WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM privacy_erased_messages WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM tasks WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM settings WHERE tenant_id = $1", [tenantId]);
    await pool.end();
  });
  return store;
}

integration("PostgreSQL 项目记忆自动同步按固定来源授权并自动确认低风险事实", async (t) => {
  const store = await fixture(t);
  const temporary = await mkdtemp(join(tmpdir(), "foursday-pg-memory-sync-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("/usr/bin/git", ["init", "--quiet", root], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  await mkdir(join(root, "docs"));
  await writeFile(
    join(root, "docs", "decisions.md"),
    "Every release requires target-system read-back.\n",
  );
  const project = validateProjectManifest({
    version: 1,
    projectId: "pg_memory_sync",
    name: "PG memory sync",
    rootDirectory: root,
    requesters: ["owner"],
    profile: {
      objective: "Keep project memory current",
      successCriteria: [], milestones: [], collaborationObjects: [], selectedRecipeIds: [],
      memoryScope: { allowedTypes: ["principle"], retentionDays: 90 },
    },
    capabilities: {
      project_memory_proposal: {
        mode: "automatic",
        allowedFactKeyPrefixes: ["principle."],
        maxRetentionDays: 90,
        sourcePaths: ["docs/decisions.md"],
        autoConfirm: true,
      },
    },
  });
  const runtime = {
    async generateArtifact() {
      return {
        runtimeId: "test-runtime",
        output: JSON.stringify({ memories: [{
          type: "principle",
          statement: "Every release requires target-system read-back.",
          factKey: "principle.release_readback",
          sourceId: "source_0",
          sourceQuote: "Every release requires target-system read-back.",
          sensitivity: "internal",
          confidence: 1,
          retentionDays: 90,
        }] }),
      };
    },
  };
  const generated = await previewProjectMemorySync({ project, store, runtime });
  const result = await applyProjectMemorySync({
    generated,
    project,
    store,
    capabilities: new Set(["project_memory_proposal"]),
  });
  assert.equal(result.memoriesConfirmed, 1);
  const [memory] = await store.listMemories({ projectId: project.projectId });
  assert.equal(memory.status, "confirmed");
  assert.equal(memory.updated_by, "system:project-memory-sync");
});

function graphFixture(tenantId, projectId = "graph_project") {
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

async function sendPostgresClarification(store, taskId, now) {
  await store.claimTask({ now });
  await store.completeDraft(taskId, {
    shouldReply: true,
    reply: "请补充目标上线日期。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "缺少必要信息",
    needsInformation: true,
    relatedToWaitingTask: false,
    workRequest: null,
  }, now);
  await store.decideTask(
    taskId,
    { decision: "approved", actor: "tester" },
    now,
  );
  await store.claimApprovedTask({ now });
  await store.beginSideEffect(taskId, "send_message", now);
  await store.completeSideEffect(taskId, "send_message", { success: true }, now);
}

async function markPostgresClarificationUnknown(store, taskId, now) {
  await store.claimTask({ now });
  await store.completeDraft(taskId, {
    shouldReply: true,
    reply: "请补充目标上线日期。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "缺少必要信息",
    needsInformation: true,
    relatedToWaitingTask: false,
    workRequest: null,
  }, now);
  await store.decideTask(
    taskId,
    { decision: "approved", actor: "tester" },
    now,
  );
  await store.claimApprovedTask({ now });
  await store.beginSideEffect(taskId, "send_message", now);
  await store.markSideEffectUnknown(
    taskId,
    "send_message",
    new Error("delivery result unavailable"),
    now,
  );
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

integration("PostgreSQL 显式紧急信号可以提前结束安静窗口", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-10T08:00:00.000Z");
  await store.ingestMessages([{
    id: "postgres-early-urgent",
    senderUserId: "u1",
    senderName: "测试用户",
    conversationId: "c1",
    createTime: base.toISOString(),
    content: "[紧急] 生产服务异常",
  }], base);
  const taskIds = await store.createReadyTasks({
    quietWindowMs: 3_000,
    bundleMaxWaitMs: 8_000,
    now: new Date(base.getTime() + 100),
  });
  assert.equal(taskIds.length, 1);
  assert.equal(
    (await store.getTask(taskIds[0])).payload.content,
    "[紧急] 生产服务异常",
  );
});

integration("PostgreSQL 连续输入在 7999ms 不触发并在 8000ms 硬截止", async (t) => {
  const store = await fixture(t);
  const firstAt = new Date("2026-08-10T08:00:00.000Z");
  await store.ingestMessages([{
    id: "postgres-max-wait-1",
    senderUserId: "u1",
    senderName: "测试用户",
    conversationId: "c1",
    createTime: firstAt.toISOString(),
    content: "第一段",
  }], firstAt);
  const secondAt = new Date(firstAt.getTime() + 7_500);
  await store.ingestMessages([{
    id: "postgres-max-wait-2",
    senderUserId: "u1",
    senderName: "测试用户",
    conversationId: "c1",
    createTime: secondAt.toISOString(),
    content: "第二段",
  }], secondAt);
  assert.equal(
    (await store.nextPendingBundleAt({
      quietWindowMs: 3_000,
      bundleMaxWaitMs: 8_000,
    })).toISOString(),
    new Date(firstAt.getTime() + 8_000).toISOString(),
  );
  assert.deepEqual(await store.createReadyTasks({
    quietWindowMs: 3_000,
    bundleMaxWaitMs: 8_000,
    now: new Date(firstAt.getTime() + 7_999),
  }), []);
  const taskIds = await store.createReadyTasks({
    quietWindowMs: 3_000,
    bundleMaxWaitMs: 8_000,
    now: new Date(firstAt.getTime() + 8_000),
  });
  assert.equal(taskIds.length, 1);
  assert.equal(
    (await store.getTask(taskIds[0])).payload.content,
    "第一段\n第二段",
  );
  assert.equal(await store.nextPendingBundleAt({
    quietWindowMs: 3_000,
    bundleMaxWaitMs: 8_000,
  }), null);
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

integration("PostgreSQL 等待信息任务只关联唯一同会话补充", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  const waitingAt = new Date(base.getTime() + 20);
  await sendPostgresClarification(store, parentId, waitingAt);
  assert.equal((await store.getTask(parentId)).status, "waiting_information");

  const answerAt = new Date(base.getTime() + 1_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-wait-answer",
    createTime: answerAt.toISOString(),
    content: "下周一上线",
  }], answerAt);
  const [childId] = await store.createReadyTasks({
    quietWindowMs: 1,
    waitingInformationTtlMs: 60_000,
    now: new Date(answerAt.getTime() + 10),
  });
  const child = await store.getTask(childId);
  assert.equal(child.continuation_of_task_id, parentId);
  assert.equal(child.payload.waitingTask.clarificationQuestion, "请补充目标上线日期。");
  assert.equal(
    new Date((await store.getTask(parentId)).waiting_information_at).toISOString(),
    waitingAt.toISOString(),
  );

  await store.claimTask({ now: new Date(answerAt.getTime() + 20) });
  await store.completeDraft(childId, {
    shouldReply: true,
    reply: "收到，将按下周一上线规划。",
    confidence: 0.95,
    riskLevel: "medium",
    reason: "回答了原追问",
    needsInformation: false,
    relatedToWaitingTask: true,
    workRequest: null,
  }, new Date(answerAt.getTime() + 20));
  assert.equal((await store.getTask(parentId)).status, "continued");
  assert.equal(
    await store.cancelDraftForManualReply(
      childId,
      new Date(answerAt.getTime() + 30),
    ),
    true,
  );
  assert.equal((await store.getTask(parentId)).status, "cancelled_manual");
});

integration("PostgreSQL 补充任务生成期间人工接管会释放父任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await sendPostgresClarification(store, parentId, new Date(base.getTime() + 20));
  const answerAt = new Date(base.getTime() + 1_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-manual-processing-answer",
    createTime: answerAt.toISOString(),
    content: "下周一上线",
  }], answerAt);
  const [childId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(answerAt.getTime() + 10),
  });
  await store.claimTask({ now: new Date(answerAt.getTime() + 20) });
  assert.equal((await store.getTask(childId)).status, "processing");
  assert.equal((await store.getTask(parentId)).status, "continuation_pending");
  assert.equal(
    await store.cancelDraftForManualReply(childId, new Date(answerAt.getTime() + 30)),
    true,
  );
  assert.equal((await store.getTask(parentId)).status, "cancelled_manual");
});

integration("PostgreSQL 同批多段补充不会在首段相关后丢失等待链", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await sendPostgresClarification(
    store,
    parentId,
    new Date(base.getTime() + 20),
  );
  const answerAt = new Date(base.getTime() + 1_000);
  await store.ingestMessages([
    {
      ...messages()[0],
      id: "postgres-multi-answer-1",
      createTime: answerAt.toISOString(),
      content: "周五",
    },
    {
      ...messages()[0],
      id: "postgres-multi-answer-2",
      createTime: new Date(answerAt.getTime() + 1).toISOString(),
      content: "更正为下周一",
    },
  ], new Date(answerAt.getTime() + 1));
  const created = await store.createReadyTasks({
    quietWindowMs: 1,
    maxMessagesPerTask: 1,
    now: new Date(answerAt.getTime() + 10),
  });
  assert.equal(created.length, 1);
  await store.claimTask({ now: new Date(answerAt.getTime() + 20) });
  await store.completeDraft(created[0], {
    shouldReply: false,
    reply: "",
    confidence: 0.9,
    riskLevel: "low",
    reason: "第一段属于补充信息",
    needsInformation: false,
    relatedToWaitingTask: true,
    workRequest: null,
  }, new Date(answerAt.getTime() + 20));
  assert.equal((await store.getTask(parentId)).status, "waiting_information");
  const [secondChildId] = await store.createReadyTasks({
    quietWindowMs: 1,
    maxMessagesPerTask: 1,
    now: new Date(answerAt.getTime() + 30),
  });
  assert.equal(
    (await store.getTask(secondChildId)).continuation_of_task_id,
    parentId,
  );
});

integration("PostgreSQL 追问后的历史补录不会冒充补充信息", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 5),
  });
  const waitingAt = new Date(base.getTime() + 20_000);
  await sendPostgresClarification(store, parentId, waitingAt);

  const historicalAt = new Date(base.getTime() + 10_000);
  const answerAt = new Date(base.getTime() + 30_000);
  await store.ingestMessages([
    {
      ...messages()[0],
      id: "postgres-boundary-old-backfill",
      createTime: historicalAt.toISOString(),
      content: "这是追问前遗漏的历史消息",
    },
    {
      ...messages()[0],
      id: "postgres-boundary-real-answer",
      createTime: answerAt.toISOString(),
      content: "下周一上线",
    },
  ], new Date(base.getTime() + 40_000));
  const created = await store.createReadyTasks({
    quietWindowMs: 1,
    bundleGapMs: 120_000,
    now: new Date(base.getTime() + 40_010),
  });
  assert.equal(created.length, 2);
  const tasks = await Promise.all(created.map((id) => store.getTask(id)));
  const oldTask = tasks.find((task) =>
    task.payload.messageIds.includes("postgres-boundary-old-backfill"));
  const answerTask = tasks.find((task) =>
    task.payload.messageIds.includes("postgres-boundary-real-answer"));
  assert.equal(oldTask.continuation_of_task_id, null);
  assert.equal(oldTask.payload.waitingTask, null);
  assert.equal(answerTask.continuation_of_task_id, parentId);
  assert.equal(
    answerTask.payload.waitingTask.clarificationQuestion,
    "请补充目标上线日期。",
  );
  assert.equal((await store.getTask(parentId)).status, "continuation_pending");
});

integration("PostgreSQL 连续补充消息等待前一条释放后再关联", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await sendPostgresClarification(store, parentId, new Date(base.getTime() + 20));
  const firstAt = new Date(base.getTime() + 1_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-serial-first",
    createTime: firstAt.toISOString(),
    content: "周五",
  }], firstAt);
  const [firstChildId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(firstAt.getTime() + 10),
  });

  const secondAt = new Date(base.getTime() + 2_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-serial-second",
    createTime: secondAt.toISOString(),
    content: "改成下周一",
  }], secondAt);
  assert.deepEqual(await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(secondAt.getTime() + 10),
  }), []);
  assert.equal(
    (await store.nextPendingBundleAt({
      quietWindowMs: 1,
      now: new Date(secondAt.getTime() + 10),
    })).toISOString(),
    new Date(secondAt.getTime() + 1_010).toISOString(),
  );
  await store.claimTask({ now: new Date(secondAt.getTime() + 20) });
  await store.completeDraft(firstChildId, {
    shouldReply: false,
    reply: "",
    confidence: 0.8,
    riskLevel: "low",
    reason: "第一条不是最终补充",
    needsInformation: false,
    relatedToWaitingTask: false,
    workRequest: null,
  }, new Date(secondAt.getTime() + 20));
  const [secondChildId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(secondAt.getTime() + 30),
  });
  assert.equal((await store.getTask(secondChildId)).continuation_of_task_id, parentId);
});

integration("PostgreSQL 补充任务死亡后可安全恢复并重试原链", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await sendPostgresClarification(store, parentId, new Date(base.getTime() + 20));
  const answerAt = new Date(base.getTime() + 1_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-retry-continuation",
    createTime: answerAt.toISOString(),
    content: "周五",
  }], answerAt);
  const [childId] = await store.createReadyTasks({
    quietWindowMs: 1,
    maxAttempts: 1,
    now: new Date(answerAt.getTime() + 10),
  });
  await store.claimTask({ now: new Date(answerAt.getTime() + 20) });
  assert.equal(
    await store.failTask(childId, new Error("permanent"), new Date(answerAt.getTime() + 20)),
    "dead",
  );
  assert.equal((await store.getTask(parentId)).status, "waiting_information");
  await store.retryTask(childId, new Date(answerAt.getTime() + 30));
  assert.equal((await store.getTask(parentId)).status, "continuation_pending");
  await store.claimTask({ now: new Date(answerAt.getTime() + 40) });
  await store.completeDraft(childId, {
    shouldReply: true,
    reply: "收到，继续处理。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "重试后确认是补充信息",
    needsInformation: false,
    relatedToWaitingTask: true,
    workRequest: null,
  }, new Date(answerAt.getTime() + 40));
  assert.equal((await store.getTask(parentId)).status, "continued");
});

integration("PostgreSQL 无关补充会释放预留并恢复原等待任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await sendPostgresClarification(store, parentId, new Date(base.getTime() + 20));

  const unrelatedAt = new Date(base.getTime() + 1_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-unrelated-continuation",
    createTime: unrelatedAt.toISOString(),
    content: "另外预算是多少？",
  }], unrelatedAt);
  const [childId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(unrelatedAt.getTime() + 10),
  });
  assert.equal((await store.getTask(parentId)).status, "continuation_pending");

  await store.claimTask({ now: new Date(unrelatedAt.getTime() + 20) });
  await store.completeDraft(childId, {
    shouldReply: false,
    reply: "",
    confidence: 0.95,
    riskLevel: "low",
    reason: "这是另一个问题，不是原追问的答案",
    needsInformation: false,
    relatedToWaitingTask: false,
    workRequest: null,
  }, new Date(unrelatedAt.getTime() + 20));
  assert.equal((await store.getTask(childId)).status, "no_reply");
  assert.equal((await store.getTask(parentId)).status, "waiting_information");
});

integration("PostgreSQL 多个等待候选时不猜测补充信息归属", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [firstParentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await sendPostgresClarification(
    store,
    firstParentId,
    new Date(base.getTime() + 20),
  );

  const secondRequestAt = new Date(base.getTime() + 1_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-second-waiting-request",
    createTime: secondRequestAt.toISOString(),
    content: "另外一个项目预算怎么定？",
  }], secondRequestAt);
  const [secondParentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(secondRequestAt.getTime() + 10),
  });
  await store.claimTask({ now: new Date(secondRequestAt.getTime() + 20) });
  await store.completeDraft(secondParentId, {
    shouldReply: true,
    reply: "请补充预算范围。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "这是独立问题且缺少预算范围",
    needsInformation: true,
    relatedToWaitingTask: false,
    workRequest: null,
  }, new Date(secondRequestAt.getTime() + 20));
  assert.equal((await store.getTask(firstParentId)).status, "waiting_information");
  await store.decideTask(secondParentId, {
    decision: "approved",
    actor: "tester",
  }, new Date(secondRequestAt.getTime() + 30));
  await store.claimApprovedTask({ now: new Date(secondRequestAt.getTime() + 30) });
  await store.beginSideEffect(
    secondParentId,
    "send_message",
    new Date(secondRequestAt.getTime() + 30),
  );
  await store.completeSideEffect(
    secondParentId,
    "send_message",
    { success: true },
    new Date(secondRequestAt.getTime() + 30),
  );

  const answerAt = new Date(base.getTime() + 2_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-ambiguous-answer",
    createTime: answerAt.toISOString(),
    content: "100 万",
  }], answerAt);
  const [answerTaskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(answerAt.getTime() + 10),
  });
  const answerTask = await store.getTask(answerTaskId);
  assert.equal(answerTask.continuation_of_task_id, null);
  assert.equal(answerTask.payload.waitingTask, null);
  assert.equal((await store.getTask(firstParentId)).status, "waiting_information");
  assert.equal((await store.getTask(secondParentId)).status, "waiting_information");
});

integration("PostgreSQL 等待信息超过 TTL 后过期且不再关联", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await sendPostgresClarification(store, parentId, new Date(base.getTime() + 20));

  const lateAt = new Date(base.getTime() + 61_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-expired-answer",
    createTime: lateAt.toISOString(),
    content: "下周一上线",
  }], lateAt);
  const [childId] = await store.createReadyTasks({
    quietWindowMs: 1,
    waitingInformationTtlMs: 60_000,
    now: new Date(lateAt.getTime() + 10),
  });
  assert.equal((await store.getTask(parentId)).status, "expired");
  assert.equal((await store.getTask(childId)).continuation_of_task_id, null);
  assert.equal((await store.getTask(childId)).payload.waitingTask, null);
});

integration("PostgreSQL 人工确认追问已发送后进入等待且不能重复确认", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await markPostgresClarificationUnknown(
    store,
    taskId,
    new Date(base.getTime() + 20),
  );
  assert.equal((await store.getTask(taskId)).status, "send_unknown");

  const confirmedAt = new Date(base.getTime() + 30);
  await store.resolveUnknownSend(taskId, "sent", "operator", confirmedAt);
  const confirmed = await store.getTask(taskId);
  assert.equal(confirmed.status, "waiting_information");
  assert.equal(
    new Date(confirmed.waiting_information_at).toISOString(),
    new Date(base.getTime() + 20).toISOString(),
  );
  await assert.rejects(
    store.resolveUnknownSend(taskId, "sent", "operator", confirmedAt),
    /Task is not in send_unknown state/u,
  );

  const answerBeforeConfirmation = new Date(base.getTime() + 25);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-answer-before-send-confirmation",
    createTime: answerBeforeConfirmation.toISOString(),
    content: "下周一上线",
  }], new Date(base.getTime() + 35));
  const [childId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 40),
  });
  assert.equal((await store.getTask(childId)).continuation_of_task_id, taskId);
});

integration("PostgreSQL 人工确认追问未发送后清理账本并允许安全重发", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await markPostgresClarificationUnknown(
    store,
    taskId,
    new Date(base.getTime() + 20),
  );

  const resolvedAt = new Date(base.getTime() + 30);
  await store.resolveUnknownSend(taskId, "not_sent", "operator", resolvedAt);
  const resolved = await store.getTask(taskId);
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.waiting_information_at, null);
  const ledger = await store.pool.query(
    `SELECT status FROM side_effects
     WHERE tenant_id = $1 AND task_id = $2 AND capability = 'send_message'`,
    [store.tenantId, taskId],
  );
  assert.equal(ledger.rowCount, 0);

  assert.equal(
    (await store.claimApprovedTask({ now: new Date(base.getTime() + 40) })).id,
    taskId,
  );
  const retried = await store.beginSideEffect(
    taskId,
    "send_message",
    new Date(base.getTime() + 40),
  );
  assert.equal(retried.idempotency_key, `send_message:${taskId}`);
  assert.equal(retried.status, "started");
});

integration("PostgreSQL 并发建任务只能原子预留一次等待链", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages([messages()[0]], base);
  const [parentId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await sendPostgresClarification(store, parentId, new Date(base.getTime() + 20));

  const answerAt = new Date(base.getTime() + 1_000);
  await store.ingestMessages([{
    ...messages()[0],
    id: "postgres-concurrent-answer",
    createTime: answerAt.toISOString(),
    content: "下周一上线",
  }], answerAt);
  const secondPool = createPostgresPool(store.config);
  try {
    const secondStore = await new PostgresStore(store.config, {
      pool: secondPool,
    }).open();
    const results = await Promise.all([
      store.createReadyTasks({
        quietWindowMs: 1,
        now: new Date(answerAt.getTime() + 10),
      }),
      secondStore.createReadyTasks({
        quietWindowMs: 1,
        now: new Date(answerAt.getTime() + 10),
      }),
    ]);
    assert.deepEqual(results.map((ids) => ids.length).sort(), [0, 1]);
    const [childId] = results.flat();
    const child = await store.getTask(childId);
    assert.equal(child.continuation_of_task_id, parentId);
    assert.equal(child.payload.messageIds.includes("postgres-concurrent-answer"), true);
    assert.equal((await store.getTask(parentId)).status, "continuation_pending");
    const bundled = await store.pool.query(
      `SELECT status, task_id FROM messages
       WHERE tenant_id = $1 AND platform_message_id = $2`,
      [store.tenantId, "postgres-concurrent-answer"],
    );
    assert.deepEqual(bundled.rows[0], { status: "bundled", task_id: childId });
  } finally {
    await secondPool.end();
  }
});

integration("PostgreSQL 联系人和群聊局部暂停加密保存并审计恢复", async (t) => {
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
  await store.setScopedPause({
    type: "group",
    value: "group-1",
    paused: true,
    actor: "integration-operator",
    reason: "群聊静默",
  });
  assert.equal(await store.isScopedPaused("group", "group-1"), true);
  const groupRaw = await store.pool.query(
    `SELECT key, value FROM checkpoints
     WHERE tenant_id = $1 AND left(key, 19) = 'scoped_pause:group:'`,
    [store.tenantId],
  );
  assert.equal(groupRaw.rowCount, 1);
  assert.doesNotMatch(
    `${groupRaw.rows[0].key}${groupRaw.rows[0].value}`,
    /群聊静默|group-1/u,
  );
  await store.setScopedPause({
    type: "group",
    value: "group-1",
    paused: false,
    actor: "integration-operator",
  });
  assert.equal(await store.isScopedPaused("group", "group-1"), false);
  const audit = await store.pool.query(
    `SELECT event_type FROM audit_events
     WHERE tenant_id = $1 AND event_type LIKE 'scope.%'
     ORDER BY occurred_at`,
    [store.tenantId],
  );
  assert.deepEqual(
    audit.rows.map((row) => row.event_type),
    ["scope.paused", "scope.resumed", "scope.paused", "scope.resumed"],
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

integration("PostgreSQL 非发送态和缺失副作用账本均拒绝确认", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-07-31T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await assert.rejects(
    store.beginSideEffect(taskId, "send_message", base),
    /Task is not sending/u,
  );
  await store.claimTask({ now: new Date(base.getTime() + 20) });
  await store.completeDraft(taskId, {
    shouldReply: true,
    reply: "我先看一下。",
    confidence: 0.9,
    riskLevel: "low",
    reason: "需要回复",
  }, new Date(base.getTime() + 20));
  await store.decideTask(taskId, {
    decision: "approved",
    actor: "integration-test",
  }, new Date(base.getTime() + 30));
  await store.claimApprovedTask({ now: new Date(base.getTime() + 30) });
  await assert.rejects(
    store.completeSideEffect(
      taskId,
      "send_message",
      { success: true },
      new Date(base.getTime() + 40),
    ),
    /Side effect was not started/u,
  );
  assert.equal((await store.getTask(taskId)).status, "sending");
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

integration("PostgreSQL 自动记忆候选原子去重且冲突留待人工确认", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-10T09:00:00.000Z");
  const sourceAt = new Date("2026-08-10T08:00:00.000Z");
  await store.ingestMessages([
    ...["message-1", "message-2", "message-3"].map((id, index) => ({
      id,
      senderUserId: "candidate-user",
      senderName: "测试用户",
      conversationId: "candidate-conversation",
      createTime: new Date(sourceAt.getTime() + index).toISOString(),
      content: "对方明确表达了回复长度偏好。",
    })),
  ], sourceAt);
  const [sourceTaskId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(sourceAt.getTime() + 10),
  });
  await store.claimTask({ now: new Date(sourceAt.getTime() + 20) });
  await store.completeDraft(sourceTaskId, {
    shouldReply: false,
    reply: "",
    confidence: 0.9,
    riskLevel: "low",
    reason: "无需回复",
    needsInformation: false,
    relatedToWaitingTask: false,
    workRequest: null,
  }, new Date(sourceAt.getTime() + 20));
  const base = {
    type: "person",
    subject: "candidate-user",
    statement: "对方明确偏好简短回复。",
    sourceType: "dingtalk_message",
    sourceId: "message-1",
    sourceVersion: sourceTaskId,
    scope: { factKey: "communication.reply_length" },
    confidence: 0.9,
    sensitivity: "internal",
    expiresAt: new Date(now.getTime() + 90 * 86_400_000),
    createdBy: "system:memory-candidate",
  };
  const results = await Promise.all([
    store.proposeMemoryCandidate(base, now),
    store.proposeMemoryCandidate({ ...base, sourceId: "message-2" }, now),
  ]);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results.filter((result) => result.reason === "duplicate").length, 1);
  const [candidate] = await store.listMemories({ status: "proposed" });
  assert.equal(candidate.source_type, "dingtalk_message");
  assert.equal((await store.searchMemories({ query: "简短", now })).length, 0);
  await store.confirmMemory(candidate.id, "owner", now);

  const conflict = await store.proposeMemoryCandidate({
    ...base,
    statement: "对方明确偏好详细回复。",
    sourceId: "message-3",
  }, new Date(now.getTime() + 1_000));
  assert.equal(conflict.created, true);
  assert.equal(conflict.conflictCount, 1);
  await assert.rejects(
    store.confirmMemory(conflict.id, "owner", new Date(now.getTime() + 2_000)),
    /supersedesId/u,
  );
  await store.pool.query(
    `UPDATE tasks SET payload_ciphertext = $3
     WHERE tenant_id = $1 AND id = $2`,
    [store.tenantId, sourceTaskId, store.cipher.encrypt("{}")],
  );
  await assert.rejects(
    store.confirmMemory(
      conflict.id,
      "owner",
      new Date(now.getTime() + 3_000),
      { supersedesId: candidate.id },
    ),
    /source must remain verifiable/u,
  );
  assert.equal((await store.listMemories({ status: "confirmed" })).length, 1);
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

integration("PostgreSQL 历史项目记忆批量导入并发幂等且冲突不自动转正", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-13T00:00:00.000Z");
  const base = {
    type: "project",
    subject: "legacy_project",
    projectId: "legacy_project",
    statement: "发布前必须完成目标系统回读。",
    sourceType: "historical_project_import",
    sourceId: "a".repeat(64),
    sourceVersion: "a".repeat(64),
    scope: {
      factKey: "delivery.readback_rule",
      sourcePath: "docs/history.md",
      sourceQuoteSha256: "b".repeat(64),
      importDigest: "c".repeat(64),
    },
    confidence: 1,
    sensitivity: "internal",
    expiresAt: new Date(now.getTime() + 90 * 86_400_000),
    createdBy: "owner",
  };
  const results = await Promise.all([
    store.proposeHistoricalProjectMemories([base], now),
    store.proposeHistoricalProjectMemories([base], now),
  ]);
  assert.equal(results.flat().filter((result) => result.created).length, 1);
  assert.equal(
    results.flat().filter((result) => result.reason === "duplicate").length,
    1,
  );
  const [candidate] = await store.listMemories({
    projectId: "legacy_project",
    status: "proposed",
  });
  assert.equal(candidate.source_type, "historical_project_import");
  await store.confirmMemory(candidate.id, "owner", new Date(now.getTime() + 1_000));
  const [conflict] = await store.proposeHistoricalProjectMemories([{
    ...base,
    statement: "发布门禁调整为仅运行本地检查。",
    sourceId: "d".repeat(64),
    sourceVersion: "d".repeat(64),
    scope: {
      ...base.scope,
      sourceQuoteSha256: "e".repeat(64),
      importDigest: "f".repeat(64),
    },
  }], new Date(now.getTime() + 2_000));
  assert.equal(conflict.created, true);
  assert.equal(conflict.conflictCount, 1);
  assert.equal((await store.getMemory(conflict.id)).status, "proposed");
});

integration("PostgreSQL gbrain 记忆来源访问租约控制确认和检索", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-05T08:00:00.000Z");
  const id = await store.proposeMemory({
    type: "knowledge",
    subject: "项目知识",
    projectId: "test_project",
    statement: "只在来源仍可访问时使用。",
    sourceType: "gbrain",
    sourceId: "projects/test/rule",
    createdBy: "integration-test",
  }, now);
  await assert.rejects(
    store.confirmMemory(id, "approver", now),
    /source access must be verified/u,
  );
  await store.setMemorySourceAccess(id, {
    status: "verified",
    reason: "exact_source_verified",
    checkedAt: now,
    expiresAt: new Date(now.getTime() + 900_000),
    sourceVersion: "live-v1",
  }, "system:memory-source", now);
  assert.equal((await store.getMemory(id)).source_version, "live-v1");
  await store.confirmMemory(id, "approver", now);
  assert.equal((await store.searchMemories({
    type: "knowledge",
    now: new Date(now.getTime() + 899_999),
  })).length, 1);
  assert.equal((await store.searchMemories({
    type: "knowledge",
    now: new Date(now.getTime() + 900_000),
  })).length, 0);
  await store.setMemorySourceAccess(id, {
    status: "verified",
    reason: "exact_source_verified",
    checkedAt: new Date(now.getTime() + 900_000),
    expiresAt: new Date(now.getTime() + 1_800_000),
    sourceVersion: "live-v1",
  }, "system:memory-source");
  await store.setMemorySourceAccess(id, {
    status: "revoked",
    reason: "knowledge_read_disabled",
    checkedAt: new Date(now.getTime() + 900_001),
  }, "system:memory-source");
  const audit = await store.pool.query(
    `SELECT details_ciphertext FROM audit_events
     WHERE tenant_id = $1 AND event_type = 'memory.source_access_checked'
     ORDER BY occurred_at DESC LIMIT 1`,
    [store.tenantId],
  );
  const details = JSON.parse(store.cipher.decrypt(audit.rows[0].details_ciphertext));
  assert.equal(details.status, "revoked");
  assert.equal(JSON.stringify(details).includes("只在来源"), false);
  const auditCount = await store.pool.query(
    `SELECT COUNT(*)::int AS count FROM audit_events
     WHERE tenant_id = $1 AND event_type = 'memory.source_access_checked'`,
    [store.tenantId],
  );
  assert.equal(auditCount.rows[0].count, 2);
});

integration("PostgreSQL 将来源候选原子迁移为 gbrain 权威投影", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-17T08:00:00.000Z");
  const sourceId = await store.proposeMemory({
    type: "project",
    subject: "foursday",
    projectId: "foursday",
    statement: "长期记忆正文以 Markdown 为权威。",
    sourceType: "dingtalk_message",
    sourceId: "message-private-1",
    sourceVersion: "task-private-1",
    scope: { factKey: "decision.memory_authority" },
    confidence: 1,
    sensitivity: "internal",
    expiresAt: new Date("2027-08-17T08:00:00.000Z"),
    createdBy: "system:memory-candidate",
  }, now);
  const projection = await store.upsertAuthorityMemoryProjection({
    sourceMemoryId: sourceId,
    slug: "atoms/foursday/projects/foursday/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceVersion: "2026-08-17T08:00:01.000Z",
    authorityContentSha256: "b".repeat(64),
    authoritySourceId: "foursday",
    accessExpiresAt: new Date(now.getTime() + 900_000),
    actor: "system:memory-authority",
  }, now);
  assert.equal(projection.created, true);
  assert.equal((await store.getMemory(sourceId)).status, "revoked");
  const authority = await store.getMemory(projection.id);
  assert.equal(authority.source_type, "gbrain");
  assert.equal(authority.source_access_status, "verified");
  assert.equal(authority.scope.authority.schema, "foursday-memory-authority/v1");
  assert.equal(authority.scope.authority.origin.sourceId, "message-private-1");
  await store.confirmMemory(projection.id, "system:memory-authority", now);
  const results = await store.searchMemories({
    type: "project",
    projectId: "foursday",
    now: new Date(now.getTime() + 1),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, projection.id);
  const repeated = await store.upsertAuthorityMemoryProjection({
    sourceMemoryId: sourceId,
    slug: authority.source_id,
    sourceVersion: authority.source_version,
    authorityContentSha256: authority.scope.authority.contentSha256,
    authoritySourceId: "foursday",
    accessExpiresAt: new Date(now.getTime() + 900_000),
    actor: "system:memory-authority",
  }, now);
  assert.equal(repeated.created, false);
  assert.equal(repeated.id, projection.id);
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

integration("PostgreSQL 并发确认同一事实范围最多产生一条正式记忆", async (t) => {
  const store = await fixture(t);
  const base = {
    type: "project",
    subject: "并发发布口径",
    projectId: "concurrent-project",
    sourceType: "operator",
    createdBy: "owner",
    scope: { factKey: "release.rule" },
  };
  const [firstId, secondId] = await Promise.all([
    store.proposeMemory({
      ...base,
      statement: "必须先完成安全扫描。",
      sourceId: "source-first",
    }),
    store.proposeMemory({
      ...base,
      statement: "可以跳过安全扫描。",
      sourceId: "source-second",
    }),
  ]);
  const results = await Promise.allSettled([
    store.confirmMemory(firstId, "owner"),
    store.confirmMemory(secondId, "owner"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
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

integration("PostgreSQL 按人隐私擦除在串行事务中清空正文和关联审计", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-05T10:00:00.000Z");
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
  }, new Date(base.getTime() + 20));
  await store.upsertDecisionReview(taskId, {
    expectedShouldReply: false,
    reviewer: "u1",
    note: "个人标注正文",
  }, new Date(base.getTime() + 30));
  const memoryId = await store.proposeMemory({
    type: "person",
    subject: "u1",
    statement: "个人敏感陈述",
    sourceType: "chat",
    sourceId: "private-message",
    createdBy: "u1",
  }, new Date(base.getTime() + 31));
  const derivedMemory = await store.proposeMemoryCandidate({
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
  }, new Date(base.getTime() + 31));
  const preview = await store.previewPrivacyErasure(
    { personId: "u1" },
    new Date(base.getTime() + 40),
  );
  assert.match(preview.confirmation, /^ERASE-/u);
  assert.equal(preview.counts.tasks, 1);
  assert.equal(preview.counts.memories, 2);
  assert.equal(JSON.stringify(preview).includes("u1"), false);
  await store.erasePrivacyData(
    { personId: "u1" },
    preview.confirmation,
    "privacy-operator",
    new Date(base.getTime() + 40),
  );
  assert.equal(await store.getTask(taskId), null);
  assert.equal(await store.getMemory(memoryId), null);
  assert.equal(await store.getMemory(derivedMemory.id), null);
  assert.equal(await store.ingestMessages(messages().slice(0, 1), new Date(base.getTime() + 50)), 0);
  const raw = await store.pool.query(
    `SELECT t.privacy_erased_at, t.payload_ciphertext,
            (SELECT COUNT(*)::int FROM messages m
             WHERE m.tenant_id = t.tenant_id AND m.task_id = t.id) AS message_count,
            r.reviewer, r.note_ciphertext
     FROM tasks t
     LEFT JOIN decision_reviews r
       ON r.tenant_id = t.tenant_id AND r.task_id = t.id
     WHERE t.tenant_id = $1 AND t.id = $2`,
    [store.tenantId, taskId],
  );
  assert.ok(raw.rows[0].privacy_erased_at);
  assert.deepEqual(JSON.parse(store.cipher.decrypt(raw.rows[0].payload_ciphertext)), {});
  assert.equal(raw.rows[0].message_count, 0);
  assert.equal(raw.rows[0].reviewer, null);
  assert.equal(raw.rows[0].note_ciphertext, null);
  const audit = await store.pool.query(
    `SELECT actor, details_ciphertext FROM audit_events
     WHERE tenant_id = $1 ORDER BY id`,
    [store.tenantId],
  );
  const decoded = audit.rows.map((row) => ({
    actor: row.actor,
    details: JSON.parse(store.cipher.decrypt(row.details_ciphertext)),
  }));
  assert.equal(JSON.stringify(decoded).includes("个人敏感"), false);
  assert.equal(JSON.stringify(decoded).includes("个人标注"), false);
  const erasure = decoded.at(-1);
  assert.equal(erasure.actor, "system:privacy");
  assert.equal(erasure.details.selector.type, "person");
  assert.match(erasure.details.requestedByFingerprint, /^[a-f0-9]{24}$/u);
  assert.equal(JSON.stringify(erasure).includes("privacy-operator"), false);
});

integration("PostgreSQL 按项目擦除计划及其明确绑定的来源任务", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-05T10:00:00.000Z");
  await store.ingestMessages(messages().slice(0, 1), base);
  const [taskId] = await store.createReadyTasks({ quietWindowMs: 1, now: new Date(base.getTime() + 10) });
  await store.claimTask({ now: new Date(base.getTime() + 10) });
  await store.completeDraft(taskId, {
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
  const assessment = assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: "privacy_project",
      requesterId: "u1",
      sourceTaskId: taskId,
      objective: "项目敏感目标",
      steps: [{ id: "research", capability: "research", description: "研究", expectedEvidence: "结论" }],
    },
  });
  const plan = await store.registerWorkPlan(assessment, new Date(base.getTime() + 30));
  assert.equal((await store.previewPrivacyErasure({ projectId: "privacy_project" })).confirmation, null);
  await store.requestWorkPlanCancellation(plan.id, "operator", new Date(base.getTime() + 40));
  await store.appendGraphProjection(
    graphFixture(store.tenantId, "privacy_project"),
    new Date(base.getTime() + 40),
  );
  await store.pool.query(
    `INSERT INTO capability_budget_usage(
       tenant_id, project_key, project_id_ciphertext,
       authorization_hash, capability,
       limit_count, used_count, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $6)`,
    [
      store.tenantId,
      store.cipher.fingerprint("privacy_project"),
      store.cipher.encrypt("privacy_project"),
      "a".repeat(64),
      "research",
      new Date(base.getTime() + 41),
    ],
  );
  const preview = await store.previewPrivacyErasure(
    { projectId: "privacy_project" }, new Date(base.getTime() + 50),
  );
  assert.equal(preview.counts.tasks, 1);
  assert.equal(preview.counts.workPlans, 1);
  assert.equal(preview.counts.capabilityBudgets, 1);
  assert.equal(preview.counts.graphNodes, 2);
  assert.equal(preview.counts.graphEdges, 1);
  await store.erasePrivacyData(
    { projectId: "privacy_project" }, preview.confirmation, "operator", new Date(base.getTime() + 50),
  );
  assert.equal(await store.getTask(taskId), null);
  assert.equal(await store.getWorkPlan(plan.id), null);
  const raw = await store.pool.query(
    `SELECT project_id, plan_ciphertext, privacy_erased_at FROM work_plans
     WHERE tenant_id = $1 AND id = $2`,
    [store.tenantId, plan.id],
  );
  assert.equal(raw.rows[0].project_id, "deleted");
  assert.deepEqual(JSON.parse(store.cipher.decrypt(raw.rows[0].plan_ciphertext)), {});
  assert.ok(raw.rows[0].privacy_erased_at);
  const retainedBudget = await store.pool.query(
    `SELECT project_id_ciphertext, used_count
     FROM capability_budget_usage WHERE tenant_id = $1`,
    [store.tenantId],
  );
  assert.equal(retainedBudget.rowCount, 1);
  assert.equal(store.cipher.decrypt(retainedBudget.rows[0].project_id_ciphertext), "");
  assert.equal(retainedBudget.rows[0].used_count, 1);
  assert.equal((await store.listGraphNodes({ projectId: "privacy_project" })).length, 0);
  assert.equal((await store.listGraphEdges({ projectId: "privacy_project" })).length, 0);
  await assert.rejects(
    store.registerWorkPlan(assessment),
    /source task is no longer actionable|cannot be recreated/u,
  );
});

integration("PostgreSQL 按时间擦除不会重置安全能力预算", async (t) => {
  const store = await fixture(t);
  const old = new Date("2026-08-01T10:00:00.000Z");
  await store.proposeMemory({
    type: "principle",
    subject: "organization",
    statement: "已过期的临时口径",
    sourceType: "operator",
    sourceId: "old-source",
    createdBy: "operator",
  }, old);
  await store.pool.query(
    `INSERT INTO capability_budget_usage(
       tenant_id, project_key, project_id_ciphertext,
       authorization_hash, capability, limit_count, used_count,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,1,1,$6,$6)`,
    [
      store.tenantId,
      store.cipher.fingerprint("retained_budget_project"),
      store.cipher.encrypt("retained_budget_project"),
      "b".repeat(64),
      "research",
      old,
    ],
  );
  const selector = { before: "2026-08-02T00:00:00.000Z" };
  const now = new Date("2026-08-05T00:00:00.000Z");
  const preview = await store.previewPrivacyErasure(selector, now);
  assert.equal(preview.counts.capabilityBudgets, 0);
  await store.erasePrivacyData(selector, preview.confirmation, "operator", now);
  const retained = await store.pool.query(
    `SELECT used_count FROM capability_budget_usage WHERE tenant_id = $1`,
    [store.tenantId],
  );
  assert.equal(retained.rowCount, 1);
  assert.equal(retained.rows[0].used_count, 1);
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

integration("PostgreSQL 项目工作历史在存储层绑定项目、时间窗口和当前计划", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "history_project",
    name: "历史项目",
    rootDirectory: "/workspace/history",
    requesters: ["user-1"],
    capabilities: { code_patch: { mode: "approval_required" } },
  };
  const assessment = (objective) => assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: "history_project",
      requesterId: "user-1",
      objective,
      steps: [{
        id: "code",
        capability: "code_patch",
        description: objective,
        workingDirectory: "/workspace/history",
        expectedEvidence: "差异",
      }],
    },
  });
  const complete = async (objective, hour) => {
    const registered = await store.registerWorkPlan(
      assessment(objective),
      new Date(`2026-08-13T0${hour}:00:00.000Z`),
    );
    await store.decideWorkPlan(registered.id, {
      decision: "approved",
      actor: "owner",
      expiresAt: "2026-08-13T12:00:00.000Z",
    }, new Date(`2026-08-13T0${hour}:01:00.000Z`));
    await store.consumeWorkPlanAuthorization(
      registered.id,
      new Date(`2026-08-13T0${hour}:02:00.000Z`),
    );
    await store.updateWorkPlanStep(registered.id, "code", {
      status: "completed",
      evidence: {
        kind: "unified_diff",
        sha256: "d".repeat(64),
        verification: "git_apply_check",
      },
    }, new Date(`2026-08-13T0${hour}:03:00.000Z`));
    await store.finishWorkPlan(
      registered.id,
      { success: true },
      new Date(`2026-08-13T0${hour}:04:00.000Z`),
    );
    return registered;
  };
  const included = await complete("当日完成", 1);
  const excluded = await complete("当前日报计划", 2);
  const history = await store.listProjectWorkHistory({
    projectId: "history_project",
    start: "2026-08-13T00:00:00.000Z",
    end: "2026-08-14T00:00:00.000Z",
    excludePlanHash: excluded.plan_hash,
    limit: 10,
  });
  assert.deepEqual(history.map((plan) => plan.id), [included.id]);
  assert.equal(history[0].steps[0].evidence.kind, "unified_diff");
  assert.deepEqual(await store.listProjectWorkHistory({
    projectId: "other_project",
    start: "2026-08-13T00:00:00.000Z",
    end: "2026-08-14T00:00:00.000Z",
    limit: 10,
  }), []);
  await assert.rejects(
    store.listProjectWorkHistory({
      projectId: "history_project",
      start: "invalid",
      end: "2026-08-14T00:00:00.000Z",
    }),
    /query is invalid/u,
  );
});

integration("PostgreSQL 能力次数预算在并发计划间原子扣减", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "budget_project",
    name: "预算项目",
    rootDirectory: "/workspace/budget",
    requesters: ["user-1"],
    capabilities: { research: { mode: "automatic", maxRuns: 1 } },
  };
  const makeAssessment = (objective) => assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: "budget_project",
      requesterId: "user-1",
      objective,
      steps: [{
        id: "research",
        capability: "research",
        description: objective,
        inputs: {},
        expectedEvidence: "研究结果",
      }],
    },
  });
  const firstAssessment = makeAssessment("第一次研究");
  const secondAssessment = makeAssessment("第二次研究");
  const [first, second] = await Promise.all([
    store.registerWorkPlan(firstAssessment),
    store.registerWorkPlan(secondAssessment),
  ]);
  const results = await Promise.allSettled([
    store.consumeWorkPlanAuthorization(first.id, new Date(), {
      capabilityBudget: capabilityBudgetForPlan(firstAssessment, manifest),
    }),
    store.consumeWorkPlanAuthorization(second.id, new Date(), {
      capabilityBudget: capabilityBudgetForPlan(secondAssessment, manifest),
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(
    results.find((result) => result.status === "rejected").reason.message,
    /budget exhausted/u,
  );
  assert.deepEqual(
    (await store.listCapabilityBudgetUsage({ projectId: "budget_project" }))
      .map(({ capability, limit, used, remaining }) => ({
        capability,
        limit,
        used,
        remaining,
      })),
    [{ capability: "research", limit: 1, used: 1, remaining: 0 }],
  );
});

integration("PostgreSQL 拒绝伪造授权哈希且不创建新预算账本", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "budget_forgery_project",
    name: "预算防伪项目",
    rootDirectory: "/workspace/budget-forgery",
    requesters: ["user-1"],
    capabilities: { research: { mode: "automatic", maxRuns: 1 } },
  };
  const assessment = assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "user-1",
      objective: "验证授权绑定",
      steps: [{
        id: "research",
        capability: "research",
        description: "研究",
        inputs: {},
        expectedEvidence: "结论",
      }],
    },
  });
  const plan = await store.registerWorkPlan(assessment);
  const forged = {
    ...capabilityBudgetForPlan(assessment, manifest),
    authorizationHash: "f".repeat(64),
  };
  await assert.rejects(
    store.consumeWorkPlanAuthorization(plan.id, new Date(), {
      capabilityBudget: forged,
    }),
    /does not match the registered work plan/u,
  );
  assert.equal((await store.listCapabilityBudgetUsage()).length, 0);
});

integration("PostgreSQL 多能力预算后一项失败时整体回滚", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "budget_atomic_project",
    name: "预算原子项目",
    rootDirectory: "/workspace/budget-atomic",
    requesters: ["user-1"],
    capabilities: {
      document_draft: { mode: "automatic", maxRuns: 1 },
      research: { mode: "automatic", maxRuns: 1 },
    },
  };
  const makeAssessment = (objective, capabilities) => assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "user-1",
      objective,
      steps: capabilities.map((capability) => ({
        id: capability,
        capability,
        description: capability,
        inputs: {},
        expectedEvidence: "证据",
      })),
    },
  });
  const researchAssessment = makeAssessment("先耗尽 research", ["research"]);
  const researchPlan = await store.registerWorkPlan(researchAssessment);
  await store.consumeWorkPlanAuthorization(researchPlan.id, new Date(), {
    capabilityBudget: capabilityBudgetForPlan(researchAssessment, manifest),
  });

  const combinedAssessment = makeAssessment(
    "尝试同时消耗",
    ["document_draft", "research"],
  );
  const combinedPlan = await store.registerWorkPlan(combinedAssessment);
  await assert.rejects(
    store.consumeWorkPlanAuthorization(combinedPlan.id, new Date(), {
      capabilityBudget: capabilityBudgetForPlan(combinedAssessment, manifest),
    }),
    /budget exhausted/u,
  );
  assert.deepEqual(
    (await store.listCapabilityBudgetUsage({ projectId: manifest.projectId }))
      .map(({ capability, used }) => ({ capability, used })),
    [{ capability: "research", used: 1 }],
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

integration("PostgreSQL 人工接管同时约束关联执行计划", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-10T08:00:00.000Z");
  const manifest = {
    version: 1,
    projectId: "postgres_manual_takeover",
    name: "人工接管测试",
    rootDirectory: "/workspace/postgres-manual-takeover",
    requesters: ["u1"],
    capabilities: { research: { mode: "automatic", maxRuns: 5 } },
  };
  const enqueueSourceTask = async (suffix, offsetMs) => {
    const receivedAt = new Date(base.getTime() + offsetMs);
    await store.ingestMessages([{
      ...messages()[0],
      id: `postgres-manual-takeover-${suffix}`,
      conversationId: `postgres-manual-takeover-${suffix}`,
      createTime: receivedAt.toISOString(),
      content: `请研究${suffix}`,
    }], receivedAt);
    const [taskId] = await store.createReadyTasks({
      quietWindowMs: 1,
      now: new Date(receivedAt.getTime() + 10),
    });
    await store.claimTask({ now: new Date(receivedAt.getTime() + 10) });
    await store.completeDraft(taskId, {
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

  const readyTaskId = await enqueueSourceTask("ready", 0);
  const readyAssessment = assessmentFor(readyTaskId, "尚未开始的研究");
  const readyPlan = await store.registerWorkPlan(readyAssessment);
  assert.equal(await store.cancelDraftForManualReply(readyTaskId), true);
  assert.equal((await store.getTask(readyTaskId)).status, "cancelled_manual");
  assert.equal((await store.getWorkPlan(readyPlan.id)).status, "cancelled");
  assert.equal((await store.listWorkPlanSteps(readyPlan.id))[0].status, "cancelled");
  await assert.rejects(
    store.registerWorkPlan(readyAssessment),
    /source task is no longer actionable/u,
  );

  const executingTaskId = await enqueueSourceTask("executing", 1_000);
  const executingPlan = await store.registerWorkPlan(
    assessmentFor(executingTaskId, "已经开始的研究"),
  );
  assert.equal(
    await store.consumeWorkPlanAuthorization(executingPlan.id),
    true,
  );
  assert.equal(await store.cancelDraftForManualReply(executingTaskId), true);
  const stopped = await store.getWorkPlan(executingPlan.id);
  assert.equal(stopped.status, "executing");
  assert.ok(stopped.cancel_requested_at);
  assert.equal(stopped.cancel_requested_by, "system:manual-reply");
  await assert.rejects(
    store.consumeWorkPlanAuthorization(executingPlan.id),
    /source task is no longer actionable|not authorized/u,
  );
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

integration("PostgreSQL 时间返还需要完整证据、人工确认并随项目擦除", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1,
    projectId: "time_project",
    name: "时间返还",
    rootDirectory: "/workspace/time",
    requesters: ["owner"],
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = await store.registerWorkPlan(assessWorkPlan({
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
      objective: "项目跟进",
      steps: [{
        id: "research",
        capability: "research",
        description: "核对进展",
        expectedEvidence: "项目进展",
      }],
    },
  }));
  await store.consumeWorkPlanAuthorization(plan.id);
  await assert.rejects(
    store.proposeTimeReturn(plan.id, 10, "owner"),
    /completed work plan/u,
  );
  await store.updateWorkPlanStep(plan.id, "research", {
    status: "completed",
    evidence: { kind: "research", verification: "source_checked", sha256: "a".repeat(64) },
  });
  await store.finishWorkPlan(plan.id, { success: true });
  const proposed = await store.proposeTimeReturn(plan.id, 10, "owner");
  assert.equal(proposed.returnedMinutes, 50);
  assert.equal(proposed.status, "proposed");
  const confirmed = await store.decideTimeReturn(proposed.id, "confirmed", "owner");
  assert.equal(confirmed.status, "confirmed");
  const preview = await store.previewPrivacyErasure({ projectId: manifest.projectId });
  assert.equal(preview.counts.timeReturns, 1);
  await store.erasePrivacyData(
    { projectId: manifest.projectId },
    preview.confirmation,
    "owner",
  );
  assert.equal((await store.listTimeReturns({ projectId: manifest.projectId })).length, 0);
});

integration("PostgreSQL 已确认影子时间返还并发导入幂等且随项目擦除", async (t) => {
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
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.importConfirmedShadowTimeReturn(proof, "owner")),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal((await store.listTimeReturns({ projectId: "shadow_project" })).length, 1);
  const reordered = await store.importConfirmedShadowTimeReturn({
    ...proof,
    outcomeEvidence: {
      steps: [{ sha256: "d".repeat(64), stepId: "research" }],
      kind: "confirmed_shadow_recipe_evidence",
    },
  }, "owner");
  assert.equal(reordered.created, false);
  await assert.rejects(
    store.importConfirmedShadowTimeReturn({ ...proof, humanActiveMinutes: 6 }, "owner"),
    /different facts/u,
  );
  const preview = await store.previewPrivacyErasure({ projectId: "shadow_project" });
  assert.equal(preview.counts.timeReturns, 1);
  await store.erasePrivacyData({ projectId: "shadow_project" }, preview.confirmation, "owner");
  assert.equal((await store.listTimeReturns({ projectId: "shadow_project" })).length, 0);
});

integration("PostgreSQL 同一私聊续发会原子废止旧草稿", async (t) => {
  const store = await fixture(t);
  const base = new Date("2026-08-17T10:00:00.000Z");
  const ingest = async (id, at, content) => store.ingestMessages([{
    id,
    senderUserId: "episode-user",
    senderName: "测试用户",
    conversationId: "episode-conversation",
    createTime: at.toISOString(),
    content,
  }], at);
  await ingest("pg-episode-first", base, "第一句");
  const [firstId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(base.getTime() + 10),
  });
  await store.claimTask({ now: new Date(base.getTime() + 20) });
  await store.completeDraft(firstId, {
    shouldReply: true,
    reply: "旧草稿",
    confidence: 0.8,
    riskLevel: "low",
    reason: "需要回复",
  }, new Date(base.getTime() + 30), { supersedeWindowMs: 120_000 });
  const followupAt = new Date(base.getTime() + 60_000);
  await ingest("pg-episode-followup", followupAt, "第二句");
  const [followupId] = await store.createReadyTasks({
    quietWindowMs: 1,
    now: new Date(followupAt.getTime() + 10),
  });
  await store.claimTask({ now: new Date(followupAt.getTime() + 20) });
  const result = await store.completeDraft(followupId, {
    shouldReply: true,
    reply: "合并后的新草稿",
    confidence: 0.9,
    riskLevel: "low",
    reason: "连续会话",
  }, new Date(followupAt.getTime() + 30), { supersedeWindowMs: 120_000 });
  assert.deepEqual(result, { status: "awaiting_approval", supersededTaskIds: [firstId] });
  assert.equal((await store.getTask(firstId)).status, "expired");
  assert.equal((await store.getTask(followupId)).status, "awaiting_approval");
});

integration("PostgreSQL 主动触发运行绑定实例并在隐私删除前要求停用", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T05:00:00.000Z");
  await store.createWorkTrigger({
    version: 1, id: "schedule-lease", projectId: "trigger_project",
    recipeId: "project-follow-up", requesterId: "owner", kind: "schedule",
    enabled: true, schedule: { startsAt: now.toISOString(), intervalMinutes: 60 },
    values: { projectFocus: "租约核对" },
  }, "owner", now);
  const schedule = await store.claimDueWorkTrigger(
    "schedule-worker",
    new Date(now.getTime() + 60_000),
    now,
  );
  const scheduleRunKey = "b".repeat(64);
  assert.equal(await store.reserveWorkTriggerRun(schedule.id, scheduleRunKey, "wrong-worker", now), false);
  assert.equal(await store.reserveWorkTriggerRun(schedule.id, scheduleRunKey, "schedule-worker", now), true);
  assert.equal(
    await store.failWorkTriggerRun(schedule.id, scheduleRunKey, "test", "schedule-worker", now),
    "failed",
  );
  const failedSchedule = await store.getWorkTrigger(schedule.id);
  assert.equal(failedSchedule.leaseOwner, null);
  assert.ok(new Date(failedSchedule.nextRunAt) > now);
  await store.setWorkTriggerEnabled(schedule.id, false, "owner", now);
  await store.createWorkTrigger({
    version: 1, id: "privacy-trigger", projectId: "trigger_project",
    recipeId: "project-follow-up", requesterId: "owner", kind: "event",
    enabled: true, event: { type: "meeting.ended" }, values: { projectFocus: "会议跟进" },
  }, "owner", now);
  const runKey = "a".repeat(64);
  assert.equal(await store.reserveWorkTriggerRun("privacy-trigger", runKey, "worker-a", now), true);
  await assert.rejects(
    store.failWorkTriggerRun("privacy-trigger", runKey, "wrong-owner", "worker-b", now),
    /not claimed/u,
  );
  assert.equal(await store.failWorkTriggerRun("privacy-trigger", runKey, "test", "worker-a", now), "failed");
  const blocked = await store.previewPrivacyErasure({ projectId: "trigger_project" }, new Date(now.getTime() + 1));
  assert.equal(blocked.blocked.workTriggers, 1);
  await store.setWorkTriggerEnabled("privacy-trigger", false, "owner", now);
  const preview = await store.previewPrivacyErasure({ projectId: "trigger_project" }, new Date(now.getTime() + 1));
  assert.equal(preview.counts.workTriggers, 2);
  await store.erasePrivacyData(
    { projectId: "trigger_project" }, preview.confirmation, "owner", new Date(now.getTime() + 1),
  );
  assert.equal(await store.getWorkTrigger("privacy-trigger"), null);
  assert.equal(await store.getWorkTrigger("schedule-lease"), null);
});

integration("PostgreSQL 主动计划在触发运行完成前不能消费授权", async (t) => {
  const store = await fixture(t);
  const now = new Date("2026-08-12T05:30:00.000Z");
  await store.createWorkTrigger({
    version: 1, id: "atomic-trigger", projectId: "trigger_project",
    recipeId: "project-follow-up", requesterId: "owner", kind: "event",
    enabled: true, event: { type: "meeting.ended" }, values: { projectFocus: "原子落账" },
  }, "owner", now);
  const runKey = "d".repeat(64);
  const assessment = assessWorkPlan({
    manifest: {
      version: 1, projectId: "trigger_project", name: "触发项目",
      rootDirectory: "/workspace/trigger", requesters: ["owner"],
      capabilities: { research: { mode: "automatic" } },
    },
    plan: {
      version: 1, projectId: "trigger_project", requesterId: "owner",
      recipe: {
        id: "project-follow-up", version: 1, baselineMinutes: 30,
        baselineMethod: "user_confirmed", triggerId: "atomic-trigger", triggerRunKey: runKey,
      },
      objective: "验证主动计划落账",
      steps: [{ id: "research", capability: "research", description: "核对", expectedEvidence: "证据" }],
    },
  });
  assert.equal(await store.reserveWorkTriggerRun("atomic-trigger", runKey, "worker-a", now), true);
  const plan = await store.registerWorkPlan(assessment, now);
  await assert.rejects(
    store.consumeWorkPlanAuthorization(plan.id, now),
    /triggered work plan run is not completed/ui,
  );
  await store.completeWorkTriggerRun("atomic-trigger", runKey, plan.id, "worker-a", now);
  assert.equal(await store.consumeWorkPlanAuthorization(plan.id, now), true);
});

integration("PostgreSQL 项目记忆候选绑定计划来源并保持幂等", async (t) => {
  const store = await fixture(t);
  const manifest = {
    version: 1, projectId: "memory_project", name: "项目记忆",
    rootDirectory: "/workspace/memory", requesters: ["owner"],
    profile: {
      objective: "形成决策", successCriteria: [], milestones: [], collaborationObjects: [],
      selectedRecipeIds: ["meeting-follow-up"],
      memoryScope: { allowedTypes: ["project"], retentionDays: 90 },
    },
    capabilities: { research: { mode: "automatic" } },
  };
  const plan = await store.registerWorkPlan(assessWorkPlan({
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
  await store.updateWorkPlanStep(plan.id, "research", {
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
  const first = await store.proposeWorkPlanMemory(input, new Date("2026-08-12T00:00:00.000Z"));
  const second = await store.proposeWorkPlanMemory(input, new Date("2026-08-12T00:01:00.000Z"));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  await assert.rejects(
    store.proposeWorkPlanMemory({
      ...input,
      scope: { ...input.scope, evidenceSha256: "f".repeat(64) },
    }),
    /evidence is not verifiable/u,
  );
  const personPreview = await store.previewPrivacyErasure({ personId: "owner" });
  assert.equal(personPreview.counts.memories, 1);
  assert.equal(await store.confirmMemory(first.id, "owner", new Date("2026-08-12T00:02:00.000Z")), "confirmed");
});

integration("PostgreSQL 受治理工作图并发追加保持幂等且查询固定租户项目", async (t) => {
  const store = await fixture(t);
  const graph = graphFixture(store.tenantId);
  const results = await Promise.all([
    store.appendGraphProjection(graph),
    store.appendGraphProjection(graph),
  ]);
  assert.equal(results.reduce((sum, value) => sum + value.insertedNodes, 0), 2);
  assert.equal(results.reduce((sum, value) => sum + value.insertedEdges, 0), 1);
  const nodes = await store.listGraphNodes({ projectId: "graph_project" });
  const edges = await store.listGraphEdges({
    projectId: "graph_project", edgeType: "authorization.permits_step",
  });
  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);
  const raw = await store.pool.query(
    `SELECT payload_ciphertext FROM governed_graph_edges
     WHERE tenant_id = $1 LIMIT 1`,
    [store.tenantId],
  );
  assert.match(raw.rows[0].payload_ciphertext, /^enc:v1:/u);
  assert.equal((await store.listGraphNodes({ projectId: "other" })).length, 0);
  await assert.rejects(
    store.appendGraphProjection(graphFixture("wrong-tenant")),
    /tenant does not match/u,
  );
});
