import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCapabilityBudgetPersistenceRejection,
  assertLegacyCompatibilityBoundary,
  assertPostGuardBaseline,
  assertRollbackBaselineObject,
  buildRollbackVerificationPlan,
  countForwardMigrationFiles,
  rollbackOutcome,
  validateRollbackManifest,
  validateRollbackTestUrl,
  verifyServiceRollbackGuardEvidence,
  withTemporaryRollbackDatabase,
} from "../src/rollback-compatibility.mjs";

test("服务回退只读取清单登记的完整提交对象", () => {
  const calls = [];
  assertRollbackBaselineObject({
    root: "/repo",
    commit: "a".repeat(40),
    runner(command, args, options) {
      calls.push({ command, args, options });
    },
  });
  assert.deepEqual(calls, [{
    command: "git",
    args: ["cat-file", "-e", `${"a".repeat(40)}^{commit}`],
    options: { cwd: "/repo" },
  }]);
});

test("服务回退演练只允许本机明确命名的测试数据库", () => {
  assert.equal(
    validateRollbackTestUrl("postgresql://postgres:test@localhost:5432/ai_employee_test"),
    "postgresql://postgres:test@localhost:5432/ai_employee_test",
  );
  for (const value of [
    "postgresql://prod.example.com/ai_employee_test",
    "postgresql://localhost/ai_employee",
    "mysql://localhost/ai_employee_test",
  ]) {
    assert.throws(() => validateRollbackTestUrl(value), /回退演练/u);
  }
});

test("服务回退演练拒绝查询参数覆盖连接目标和URL片段", () => {
  for (const suffix of [
    "?host=prod.example.com",
    "?hostaddr=203.0.113.10",
    "?port=5433",
    "?dbname=production",
    "?options=-c%20search_path%3Dproduction",
    "?sslmode=require",
    "?",
    "#host=prod.example.com",
    "#",
  ]) {
    assert.throws(
      () => validateRollbackTestUrl(
        `postgresql://postgres:test@localhost:5432/ai_employee_test${suffix}`,
      ),
      /不允许查询参数或片段/u,
    );
  }
});

test("服务回退基线使用零分隔文件名统计中文迁移", () => {
  assert.equal(
    countForwardMigrationFiles(
      "db/migrations/001_基础.sql\0db/migrations/001_基础.undo.sql\0" +
        "db/migrations/002_中文.sql\0",
    ),
    2,
  );
});

test("服务回退基线绑定完整提交、迁移数量和固定测试入口", () => {
  const manifest = {
    schemaVersion: "ai-employee-rollback-baseline/v1",
    commit: "a".repeat(40),
    expectedMigrations: 14,
    testFile: "test/postgres-store.integration.test.mjs",
    reason: "迁移前兼容基线",
  };
  assert.equal(validateRollbackManifest(manifest), manifest);
  assert.equal(validateRollbackManifest({
    ...manifest,
    postGuardBaseline: {
      commit: "b".repeat(40),
      expectedMigrations: 18,
      testFile: manifest.testFile,
      reason: "状态门禁后生产基线",
    },
  }).postGuardBaseline.expectedMigrations, 18);
  assert.throws(
    () => validateRollbackManifest({ ...manifest, commit: "abc" }),
    /完整 SHA/u,
  );
  assert.throws(
    () => validateRollbackManifest({ ...manifest, testFile: "test/other.test.mjs" }),
    /不受支持/u,
  );
  assert.throws(
    () => validateRollbackManifest({
      ...manifest,
      postGuardBaseline: {
        commit: "b".repeat(40),
        expectedMigrations: 14,
        testFile: manifest.testFile,
        reason: "无效顺序",
      },
    }),
    /必须晚于/u,
  );
});

test("状态门禁后回退基线必须精确包含017和018", () => {
  const files = Array.from({ length: 18 }, (_, index) =>
    `db/migrations/${String(index + 1).padStart(3, "0")}_${
      index === 16 ? "等待信息任务链" : index === 17 ? "能力次数预算" : "迁移"
    }.sql`
  );
  assert.equal(assertPostGuardBaseline({
    baselineMigrationFiles: files,
    expectedMigrations: 18,
  }).length, 18);
  assert.throws(
    () => assertPostGuardBaseline({
      baselineMigrationFiles: files.slice(0, 17),
      expectedMigrations: 18,
    }),
    /精确支持/u,
  );
});

