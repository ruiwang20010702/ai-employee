import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertServiceRollbackState,
  inspectServiceRollbackState,
} from "../src/rollback-state-guard.mjs";
import {
  previousReleaseSupportsCapabilityBudget,
  previousReleaseSupportsContinuation,
  previousReleaseSupportsHermesMemoryCandidates,
  verifyServiceRollbackState,
} from "../scripts/验证服务回退状态.mjs";

test("没有第017号结构时旧服务回退不受影响", async () => {
  const state = await inspectServiceRollbackState({
    async query() {
      return {
        rows: [{
          continuation_present: false,
          capability_budget_present: false,
        }],
      };
    },
  });
  assert.deepEqual(state, {
    compatible: true,
    activeContinuationTasks: 0,
    migrationPresent: false,
    capabilityBudgetMigrationPresent: false,
    hermesMemoryCandidateMigrationPresent: false,
    hermesMemoryCandidateRows: 0,
    targetSupportsContinuation: false,
    targetSupportsCapabilityBudget: false,
    targetSupportsHermesMemoryCandidates: false,
  });
  assert.equal(assertServiceRollbackState(state), state);
});

test("存在等待信息任务链时必须阻止旧服务回退", async () => {
  let calls = 0;
  const state = await inspectServiceRollbackState({
    async query() {
      calls += 1;
      return calls === 1
        ? { rows: [{
            continuation_present: true,
            capability_budget_present: false,
          }] }
        : { rows: [{ count: 2 }] };
    },
  });
  assert.deepEqual(state, {
    compatible: false,
    activeContinuationTasks: 2,
    migrationPresent: true,
    capabilityBudgetMigrationPresent: false,
    hermesMemoryCandidateMigrationPresent: false,
    hermesMemoryCandidateRows: 0,
    targetSupportsContinuation: false,
    targetSupportsCapabilityBudget: false,
    targetSupportsHermesMemoryCandidates: false,
  });
  assert.throws(
    () => assertServiceRollbackState(state),
    (error) =>
      error.code === "service_rollback_active_continuations" && error.count === 2,
  );
});

test("历史终态接续子任务不会永久阻断旧服务回退", async () => {
  let calls = 0;
  const state = await inspectServiceRollbackState({
    async query(sql) {
      calls += 1;
      if (calls === 1) {
        return { rows: [{
          continuation_present: true,
          capability_budget_present: false,
        }] };
      }
      assert.match(sql, /continuation_of_task_id IS NOT NULL/u);
      assert.match(sql, /status NOT IN/u);
      assert.match(sql, /'completed'/u);
      assert.match(sql, /'dead'/u);
      return { rows: [{ count: 0 }] };
    },
  });
  assert.deepEqual(state, {
    compatible: true,
    activeContinuationTasks: 0,
    migrationPresent: true,
    capabilityBudgetMigrationPresent: false,
    hermesMemoryCandidateMigrationPresent: false,
    hermesMemoryCandidateRows: 0,
    targetSupportsContinuation: false,
    targetSupportsCapabilityBudget: false,
    targetSupportsHermesMemoryCandidates: false,
  });
});

test("上一版本已支持第017号任务链时无需按旧服务规则拦截", async () => {
  let calls = 0;
  const state = await inspectServiceRollbackState({
    async query() {
      calls += 1;
      return { rows: [{
        continuation_present: true,
        capability_budget_present: false,
      }] };
    },
  }, { targetSupportsContinuation: true });
  assert.equal(calls, 1);
  assert.deepEqual(state, {
    compatible: true,
    activeContinuationTasks: 0,
    migrationPresent: true,
    capabilityBudgetMigrationPresent: false,
    hermesMemoryCandidateMigrationPresent: false,
    hermesMemoryCandidateRows: 0,
    targetSupportsContinuation: true,
    targetSupportsCapabilityBudget: false,
    targetSupportsHermesMemoryCandidates: false,
  });
});

