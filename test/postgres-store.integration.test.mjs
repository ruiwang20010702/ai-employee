import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { migrate } from "../src/migrate.mjs";
import { createPostgresPool } from "../src/postgres.mjs";
import { PostgresStore } from "../src/postgres-store.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

function config(tenantId) {
  return {
    databaseUrl,
    databasePoolMax: 5,
    databaseSsl: false,
    dataKey: Buffer.alloc(32, 7).toString("base64"),
    tenantId,
  };
}

async function fixture(t) {
  const tenantId = `test-${randomUUID()}`;
  const settings = config(tenantId);
  const pool = createPostgresPool(settings);
  await migrate(pool);
  const store = await new PostgresStore(settings, { pool }).open();
  t.after(async () => {
    await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM checkpoints WHERE tenant_id = $1", [tenantId]);
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