test("普通兼容迁移保留旧服务全量测试，状态门禁迁移进入独立验证", () => {
  const migrations = [
    "014_基线.sql",
    "015_记忆来源访问租约.sql",
    "016_隐私擦除墓碑.sql",
    "017_等待信息任务链.sql",
    "018_能力次数预算.sql",
  ].map((version) => ({ version, content: "", checksum: version }));
  const compatibilityPolicy = {
    migrations: {
      "015_记忆来源访问租约.sql": { rollback: "service_only" },
      "016_隐私擦除墓碑.sql": { rollback: "service_only" },
      "017_等待信息任务链.sql": {
        rollback: "service_only_with_state_guard",
        guard: "waiting_information_states_absent",
      },
      "018_能力次数预算.sql": {
        rollback: "service_only_with_state_guard",
        guard: "capability_budget_target_support_required",
      },
    },
  };

  const plan = buildRollbackVerificationPlan({
    migrations,
    baselineMigrationFiles: ["db/migrations/014_基线.sql"],
    compatibilityPolicy,
  });

  assert.deepEqual(
    plan.legacyTestMigrations.map((migration) => migration.version),
    [
      "014_基线.sql",
      "015_记忆来源访问租约.sql",
      "016_隐私擦除墓碑.sql",
    ],
  );
  assert.deepEqual(plan.guardedMigrations, [
    {
      version: "017_等待信息任务链.sql",
      guard: "waiting_information_states_absent",
    },
    {
      version: "018_能力次数预算.sql",
      guard: "capability_budget_target_support_required",
    },
  ]);
  assert.equal(plan.targetSupportsCapabilityBudget, false);
  assert.equal(plan.requiresCapabilityBudgetPersistenceProbe, true);
});

test("旧服务全量测试严格停在普通兼容迁移边界", () => {
  const verificationPlan = {
    legacyTestMigrations: Array.from({ length: 16 }, (_, index) => ({
      version: `${String(index + 1).padStart(3, "0")}_迁移.sql`,
    })),
    guardedMigrations: [
      { version: "017_等待信息任务链.sql" },
      { version: "018_能力次数预算.sql" },
    ],
  };
  const status = {
    tablePresent: true,
    applied: 16,
    pending: ["017_等待信息任务链.sql", "018_能力次数预算.sql"],
    unexpected: [],
  };
  assert.equal(
    assertLegacyCompatibilityBoundary(status, verificationPlan),
    status,
  );
  for (const invalid of [
    { ...status, applied: 15 },
    { ...status, pending: ["018_能力次数预算.sql"] },
    { ...status, unexpected: ["999_意外.sql"] },
  ]) {
    assert.throws(
      () => assertLegacyCompatibilityBoundary(invalid, verificationPlan),
      /迁移阶段边界无效/u,
    );
  }
});

test("状态门禁之后出现普通兼容迁移时拒绝丢失旧服务证据", () => {
  const migrations = [
    { version: "014_基线.sql" },
    { version: "017_等待信息任务链.sql" },
    { version: "019_普通迁移.sql" },
  ];
  assert.throws(
    () => buildRollbackVerificationPlan({
      migrations,
      baselineMigrationFiles: ["db/migrations/014_基线.sql"],
      compatibilityPolicy: {
        migrations: {
          "017_等待信息任务链.sql": {
            rollback: "service_only_with_state_guard",
            guard: "waiting_information_states_absent",
          },
          "019_普通迁移.sql": { rollback: "service_only" },
        },
      },
    }),
    /无法保留独立旧服务证据/u,
  );
});

test("第018号持久门禁只接受固定约束的23514拒绝", () => {
  assert.deepEqual(
    assertCapabilityBudgetPersistenceRejection({
      code: "23514",
      constraint: "work_plans_capability_budget_required_check",
    }),
    {
      verified: true,
      errorCode: "23514",
      constraint: "work_plans_capability_budget_required_check",
    },
  );
  for (const error of [
    undefined,
    { code: "23514", constraint: "unrelated_check" },
    { code: "23505", constraint: "work_plans_capability_budget_required_check" },
  ]) {
    assert.throws(
      () => assertCapabilityBudgetPersistenceRejection(error),
      /持久预算约束未按预期拒绝/u,
    );
  }
});

test("不支持018的目标必须被服务回退门禁以固定错误码拒绝", () => {
  const rejectedState = {
    compatible: false,
    activeContinuationTasks: 0,
    migrationPresent: true,
    capabilityBudgetMigrationPresent: true,
    targetSupportsContinuation: false,
    targetSupportsCapabilityBudget: false,
  };
  assert.deepEqual(
    verifyServiceRollbackGuardEvidence(rejectedState, {
      expectedRejectionCode: "service_rollback_capability_budget_unsupported",
    }),
    {
      verified: true,
      rollbackAllowed: false,
      errorCode: "service_rollback_capability_budget_unsupported",
    },
  );

  assert.throws(
    () => verifyServiceRollbackGuardEvidence({
      ...rejectedState,
      compatible: true,
      targetSupportsCapabilityBudget: true,
    }, {
      expectedRejectionCode: "service_rollback_capability_budget_unsupported",
    }),
    /未按预期拒绝目标/u,
  );
  assert.throws(
    () => verifyServiceRollbackGuardEvidence({
      ...rejectedState,
      capabilityBudgetMigrationPresent: false,
      activeContinuationTasks: 1,
    }, {
      expectedRejectionCode: "service_rollback_capability_budget_unsupported",
    }),
    /未按预期拒绝目标/u,
  );
});

