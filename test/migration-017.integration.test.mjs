import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { listExpectedMigrations } from "../src/migration-status.mjs";
import { migrate } from "../src/migrate.mjs";
import { createPostgresPool } from "../src/postgres.mjs";
import { inspectServiceRollbackState } from "../src/rollback-state-guard.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

function poolConfig(connectionString) {
  return {
    databaseUrl: connectionString,
    databasePoolMax: 2,
    databaseSsl: false,
  };
}

async function isolatedMigrationSchema(t) {
  const schema = `migration_017_${randomUUID().replaceAll("-", "")}`;
  const admin = createPostgresPool(poolConfig(databaseUrl));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const pool = createPostgresPool(poolConfig(scopedUrl.toString()));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  return { pool, schema };
}

async function migrationSets() {
  const migrations = await listExpectedMigrations();
  const migration017 = migrations.find((item) =>
    item.version.startsWith("017_等待信息任务链.sql"));
  assert.ok(migration017, "第 017 号迁移必须存在");
  return {
    through016: migrations.filter((item) =>
      Number.parseInt(item.version.slice(0, 3), 10) <= 16),
    migration017,
  };
}

async function insertTask(pool, {
  id,
  status,
  continuationOfTaskId = null,
  migration017Applied = false,
}) {
  const columns = migration017Applied
    ? ", continuation_of_task_id"
    : "";
  const values = migration017Applied ? ", $4" : "";
  const parameters = [id, status, new Date("2026-08-10T08:00:00.000Z")];
  if (migration017Applied) parameters.push(continuationOfTaskId);
  await pool.query(
    `INSERT INTO tasks(
       id, tenant_id, kind, status, sender_key,
       sender_user_id_ciphertext, conversation_key,
       conversation_id_ciphertext, payload_ciphertext,
       available_at${columns}
     ) VALUES (
       $1, 'migration-test', 'reply', $2, 'sender-key',
       'ciphertext', 'conversation-key', 'ciphertext', 'ciphertext',
       $3${values}
     )`,
    parameters,
  );
}

integration("第017号迁移从有数据的016安全升级并保留全部旧状态", async (t) => {
  const { pool, schema } = await isolatedMigrationSchema(t);
  const { through016, migration017 } = await migrationSets();
  assert.equal(through016.length, 16);
  await migrate(pool, { migrationLoader: async () => through016 });

  const legacyStatuses = [
    "queued",
    "processing",
    "awaiting_approval",
    "no_reply",
    "approved",
    "rejected",
    "sending",
    "completed",
    "send_unknown",
    "cancelled_manual",
    "cancelled_operator",
    "expired",
    "dead",
  ];
  for (const [index, status] of legacyStatuses.entries()) {
    await insertTask(pool, { id: `legacy-${index}`, status });
  }

  assert.deepEqual(
    await migrate(pool, { migrationLoader: async () => [migration017] }),
    [migration017.version],
  );
  const preserved = await pool.query(
    "SELECT status FROM tasks WHERE tenant_id = 'migration-test' ORDER BY id",
  );
  assert.equal(preserved.rowCount, legacyStatuses.length);
  assert.deepEqual(
    [...new Set(preserved.rows.map((row) => row.status))].sort(),
    [...legacyStatuses].sort(),
  );

  const columns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'tasks'
       AND column_name IN ('continuation_of_task_id', 'waiting_information_at')
     ORDER BY column_name`,
    [schema],
  );
  assert.deepEqual(
    columns.rows.map((row) => row.column_name),
    ["continuation_of_task_id", "waiting_information_at"],
  );
  const indexes = await pool.query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = $1
       AND indexname IN ('tasks_waiting_information_idx', 'tasks_continuation_of_idx')
     ORDER BY indexname`,
    [schema],
  );
  assert.deepEqual(
    indexes.rows.map((row) => row.indexname),
    ["tasks_continuation_of_idx", "tasks_waiting_information_idx"],
  );
  const foreignKey = await pool.query(
    `SELECT constraint_type
     FROM information_schema.table_constraints
     WHERE constraint_schema = $1 AND table_name = 'tasks'
       AND constraint_name = 'tasks_continuation_task_fk'`,
    [schema],
  );
  assert.deepEqual(foreignKey.rows, [{ constraint_type: "FOREIGN KEY" }]);

  await insertTask(pool, {
    id: "new-waiting",
    status: "waiting_information",
    migration017Applied: true,
  });
  await insertTask(pool, {
    id: "new-pending",
    status: "continuation_pending",
    continuationOfTaskId: "new-waiting",
    migration017Applied: true,
  });
  await assert.rejects(
    pool.query(
      `INSERT INTO tasks(
         id, tenant_id, kind, status, sender_key,
         sender_user_id_ciphertext, conversation_key,
         conversation_id_ciphertext, payload_ciphertext,
         available_at, continuation_of_task_id
       ) VALUES (
         'cross-tenant-child', 'other-tenant', 'reply', 'queued', 'sender-key',
         'ciphertext', 'conversation-key', 'ciphertext', 'ciphertext',
         $1, 'new-waiting'
       )`,
      [new Date("2026-08-10T08:00:00.000Z")],
    ),
    (error) => error.code === "23503",
  );
  await insertTask(pool, {
    id: "new-continued",
    status: "continued",
    migration017Applied: true,
  });
  await pool.query("DELETE FROM tasks WHERE id = 'new-waiting'");
  assert.equal(
    (await pool.query(
      "SELECT continuation_of_task_id FROM tasks WHERE id = 'new-pending'",
    )).rows[0].continuation_of_task_id,
    null,
  );
  assert.equal(
    (await pool.query("SELECT COUNT(*)::int AS count FROM schema_migrations")).rows[0]
      .count,
    17,
  );
});

