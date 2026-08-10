import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DataCipher } from "../src/crypto.mjs";
import { listExpectedMigrations } from "../src/migration-status.mjs";
import { migrate } from "../src/migrate.mjs";
import { createPostgresPool } from "../src/postgres.mjs";
import { PostgresStore } from "../src/postgres-store.mjs";
import {
  assertServiceRollbackState,
  inspectServiceRollbackState,
} from "../src/rollback-state-guard.mjs";
import { assessWorkPlan } from "../src/work-plan.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

function poolConfig(connectionString) {
  return {
    databaseUrl: connectionString,
    databasePoolMax: 2,
    databaseSsl: false,
  };
}

async function isolatedSchema(t) {
  const schema = `migration_018_${randomUUID().replaceAll("-", "")}`;
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
  return { pool, schema, scopedDatabaseUrl: scopedUrl.toString() };
}

async function migrationSets() {
  const migrations = await listExpectedMigrations();
  const migration018 = migrations.find((item) =>
    item.version.startsWith("018_能力次数预算.sql"));
  assert.ok(migration018, "第 018 号迁移必须存在");
  return {
    through017: migrations.filter((item) =>
      Number.parseInt(item.version.slice(0, 3), 10) <= 17),
    migration018,
  };
}

async function insertLegacyPlan(pool, status) {
  const id = `legacy-${status}`;
  await pool.query(
    `INSERT INTO work_plans(
       id, tenant_id, project_id, requester_key, requester_ciphertext,
       objective_ciphertext, plan_ciphertext, plan_hash, max_level,
       policy_decision, status
     ) VALUES (
       $1, 'migration-test', 'project', 'requester', 'ciphertext',
       'ciphertext', 'ciphertext', $2, 'L1', 'ALLOW', $3
     )`,
    [id, `hash-${status}`, status],
  );
  await pool.query(
    `INSERT INTO work_plan_steps(
       tenant_id, work_plan_id, step_id, position, capability, status
     ) VALUES ('migration-test', $1, 'step', 0, 'research', 'pending')`,
    [id],
  );
  return id;
}

function assessedApprovalPlan(description) {
  const manifest = {
    version: 1,
    projectId: "migration_018_project",
    name: "迁移恢复测试项目",
    rootDirectory: "/workspace/migration-018",
    requesters: ["requester"],
    capabilities: {
      code_patch: { mode: "approval_required", maxRuns: 2 },
    },
  };
  return assessWorkPlan({
    manifest,
    plan: {
      version: 1,
      projectId: manifest.projectId,
      requesterId: "requester",
      objective: "安全恢复旧计划",
      steps: [{
        id: "patch",
        capability: "code_patch",
        description,
        workingDirectory: manifest.rootDirectory,
        expectedEvidence: "代码差异和测试结果",
      }],
    },
  });
}

async function insertRestorableLegacyPlan(pool, assessment) {
  const id = `plan_${assessment.planHash.slice(0, 24)}`;
  const createdAt = new Date("2026-08-10T08:00:00.000Z");
  await pool.query(
    `INSERT INTO work_plans(
       id, tenant_id, project_id, requester_key, requester_ciphertext,
       objective_ciphertext, plan_ciphertext, plan_hash, max_level,
       policy_decision, status, approval_version, created_at, updated_at
     ) VALUES (
       $1, 'migration-reregister', $2, 'legacy-requester', 'legacy-ciphertext',
       'legacy-ciphertext', 'legacy-ciphertext', $3, $4,
       $5, 'approved', 1, $6, $6
     )`,
    [
      id,
      assessment.plan.projectId,
      assessment.planHash,
      assessment.maxLevel,
      assessment.decision,
      createdAt,
    ],
  );
  await pool.query(
    `INSERT INTO work_plan_approvals(
       id, tenant_id, work_plan_id, plan_hash, approval_version,
       decision, actor, reason_ciphertext, expires_at,
       max_consumptions, consumed, created_at
     ) VALUES (
       'legacy-approval', 'migration-reregister', $1, $2, 1,
       'approved', 'legacy-approver', 'legacy-ciphertext', $3,
       1, 0, $4
     )`,
    [id, assessment.planHash, new Date("2099-01-01T00:00:00.000Z"), createdAt],
  );
  await pool.query(
    `INSERT INTO work_plan_steps(
       tenant_id, work_plan_id, step_id, position, capability, status,
       evidence_ciphertext, error_ciphertext, started_at, updated_at
     ) VALUES (
       'migration-reregister', $1, 'patch', 0, 'code_patch', 'pending',
       'legacy-evidence', 'legacy-error', $2, $2
     )`,
    [id, createdAt],
  );
  return id;
}