test("数据库已应用第018号迁移时无条件拒绝不支持持久预算的目标服务", async () => {
  let calls = 0;
  const state = await inspectServiceRollbackState({
    async query() {
      calls += 1;
      return { rows: [{
        continuation_present: true,
        capability_budget_present: true,
      }] };
    },
  }, { targetSupportsContinuation: true });
  assert.equal(calls, 1);
  assert.deepEqual(state, {
    compatible: false,
    activeContinuationTasks: 0,
    migrationPresent: true,
    capabilityBudgetMigrationPresent: true,
    hermesMemoryCandidateMigrationPresent: false,
    hermesMemoryCandidateRows: 0,
    targetSupportsContinuation: true,
    targetSupportsCapabilityBudget: false,
    targetSupportsHermesMemoryCandidates: false,
  });
  assert.throws(
    () => assertServiceRollbackState(state),
    { code: "service_rollback_capability_budget_unsupported" },
  );
});

test("第024号候选表非空时阻止不支持隐私回收的旧服务", async () => {
  let calls = 0;
  const state = await inspectServiceRollbackState({
    async query() {
      calls += 1;
      return calls === 1
        ? { rows: [{
            continuation_present: true,
            capability_budget_present: true,
            hermes_memory_candidates_present: true,
          }] }
        : { rows: [{ count: 2 }] };
    },
  }, {
    targetSupportsContinuation: true,
    targetSupportsCapabilityBudget: true,
    targetSupportsHermesMemoryCandidates: false,
  });
  assert.equal(state.compatible, false);
  assert.equal(state.hermesMemoryCandidateRows, 2);
  assert.throws(
    () => assertServiceRollbackState(state),
    (error) =>
      error.code === "service_rollback_hermes_memory_candidates_present" &&
      error.count === 2,
  );
});

test("上一版本能力分别按第017号和第018号固定迁移文件判断", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rollback-state-target-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await previousReleaseSupportsContinuation(directory), false);
  assert.equal(await previousReleaseSupportsCapabilityBudget(directory), false);
  assert.equal(await previousReleaseSupportsHermesMemoryCandidates(directory), false);
  const migrations = join(directory, "db", "migrations");
  await mkdir(migrations, { recursive: true });
  await writeFile(join(migrations, "017_等待信息任务链.sql"), "SELECT 1;\n");
  assert.equal(await previousReleaseSupportsContinuation(directory), true);
  assert.equal(await previousReleaseSupportsCapabilityBudget(directory), false);
  await writeFile(join(migrations, "018_能力次数预算.sql"), "SELECT 1;\n");
  assert.equal(await previousReleaseSupportsContinuation(directory), true);
  assert.equal(await previousReleaseSupportsCapabilityBudget(directory), true);
  assert.equal(await previousReleaseSupportsHermesMemoryCandidates(directory), false);
  await writeFile(join(migrations, "024_Hermes个人记忆候选.sql"), "SELECT 1;\n");
  assert.equal(await previousReleaseSupportsHermesMemoryCandidates(directory), true);
});

test("上一版本含017但不含018时拒绝回退到已应用018的数据库", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rollback-state-target-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrations = join(directory, "db", "migrations");
  await mkdir(migrations, { recursive: true });
  await writeFile(join(migrations, "017_等待信息任务链.sql"), "SELECT 1;\n");
  const pool = {
    async query() {
      return { rows: [{
        continuation_present: true,
        capability_budget_present: true,
      }] };
    },
  };

  await assert.rejects(
    verifyServiceRollbackState({ config: {}, pool, previousRelease: directory }),
    { code: "service_rollback_capability_budget_unsupported" },
  );

  await writeFile(join(migrations, "018_能力次数预算.sql"), "SELECT 1;\n");
  assert.equal(
    (await verifyServiceRollbackState({
      config: {},
      pool,
      previousRelease: directory,
    }))
      .compatible,
    true,
  );
});