test("第017号状态门禁通过时保留明确的允许证据", () => {
  assert.deepEqual(
    verifyServiceRollbackGuardEvidence({
      compatible: true,
      activeContinuationTasks: 0,
      migrationPresent: true,
      capabilityBudgetMigrationPresent: false,
      targetSupportsContinuation: false,
      targetSupportsCapabilityBudget: false,
    }),
    {
      verified: true,
      rollbackAllowed: true,
      errorCode: null,
    },
  );
});

test("验证通过与目标实际可回退使用不同结果字段", () => {
  assert.equal(rollbackOutcome(true), "allowed");
  assert.equal(rollbackOutcome(false), "blocked_as_designed");
});

test("顶层演练中途失败仍关闭目标连接并删除临时数据库", async () => {
  const events = [];
  const primaryError = new Error("阶段验证失败");
  const databaseName = `ai_employee_rollback_test_${"a".repeat(32)}`;
  const adminPool = {
    async query(sql) {
      events.push(sql);
    },
    async end() {
      events.push("admin:end");
    },
  };
  const targetPool = {
    async end() {
      events.push("target:end");
    },
  };
  let pools = 0;

  await assert.rejects(
    withTemporaryRollbackDatabase({
      databaseUrl: "postgresql://postgres:test@localhost:5432/ai_employee_test",
      databaseName,
      createPool() {
        pools += 1;
        return pools === 1 ? adminPool : targetPool;
      },
      async operation({ databaseUrl }) {
        assert.equal(new URL(databaseUrl).pathname, `/${databaseName}`);
        events.push("operation");
        throw primaryError;
      },
    }),
    (error) => error === primaryError,
  );
  assert.deepEqual(events, [
    `CREATE DATABASE "${databaseName}"`,
    "operation",
    "target:end",
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    "admin:end",
  ]);
});

test("主流程和清理同时失败时聚合保留全部错误并继续清理", async () => {
  const events = [];
  const primaryError = new Error("阶段验证失败");
  const poolEndError = new Error("目标连接关闭失败");
  const dropError = new Error("临时数据库删除失败");
  const adminEndError = new Error("管理连接关闭失败");
  const databaseName = `ai_employee_rollback_test_${"b".repeat(32)}`;
  const adminPool = {
    async query(sql) {
      events.push(sql);
      if (sql.startsWith("DROP DATABASE")) throw dropError;
    },
    async end() {
      events.push("admin:end");
      throw adminEndError;
    },
  };
  const targetPool = {
    async end() {
      events.push("target:end");
      throw poolEndError;
    },
  };
  let pools = 0;

  await assert.rejects(
    withTemporaryRollbackDatabase({
      databaseUrl: "postgresql://postgres:test@localhost:5432/ai_employee_test",
      databaseName,
      createPool() {
        pools += 1;
        return pools === 1 ? adminPool : targetPool;
      },
      async operation() {
        events.push("operation");
        throw primaryError;
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [
        primaryError,
        poolEndError,
        dropError,
        adminEndError,
      ]);
      return true;
    },
  );
  assert.deepEqual(events, [
    `CREATE DATABASE "${databaseName}"`,
    "operation",
    "target:end",
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    "admin:end",
  ]);
});

test("主流程成功时清理失败仍让顶层失败并继续删除数据库", async () => {
  const events = [];
  const poolEndError = new Error("目标连接关闭失败");
  const databaseName = `ai_employee_rollback_test_${"c".repeat(32)}`;
  const adminPool = {
    async query(sql) {
      events.push(sql);
    },
    async end() {
      events.push("admin:end");
    },
  };
  const targetPool = {
    async end() {
      events.push("target:end");
      throw poolEndError;
    },
  };
  let pools = 0;

  await assert.rejects(
    withTemporaryRollbackDatabase({
      databaseUrl: "postgresql://postgres:test@localhost:5432/ai_employee_test",
      databaseName,
      createPool() {
        pools += 1;
        return pools === 1 ? adminPool : targetPool;
      },
      async operation() {
        events.push("operation");
        return { valid: true };
      },
    }),
    (error) => error === poolEndError,
  );
  assert.deepEqual(events, [
    `CREATE DATABASE "${databaseName}"`,
    "operation",
    "target:end",
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    "admin:end",
  ]);
});