integration("第018号迁移安全取消无法绑定预算的未执行旧计划", async (t) => {
  const { pool } = await isolatedSchema(t);
  const { through017, migration018 } = await migrationSets();
  await migrate(pool, { migrationLoader: async () => through017 });
  const ids = await Promise.all([
    insertLegacyPlan(pool, "ready"),
    insertLegacyPlan(pool, "awaiting_approval"),
    insertLegacyPlan(pool, "approved"),
  ]);

  assert.deepEqual(
    await migrate(pool, { migrationLoader: async () => [migration018] }),
    [migration018.version],
  );
  const plans = await pool.query(
    `SELECT id, status, cancel_requested_by, authorization_hash,
            capability_budget_ciphertext
     FROM work_plans WHERE tenant_id = 'migration-test' ORDER BY id`,
  );
  assert.deepEqual(plans.rows.map((row) => ({
    id: row.id,
    status: row.status,
    actor: row.cancel_requested_by,
    authorizationHash: row.authorization_hash,
    budget: row.capability_budget_ciphertext,
  })), ids.sort().map((id) => ({
    id,
    status: "cancelled",
    actor: "system:migration-018",
    authorizationHash: null,
    budget: null,
  })));
  const steps = await pool.query(
    `SELECT status, completed_at FROM work_plan_steps
     WHERE tenant_id = 'migration-test'`,
  );
  assert.equal(steps.rows.every((row) =>
    row.status === "cancelled" && row.completed_at instanceof Date), true);
});

integration("第018号迁移后数据库拒绝旧执行器写入无预算可执行计划", async (t) => {
  const { pool } = await isolatedSchema(t);
  const { through017, migration018 } = await migrationSets();
  await migrate(pool, { migrationLoader: async () => [
    ...through017,
    migration018,
  ] });

  await assert.rejects(
    pool.query(
      `INSERT INTO work_plans(
         id, tenant_id, project_id, requester_key, requester_ciphertext,
         objective_ciphertext, plan_ciphertext, plan_hash, max_level,
         policy_decision, status
       ) VALUES (
         'old-executor-insert', 'migration-guard', 'project', 'requester',
         'ciphertext', 'ciphertext', 'ciphertext', 'old-executor-insert-hash',
         'L1', 'ALLOW', 'ready'
       )`,
    ),
    (error) =>
      error.code === "23514" &&
      error.constraint === "work_plans_capability_budget_required_check",
  );

  await pool.query(
    `INSERT INTO work_plans(
       id, tenant_id, project_id, requester_key, requester_ciphertext,
       objective_ciphertext, plan_ciphertext, plan_hash, max_level,
       policy_decision, status
     ) VALUES (
       'historical-cancelled', 'migration-guard', 'project', 'requester',
       'ciphertext', 'ciphertext', 'ciphertext', 'historical-cancelled-hash',
       'L1', 'ALLOW', 'cancelled'
     )`,
  );
  await assert.rejects(
    pool.query(
      "UPDATE work_plans SET status = 'approved' WHERE id = 'historical-cancelled'",
    ),
    (error) =>
      error.code === "23514" &&
      error.constraint === "work_plans_capability_budget_required_check",
  );
  assert.equal(
    (await pool.query(
      "SELECT status FROM work_plans WHERE id = 'historical-cancelled'",
    )).rows[0].status,
    "cancelled",
  );
});

integration("服务回退在数据库已应用018时要求目标服务支持持久预算", async (t) => {
  const { pool } = await isolatedSchema(t);
  const { through017, migration018 } = await migrationSets();
  await migrate(pool, { migrationLoader: async () => [
    ...through017,
    migration018,
  ] });

  const unsupported = await inspectServiceRollbackState(pool, {
    targetSupportsContinuation: true,
    targetSupportsCapabilityBudget: false,
  });
  assert.equal(unsupported.compatible, false);
  assert.equal(unsupported.capabilityBudgetMigrationPresent, true);
  assert.throws(
    () => assertServiceRollbackState(unsupported),
    { code: "service_rollback_capability_budget_unsupported" },
  );

  const supported = await inspectServiceRollbackState(pool, {
    targetSupportsContinuation: true,
    targetSupportsCapabilityBudget: true,
  });
  assert.equal(supported.compatible, true);
  assert.equal(assertServiceRollbackState(supported), supported);
});