integration("第017号迁移中途失败会回滚结构和迁移登记", async (t) => {
  const { pool, schema } = await isolatedMigrationSchema(t);
  const { through016, migration017 } = await migrationSets();
  await migrate(pool, { migrationLoader: async () => through016 });
  await insertTask(pool, { id: "legacy-before-failure", status: "queued" });

  await assert.rejects(
    migrate(pool, {
      migrationLoader: async () => [{
        ...migration017,
        checksum: "intentional-failure-checksum",
        content: `${migration017.content}\nSELECT * FROM migration_017_forced_failure;`,
      }],
    }),
    (error) => error.code === "42P01",
  );
  const columns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'tasks'
       AND column_name IN ('continuation_of_task_id', 'waiting_information_at')`,
    [schema],
  );
  assert.equal(columns.rowCount, 0);
  const indexes = await pool.query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = $1
       AND indexname IN ('tasks_waiting_information_idx', 'tasks_continuation_of_idx')`,
    [schema],
  );
  assert.equal(indexes.rowCount, 0);
  assert.equal(
    (await pool.query(
      "SELECT COUNT(*)::int AS count FROM schema_migrations WHERE version = $1",
      [migration017.version],
    )).rows[0].count,
    0,
  );
  assert.equal(
    (await pool.query(
      "SELECT COUNT(*)::int AS count FROM tasks WHERE id = 'legacy-before-failure'",
    )).rows[0].count,
    1,
  );
  await assert.rejects(
    insertTask(pool, {
      id: "new-state-after-rollback",
      status: "waiting_information",
    }),
    (error) => error.code === "23514",
  );
});

integration("服务回退只阻止活动等待链而不阻止历史终态链", async (t) => {
  const { pool } = await isolatedMigrationSchema(t);
  const { through016, migration017 } = await migrationSets();
  await migrate(pool, { migrationLoader: async () => [
    ...through016,
    migration017,
  ] });
  await insertTask(pool, {
    id: "terminal-parent",
    status: "continued",
    migration017Applied: true,
  });
  await insertTask(pool, {
    id: "terminal-child",
    status: "completed",
    continuationOfTaskId: "terminal-parent",
    migration017Applied: true,
  });
  assert.deepEqual(await inspectServiceRollbackState(pool), {
    compatible: true,
    activeContinuationTasks: 0,
    migrationPresent: true,
    capabilityBudgetMigrationPresent: false,
    targetSupportsContinuation: false,
    targetSupportsCapabilityBudget: false,
  });

  await insertTask(pool, {
    id: "active-child",
    status: "queued",
    continuationOfTaskId: "terminal-parent",
    migration017Applied: true,
  });
  assert.deepEqual(await inspectServiceRollbackState(pool), {
    compatible: false,
    activeContinuationTasks: 1,
    migrationPresent: true,
    capabilityBudgetMigrationPresent: false,
    targetSupportsContinuation: false,
    targetSupportsCapabilityBudget: false,
  });
});