integration("第018号迁移取消的旧计划可用同哈希重新登记且不复用旧审批", async (t) => {
  const { pool, scopedDatabaseUrl } = await isolatedSchema(t);
  const { through017, migration018 } = await migrationSets();
  await migrate(pool, { migrationLoader: async () => through017 });
  const assessment = assessedApprovalPlan("恢复 migration-018 取消的旧计划");
  const id = await insertRestorableLegacyPlan(pool, assessment);

  await migrate(pool, { migrationLoader: async () => [migration018] });
  const migrated = await pool.query(
    `SELECT status, approval_version, cancel_requested_by,
            authorization_hash, capability_budget_ciphertext
     FROM work_plans
     WHERE tenant_id = 'migration-reregister' AND id = $1`,
    [id],
  );
  assert.deepEqual(migrated.rows[0], {
    status: "cancelled",
    approval_version: 1,
    cancel_requested_by: "system:migration-018",
    authorization_hash: null,
    capability_budget_ciphertext: null,
  });

  const store = new PostgresStore({
    databaseUrl: scopedDatabaseUrl,
    databasePoolMax: 2,
    databaseSsl: false,
    dataKey: Buffer.alloc(32, 18).toString("base64"),
    tenantId: "migration-reregister",
  }, { pool });
  store.cipher = new DataCipher(Buffer.alloc(32, 18));
  const restoredAt = new Date("2026-08-10T10:00:00.000Z");
  const restored = await store.registerWorkPlan(assessment, restoredAt);
  assert.equal(restored.id, id);
  assert.equal(restored.status, "awaiting_approval");
  assert.equal(restored.project_id, assessment.plan.projectId);
  assert.equal(restored.objective, assessment.plan.objective);
  assert.deepEqual(restored.plan, assessment.plan);
  assert.equal(restored.authorization_hash, assessment.authorizationHash);
  assert.deepEqual(restored.capability_budget, assessment.capabilityBudget);
  assert.equal(restored.approval_version, 2);
  assert.equal(restored.cancel_requested_at, null);
  assert.equal(restored.cancel_requested_by, null);
  const [restoredStep] = await store.listWorkPlanSteps(id);
  assert.equal(restoredStep.status, "pending");
  assert.equal(restoredStep.evidence, null);
  assert.equal(restoredStep.error, null);
  assert.equal(restoredStep.started_at, null);
  assert.equal(restoredStep.completed_at, null);

  await assert.rejects(
    store.consumeWorkPlanAuthorization(
      id,
      new Date(restoredAt.getTime() + 1_000),
    ),
    /not authorized/u,
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT approval_version, consumed
       FROM work_plan_approvals
       WHERE tenant_id = 'migration-reregister' AND work_plan_id = $1
       ORDER BY approval_version`,
      [id],
    )).rows,
    [{ approval_version: 1, consumed: 0 }],
  );
  await store.decideWorkPlan(id, {
    decision: "approved",
    actor: "new-approver",
  }, new Date(restoredAt.getTime() + 2_000));
  assert.equal(
    await store.consumeWorkPlanAuthorization(
      id,
      new Date(restoredAt.getTime() + 3_000),
    ),
    true,
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT approval_version, consumed
       FROM work_plan_approvals
       WHERE tenant_id = 'migration-reregister' AND work_plan_id = $1
       ORDER BY approval_version`,
      [id],
    )).rows,
    [
      { approval_version: 1, consumed: 0 },
      { approval_version: 2, consumed: 1 },
    ],
  );

  const ordinaryAssessment = assessedApprovalPlan("普通取消计划不得恢复");
  const ordinary = await store.registerWorkPlan(
    ordinaryAssessment,
    new Date(restoredAt.getTime() + 4_000),
  );
  await store.requestWorkPlanCancellation(
    ordinary.id,
    "operator",
    new Date(restoredAt.getTime() + 5_000),
  );
  const ordinaryDuplicate = await store.registerWorkPlan(
    ordinaryAssessment,
    new Date(restoredAt.getTime() + 6_000),
  );
  assert.equal(ordinaryDuplicate.status, "cancelled");
  assert.equal(ordinaryDuplicate.approval_version, 1);
  assert.equal(ordinaryDuplicate.cancel_requested_by, "operator");

  await pool.query(
    `UPDATE work_plans SET cancel_requested_by = 'system:migration-018'
     WHERE tenant_id = 'migration-reregister' AND id = $1`,
    [ordinary.id],
  );
  const boundDuplicate = await store.registerWorkPlan(
    ordinaryAssessment,
    new Date(restoredAt.getTime() + 7_000),
  );
  assert.equal(boundDuplicate.status, "cancelled");
  assert.equal(boundDuplicate.approval_version, 1);
  assert.equal(boundDuplicate.authorization_hash, ordinaryAssessment.authorizationHash);
  assert.deepEqual(boundDuplicate.capability_budget, ordinaryAssessment.capabilityBudget);
});

integration("第018号迁移发现执行中旧计划时整体回滚", async (t) => {
  const { pool, schema } = await isolatedSchema(t);
  const { through017, migration018 } = await migrationSets();
  await migrate(pool, { migrationLoader: async () => through017 });
  const id = await insertLegacyPlan(pool, "executing");

  await assert.rejects(
    migrate(pool, { migrationLoader: async () => [migration018] }),
    /legacy work plans are executing/u,
  );
  const columns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'work_plans'
       AND column_name IN ('authorization_hash', 'capability_budget_ciphertext')`,
    [schema],
  );
  assert.equal(columns.rowCount, 0);
  assert.equal(
    (await pool.query("SELECT status FROM work_plans WHERE id = $1", [id]))
      .rows[0].status,
    "executing",
  );
  assert.equal(
    (await pool.query(
      "SELECT COUNT(*)::int AS count FROM schema_migrations WHERE version = $1",
      [migration018.version],
    )).rows[0].count,
    0,
  );
});
